package com.neurocapture.capturekit

import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.io.RandomAccessFile
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest

/**
 * Upload protocol client (DEV_PLAN §13.2), the Kotlin twin of `src/upload/protocol.ts`:
 * POST /sessions → POST /takes (plan) → PUT parts → POST files/{kind}/complete → POST takes/{id}/complete.
 * Resumes from the server's plan (parts already uploaded come back with their ETags), re-sends a
 * file the server rejected with `checksum_mismatch` (max 3 attempts), refreshes the access token
 * once on 401. Pure JVM: no Android APIs, so it is unit-tested against a fake server.
 */
interface Http {
    @Throws(IOException::class)
    fun request(url: String, method: String, headers: Map<String, String>, body: ByteArray?): HttpResult
}

class HttpResult(val status: Int, val etag: String?, val body: String)

class UploadError(val kind: Kind, message: String, val code: String? = null) : Exception(message) {
    enum class Kind { NETWORK, AUTH, PERMANENT }
}

data class Tokens(val access: String, val refresh: String)

/** The take's encrypted files as the server receives them. */
interface TakeFiles {
    val kinds: List<String>
    fun size(kind: String): Long
    fun sha256(kind: String): String
    fun read(kind: String, offset: Long, length: Int): ByteArray
    /** Plain JSON of quality.json / meta.json for the take record. */
    fun evidence(name: String): JSONObject?
}

data class UploadJob(
    val takeId: String,
    val clientSessionId: String,
    /** POST /sessions body (JSON string from the app). */
    val session: String,
    /** POST /takes body without session_id, files and key (JSON string from the app). */
    val take: String,
    val wrappedDataKey: String = "",
    val keyId: String = "",
    val serverSessionId: String? = null,
    val serverTakeId: String? = null,
) {
    fun toJson(): JSONObject = JSONObject().apply {
        put("takeId", takeId); put("clientSessionId", clientSessionId)
        put("session", session); put("take", take)
        put("wrappedDataKey", wrappedDataKey); put("keyId", keyId)
        put("serverSessionId", serverSessionId ?: JSONObject.NULL)
        put("serverTakeId", serverTakeId ?: JSONObject.NULL)
    }

    companion object {
        fun fromJson(o: JSONObject) = UploadJob(
            takeId = o.getString("takeId"),
            clientSessionId = o.getString("clientSessionId"),
            session = o.getString("session"),
            take = o.getString("take"),
            wrappedDataKey = o.optString("wrappedDataKey", ""),
            keyId = o.optString("keyId", ""),
            serverSessionId = o.optStringOrNull("serverSessionId"),
            serverTakeId = o.optStringOrNull("serverTakeId"),
        )
    }
}

internal fun JSONObject.optStringOrNull(key: String): String? =
    if (!has(key) || isNull(key)) null else getString(key)

class UploadClient(
    private val http: Http,
    private val endpoint: String,
    private var tokens: Tokens,
    private val onTokens: (Tokens) -> Unit,
) {
    private fun call(method: String, path: String, body: JSONObject? = null, retried: Boolean = false): JSONObject {
        val res = try {
            http.request(
                "$endpoint$path", method,
                mapOf("Authorization" to "Bearer ${tokens.access}", "Content-Type" to "application/json"),
                body?.toString()?.toByteArray(Charsets.UTF_8),
            )
        } catch (e: IOException) {
            throw UploadError(UploadError.Kind.NETWORK, e.javaClass.simpleName)
        }
        if (res.status == 401 && !retried) {
            refresh()
            return call(method, path, body, true)
        }
        if (res.status == 401) throw UploadError(UploadError.Kind.AUTH, "login_required")
        if (res.status >= 500) throw UploadError(UploadError.Kind.NETWORK, "server ${res.status}")
        val json = try { JSONObject(res.body.ifBlank { "{}" }) } catch (_: Exception) { JSONObject() }
        if (res.status >= 400) {
            val code = json.optJSONObject("detail")?.optStringOrNull("code")
            throw UploadError(UploadError.Kind.PERMANENT, "http ${res.status}", code)
        }
        return json
    }

    private fun refresh() {
        val res = try {
            http.request(
                "$endpoint/auth/refresh", "POST", mapOf("Content-Type" to "application/json"),
                JSONObject().put("refresh_token", tokens.refresh).toString().toByteArray(Charsets.UTF_8),
            )
        } catch (e: IOException) {
            throw UploadError(UploadError.Kind.NETWORK, e.javaClass.simpleName)
        }
        if (res.status != 200) throw UploadError(UploadError.Kind.AUTH, "login_required")
        val j = JSONObject(res.body)
        tokens = Tokens(j.getString("access_token"), j.getString("refresh_token"))
        onTokens(tokens)
    }

    /**
     * Upload one take; resumes from whatever the server already has. [onJob] is called as soon as
     * the server IDs are known so they survive a process kill. Returns the confirmation time.
     */
    fun run(
        start: UploadJob,
        files: TakeFiles,
        onJob: (UploadJob) -> Unit,
        onProgress: (sent: Long, total: Long) -> Unit,
    ): String {
        var job = start
        val total = files.kinds.sumOf { files.size(it) }
        if (job.serverSessionId == null) {
            val s = call("POST", "/sessions", JSONObject(job.session))
            job = job.copy(serverSessionId = s.getString("id"))
            onJob(job)
        }
        val take = JSONObject(job.take)
        for (name in listOf("quality", "meta"))
            if (!take.has(name)) take.put(name, files.evidence(name) ?: JSONObject())
        take.put("session_id", job.serverSessionId)
        take.put("wrapped_data_key", job.wrappedDataKey)
        take.put("key_id", job.keyId)
        take.put("files", JSONArray().apply {
            for (kind in files.kinds)
                put(JSONObject().put("kind", kind).put("size_bytes", files.size(kind)).put("sha256", files.sha256(kind)))
        })
        var plan = call("POST", "/takes", take)
        val takeId = plan.getString("take_id")
        if (job.serverTakeId != takeId) {
            job = job.copy(serverTakeId = takeId)
            onJob(job)
        }
        var sent = 0L
        for (kind in files.kinds) {
            var attempt = 1
            while (true) {
                val f = filePlan(plan, kind)
                if (f.getBoolean("verified")) {
                    sent += files.size(kind)
                    onProgress(sent, total)
                    break
                }
                val partSize = f.getLong("part_size")
                val etags = sortedMapOf<Int, String>()
                val uploaded = f.getJSONArray("uploaded_parts")
                for (i in 0 until uploaded.length()) {
                    val p = uploaded.getJSONObject(i)
                    etags[p.getInt("number")] = p.getString("etag")
                }
                var fileSent = minOf(uploaded.length() * partSize, files.size(kind))
                sent += fileSent
                val parts = f.getJSONArray("parts")
                for (i in 0 until parts.length()) {
                    val part = parts.getJSONObject(i)
                    val n = part.getInt("number")
                    val off = (n - 1) * partSize
                    val len = minOf(partSize, files.size(kind) - off).toInt()
                    val chunk = files.read(kind, off, len)
                    val res = try {
                        http.request(part.getString("url"), "PUT", emptyMap(), chunk)
                    } catch (e: IOException) {
                        throw UploadError(UploadError.Kind.NETWORK, e.javaClass.simpleName)
                    }
                    if (res.status != 200 || res.etag == null) throw UploadError(UploadError.Kind.NETWORK, "part ${res.status}")
                    etags[n] = res.etag.replace("\"", "")
                    sent += chunk.size
                    fileSent += chunk.size
                    onProgress(sent, total)
                }
                try {
                    plan = call("POST", "/takes/$takeId/files/$kind/complete", JSONObject().put("parts", JSONArray().apply {
                        for ((n, e) in etags) put(JSONObject().put("number", n).put("etag", e))
                    }))
                    break
                } catch (e: UploadError) {
                    if (e.code != "checksum_mismatch" || attempt >= 3) throw e
                    // Damaged in transit: the server started a fresh upload of this file; send it again.
                    sent -= fileSent
                    attempt++
                    plan = call("GET", "/takes/$takeId/upload")
                }
            }
        }
        val done = call("POST", "/takes/$takeId/complete")
        onProgress(total, total)
        return done.getString("confirmed_at")
    }

    /** POST alias of PATCH /sessions/{id}: HttpURLConnection cannot send PATCH. */
    fun closeSession(serverSessionId: String, body: String) {
        call("POST", "/sessions/$serverSessionId/close", JSONObject(body))
    }

    private fun filePlan(plan: JSONObject, kind: String): JSONObject {
        val files = plan.getJSONArray("files")
        for (i in 0 until files.length()) if (files.getJSONObject(i).getString("kind") == kind) return files.getJSONObject(i)
        throw UploadError(UploadError.Kind.PERMANENT, "file $kind missing from plan")
    }
}

/** java.net client with timeouts; plain http is refused outside debug builds by the network config. */
class UrlConnectionHttp(private val connectTimeoutMs: Int = 15_000, private val readTimeoutMs: Int = 60_000) : Http {
    override fun request(url: String, method: String, headers: Map<String, String>, body: ByteArray?): HttpResult {
        val c = URL(url).openConnection() as HttpURLConnection
        try {
            c.connectTimeout = connectTimeoutMs
            c.readTimeout = readTimeoutMs
            c.requestMethod = method
            headers.forEach { (k, v) -> c.setRequestProperty(k, v) }
            if (body != null) {
                c.doOutput = true
                c.setFixedLengthStreamingMode(body.size)
                c.outputStream.use { it.write(body) }
            }
            val status = c.responseCode
            val stream = if (status >= 400) c.errorStream else c.inputStream
            val text = stream?.use { it.readBytes().toString(Charsets.UTF_8) } ?: ""
            return HttpResult(status, c.getHeaderField("ETag"), text)
        } finally {
            c.disconnect()
        }
    }
}

/** A take directory's encrypted files (`<name>.enc`), uploaded as they are on disk. */
class VaultTakeFiles(private val vault: TakeVault, private val takeId: String) : TakeFiles {
    private val dir = vault.takeDir(takeId)
    private val byKind: Map<String, File> = KINDS.mapNotNull { (kind, name) ->
        File(dir, "$name.enc").takeIf { it.isFile }?.let { kind to it }
    }.toMap()
    private val hashes = HashMap<String, String>()

    override val kinds: List<String> = byKind.keys.toList()
    override fun size(kind: String) = byKind.getValue(kind).length()

    override fun sha256(kind: String): String = hashes.getOrPut(kind) {
        val md = MessageDigest.getInstance("SHA-256")
        byKind.getValue(kind).inputStream().use { input ->
            val buf = ByteArray(256 * 1024)
            while (true) {
                val n = input.read(buf)
                if (n < 0) break
                md.update(buf, 0, n)
            }
        }
        md.digest().joinToString("") { "%02x".format(it) }
    }

    override fun read(kind: String, offset: Long, length: Int): ByteArray =
        RandomAccessFile(byKind.getValue(kind), "r").use { f ->
            ByteArray(length).also { f.seek(offset); f.readFully(it) }
        }

    override fun evidence(name: String): JSONObject? =
        try { JSONObject(vault.readText(takeId, "$name.json")) } catch (_: Exception) { null }

    companion object {
        /** Upload kind → file name in the take directory (DEV_PLAN §13.1 take_files.kind). */
        val KINDS = listOf(
            "video" to "video.mp4", "frames" to "frames.bin", "landmarks" to "landmarks.bin",
            "sensors" to "sensors.bin", "quality" to "quality.json", "meta" to "meta.json",
        )
    }
}

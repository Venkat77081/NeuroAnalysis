package com.neurocapture.capturekit

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException
import java.security.KeyPairGenerator
import java.security.MessageDigest
import java.security.spec.MGF1ParameterSpec
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.spec.OAEPParameterSpec
import javax.crypto.spec.PSource

/** In-memory copy of the server's upload API (backend/app/api) for JVM tests. */
private class FakeServer(private val partSize: Int = 1000) : Http {
    var online = true
    var corruptNextPart = false
    /** Network drops after this many successful part PUTs (then stays offline). */
    var dropAfterParts = -1
    val log = ArrayList<String>()
    private var access = "at-1"
    private var refresh = "rt-1"
    var revoked = false
    private val sessions = HashMap<String, String>() // client id → server id
    val closed = HashSet<String>()
    private class F(val kind: String, val size: Int, val sha: String, var uploadId: Int, val parts: HashMap<Int, ByteArray> = HashMap(), var verified: Boolean = false)
    private class T(val id: String, val files: List<F>, var complete: Boolean = false)
    private val takes = HashMap<String, T>() // client take id → take
    private var puts = 0
    private var nextUpload = 1

    fun expireAccess() { access = "at-new-${log.size}" }

    private fun ok(o: Any, etag: String? = null) = HttpResult(200, etag, o.toString())
    private fun err(status: Int, code: String? = null) =
        HttpResult(status, null, JSONObject().put("detail", if (code != null) JSONObject().put("code", code) else "x").toString())

    private fun plan(t: T) = JSONObject().put("take_id", t.id).put("status", if (t.complete) "complete" else "pending").put("files", JSONArray().apply {
        for (f in t.files) {
            val total = maxOf(1, (f.size + partSize - 1) / partSize)
            put(JSONObject().put("kind", f.kind).put("part_size", partSize).put("parts_total", total).put("verified", f.verified)
                .put("parts", JSONArray().apply {
                    if (!f.verified) for (n in 1..total) if (n !in f.parts) put(JSONObject().put("number", n).put("url", "fake://part/${t.id}/${f.kind}/${f.uploadId}/$n"))
                })
                .put("uploaded_parts", JSONArray().apply {
                    if (!f.verified) for (n in f.parts.keys.sorted()) put(JSONObject().put("number", n).put("etag", "e$n"))
                }))
        }
    })

    override fun request(url: String, method: String, headers: Map<String, String>, body: ByteArray?): HttpResult {
        if (!online) throw IOException("offline")
        if (url.startsWith("fake://part/")) {
            val (_, takeId, kind, uploadId, n) = url.removePrefix("fake://").split("/")
            val f = takes.values.first { it.id == takeId }.files.first { it.kind == kind }
            if (f.uploadId != uploadId.toInt()) return err(404)
            val data = body!!.copyOf()
            if (corruptNextPart) { data[0] = (data[0] + 1).toByte(); corruptNextPart = false }
            f.parts[n.toInt()] = data
            if (dropAfterParts >= 0 && ++puts >= dropAfterParts) online = false
            return ok("{}", "\"e$n\"")
        }
        val path = url.removePrefix("fake://api")
        log.add("$method $path")
        if (path == "/auth/refresh") {
            val j = JSONObject(String(body!!))
            if (revoked || j.getString("refresh_token") != refresh) return err(401)
            access = "at-r${log.size}"; refresh = "rt-r${log.size}"
            return ok(JSONObject().put("access_token", access).put("refresh_token", refresh))
        }
        if (headers["Authorization"] != "Bearer $access") return err(401)
        val j = body?.let { JSONObject(String(it)) }
        return when {
            method == "POST" && path == "/sessions" -> {
                val id = sessions.getOrPut(j!!.getString("client_session_id")) { "S${sessions.size + 1}" }
                ok(JSONObject().put("id", id).put("client_session_id", j.getString("client_session_id")))
            }
            method == "POST" && path.matches(Regex("/sessions/[^/]+/close")) -> { closed.add(path.split("/")[2]); ok("{}") }
            method == "POST" && path == "/takes" -> {
                require(j!!.getString("wrapped_data_key").isNotEmpty())
                require(j.has("quality") && j.has("meta"))
                val files = j.getJSONArray("files")
                val t = takes.getOrPut(j.getString("client_take_id")) {
                    T("T${takes.size + 1}", (0 until files.length()).map { i ->
                        val f = files.getJSONObject(i)
                        F(f.getString("kind"), f.getInt("size_bytes"), f.getString("sha256"), nextUpload++)
                    })
                }
                ok(plan(t))
            }
            method == "GET" && path.endsWith("/upload") -> ok(plan(takes.values.first { it.id == path.split("/")[2] }))
            method == "POST" && path.contains("/files/") -> {
                val (_, _, tid, _, kind) = path.split("/")
                val t = takes.values.first { it.id == tid }
                val f = t.files.first { it.kind == kind }
                val all = f.parts.keys.sorted().flatMap { f.parts[it]!!.toList() }.toByteArray()
                if (all.size != f.size || sha(all) != f.sha) {
                    f.parts.clear(); f.uploadId = nextUpload++
                    return err(409, "checksum_mismatch")
                }
                f.verified = true
                ok(plan(t))
            }
            method == "POST" && path.endsWith("/complete") -> {
                val t = takes.values.first { it.id == path.split("/")[2] }
                if (t.files.any { !it.verified }) return err(409, "files_pending")
                t.complete = true
                ok(JSONObject().put("take_id", t.id).put("status", "complete").put("confirmed_at", "2026-11-14T10:00:00Z"))
            }
            else -> err(404)
        }
    }

    companion object {
        fun sha(b: ByteArray) = MessageDigest.getInstance("SHA-256").digest(b).joinToString("") { "%02x".format(it) }
    }
}

private class MapKv : Kv {
    val m = sortedMapOf<String, String>()
    override fun get(key: String) = m[key]
    override fun put(key: String, json: String) { m[key] = json }
    override fun delete(key: String) = m.remove(key) != null
    override fun keys(prefix: String) = m.keys.filter { it.startsWith(prefix) }
}

private class MemFiles(sizes: Map<String, Int>, seed: Int) : TakeFiles {
    val data = sizes.mapValues { (k, n) -> ByteArray(n) { i -> ((i * 7 + seed + k.length) and 0xff).toByte() } }
    override val kinds = sizes.keys.toList()
    override fun size(kind: String) = data.getValue(kind).size.toLong()
    override fun sha256(kind: String) = FakeServer.sha(data.getValue(kind))
    override fun read(kind: String, offset: Long, length: Int) = data.getValue(kind).copyOfRange(offset.toInt(), offset.toInt() + length)
    override fun evidence(name: String): JSONObject? = JSONObject().put("name", name)
}

class UploadQueueTest {
    private val keys = KeyPairGenerator.getInstance("RSA").apply { initialize(2048) }.generateKeyPair()
    private val pem = "-----BEGIN PUBLIC KEY-----\n" + Base64.getMimeEncoder().encodeToString(keys.public.encoded) + "\n-----END PUBLIC KEY-----\n"
    private var now = 1_000_000L
    private val files = mapOf("tk-a" to MemFiles(mapOf("video" to 5500, "quality" to 40), 1), "tk-b" to MemFiles(mapOf("video" to 2300, "meta" to 30), 2))
    private val deleted = ArrayList<String>()

    private fun settings(signedIn: Boolean = true, retentionHours: Double = 24.0) = UploadSettings(
        "fake://api", if (signedIn) "at-1" else null, if (signedIn) "rt-1" else null, "k1", pem, false, retentionHours,
    )

    private fun job(id: String) = UploadJob(id, "s-1", """{"client_session_id":"s-1"}""", """{"client_take_id":"$id","test_code":"FT"}""")

    private fun run(q: UploadQueue, srv: FakeServer) = q.runOnce(
        srv, { files[it] }, { _, p -> KeyWrap.wrap(ByteArray(100) { 3 }, p) }, { deleted.add(it); true },
    )

    @Test
    fun uploadsResumesAfterNetworkLossResendsCorruptedFileClosesSessionAndAppliesRetention() {
        val srv = FakeServer()
        val events = ArrayList<String>()
        val kv = MapKv()
        val q = UploadQueue(kv, { now }) { events.add("${it.job.takeId}:${it.state}") }
        q.enqueue(job("tk-a"), 5540)
        q.enqueue(job("tk-a"), 5540) // idempotent
        q.enqueueClose("s-1", """{"ended_at":"2026-11-14T10:20:00Z"}""")
        // Not signed in: waits for login.
        run(q, srv)
        assertEquals(UploadQueue.LOGIN_REQUIRED, q.record("tk-a")!!.reason)
        q.configure(settings())
        assertEquals(UploadRecord.QUEUED, q.record("tk-a")!!.state)
        // Network drops after 2 parts.
        srv.dropAfterParts = 2
        assertTrue(run(q, srv).retry)
        val mid = q.record("tk-a")!!
        assertEquals(UploadRecord.FAILED_RETRYABLE, mid.state)
        assertEquals(2000L, mid.bytesSent)
        assertEquals("T1", mid.job.serverTakeId) // saved before the drop: survives a process kill
        // A fresh queue over the same storage (process restart) resumes.
        srv.online = true; srv.dropAfterParts = -1
        val q2 = UploadQueue(kv, { now })
        q2.enqueue(job("tk-b"), 2330)
        srv.corruptNextPart = true
        assertFalse(run(q2, srv).retry)
        assertEquals(listOf(UploadRecord.COMPLETED, UploadRecord.COMPLETED), q2.records().map { it.state })
        assertEquals(1, srv.log.count { it == "POST /sessions" })
        assertTrue(srv.closed.contains("S1"))
        assertTrue(events.contains("tk-a:failed_retryable"))
        assertEquals(5540L, q2.record("tk-a")!!.bytesSent)
        // Retention: kept until 24 h after confirmation, then deleted with the key.
        assertEquals(now + 24 * 3_600_000L, q2.applyRetention { deleted.add(it); true })
        now += 24 * 3_600_000L
        assertEquals(null, q2.applyRetention { deleted.add(it); true })
        assertEquals(listOf("tk-a", "tk-b"), deleted)
        assertTrue(q2.record("tk-a")!!.localDeleted)
        assertTrue(q2.record("tk-a")!!.status().getBoolean("localDeleted"))
    }

    @Test
    fun refreshesOnceThenPausesForLoginAndKeepsTokensWhenSettingsChange() {
        val srv = FakeServer()
        val q = UploadQueue(MapKv(), { now })
        q.configure(settings())
        srv.expireAccess()
        q.enqueue(job("tk-a"), 5540)
        run(q, srv)
        assertEquals(UploadRecord.COMPLETED, q.record("tk-a")!!.state)
        val rotated = q.settings()!!
        assertTrue(rotated.accessToken!!.startsWith("at-r"))
        // Settings change without tokens keeps the rotated pair.
        q.configure(settings(signedIn = false).copy(wifiOnly = true))
        assertEquals(rotated.refreshToken, q.settings()!!.refreshToken)
        assertTrue(q.settings()!!.wifiOnly)
        srv.expireAccess(); srv.revoked = true
        q.enqueue(job("tk-b"), 2330)
        assertFalse(run(q, srv).retry)
        assertEquals(UploadQueue.LOGIN_REQUIRED, q.record("tk-b")!!.reason)
        q.clearCredentials()
        assertFalse(q.settings()!!.signedIn)
    }

    @Test
    fun retryAndWaitingStatesAndMissingFiles() {
        val srv = FakeServer()
        val q = UploadQueue(MapKv(), { now })
        q.configure(settings())
        q.enqueue(job("tk-a"), 1)
        q.enqueue(job("tk-zz"), 1) // no files on disk
        q.markWaiting(UploadQueue.WIFI_REQUIRED)
        assertEquals(UploadQueue.WIFI_REQUIRED, q.record("tk-a")!!.reason)
        srv.online = false
        run(q, srv)
        assertEquals(UploadRecord.FAILED_RETRYABLE, q.record("tk-a")!!.state)
        assertEquals("files_missing", q.record("tk-zz")!!.reason)
        q.retry()
        assertEquals(UploadRecord.QUEUED, q.record("tk-a")!!.state)
        assertEquals(UploadRecord.FAILED_PERMANENT, q.record("tk-zz")!!.state)
        assertTrue(q.pending())
        assertEquals(30_000L, q.backoffMs(1))
        assertEquals(24 * 3_600_000L, q.backoffMs(30))
    }

    @Test
    fun keyWrapIsRsaOaepSha256() {
        val secret = ByteArray(120) { it.toByte() }
        val wrapped = Base64.getDecoder().decode(KeyWrap.wrap(secret, pem))
        val c = Cipher.getInstance("RSA/ECB/OAEPPadding")
        c.init(Cipher.DECRYPT_MODE, keys.private, OAEPParameterSpec("SHA-256", "MGF1", MGF1ParameterSpec.SHA256, PSource.PSpecified.DEFAULT))
        assertTrue(secret.contentEquals(c.doFinal(wrapped)))
        assertNotNull(KeyWrap.publicKey(pem))
    }
}

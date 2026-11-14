package com.neurocapture.capturekit

import org.json.JSONObject

/** Key–value persistence for the queue (SecureStore on a device, a map in tests). */
interface Kv {
    fun get(key: String): String?
    fun put(key: String, json: String)
    fun delete(key: String): Boolean
    fun keys(prefix: String): List<String>
}

data class UploadSettings(
    val endpoint: String,
    val accessToken: String?,
    val refreshToken: String?,
    val serverKeyId: String,
    val serverPublicKeyPem: String,
    val wifiOnly: Boolean,
    val retentionHours: Double,
) {
    fun toJson(): JSONObject = JSONObject().apply {
        put("endpoint", endpoint)
        put("accessToken", accessToken ?: JSONObject.NULL); put("refreshToken", refreshToken ?: JSONObject.NULL)
        put("serverKeyId", serverKeyId); put("serverPublicKeyPem", serverPublicKeyPem)
        put("wifiOnly", wifiOnly); put("retentionHours", retentionHours)
    }

    val signedIn get() = accessToken != null && refreshToken != null

    companion object {
        fun fromJson(o: JSONObject) = UploadSettings(
            o.getString("endpoint"), o.optStringOrNull("accessToken"), o.optStringOrNull("refreshToken"),
            o.getString("serverKeyId"), o.getString("serverPublicKeyPem"),
            o.optBoolean("wifiOnly", true), o.optDouble("retentionHours", 24.0),
        )
    }
}

/** One take's place in the queue; mirrors the JS `UploadStatus`. */
data class UploadRecord(
    val job: UploadJob,
    val state: String = QUEUED,
    val bytesSent: Long = 0,
    val bytesTotal: Long = 0,
    val reason: String? = null,
    val confirmedAt: String? = null,
    val confirmedAtMs: Long? = null,
    val localDeleted: Boolean = false,
    val attempts: Int = 0,
) {
    fun toJson(): JSONObject = JSONObject().apply {
        put("job", job.toJson()); put("state", state); put("bytesSent", bytesSent); put("bytesTotal", bytesTotal)
        put("reason", reason ?: JSONObject.NULL); put("confirmedAt", confirmedAt ?: JSONObject.NULL)
        put("confirmedAtMs", confirmedAtMs ?: JSONObject.NULL); put("localDeleted", localDeleted); put("attempts", attempts)
    }

    /** The JS-facing status (no job bodies, no keys). */
    fun status(): JSONObject = JSONObject().apply {
        put("takeId", job.takeId); put("state", state); put("bytesSent", bytesSent); put("bytesTotal", bytesTotal)
        if (reason != null) put("reason", reason)
        if (confirmedAt != null) put("confirmedAt", confirmedAt)
        if (localDeleted) put("localDeleted", true)
    }

    companion object {
        const val QUEUED = "queued"
        const val UPLOADING = "uploading"
        const val PAUSED = "paused"
        const val FAILED_RETRYABLE = "failed_retryable"
        const val FAILED_PERMANENT = "failed_permanent"
        const val COMPLETED = "completed"

        fun fromJson(o: JSONObject) = UploadRecord(
            UploadJob.fromJson(o.getJSONObject("job")), o.getString("state"), o.optLong("bytesSent"), o.optLong("bytesTotal"),
            o.optStringOrNull("reason"), o.optStringOrNull("confirmedAt"),
            if (o.isNull("confirmedAtMs")) null else o.optLong("confirmedAtMs"),
            o.optBoolean("localDeleted"), o.optInt("attempts"),
        )
    }
}

/**
 * Persistent upload queue (DEV_PLAN §5.3, §15). Every state change is saved before it is reported,
 * so a process kill or reboot resumes where it stopped; the server plan makes resends idempotent.
 * No Android APIs: the WorkManager worker calls [runOnce], tests call it directly.
 */
class UploadQueue(
    private val kv: Kv,
    private val clock: () -> Long = System::currentTimeMillis,
    private val emit: (UploadRecord) -> Unit = {},
) {
    private val lock = Any()

    fun settings(): UploadSettings? = kv.get(CONFIG)?.let { UploadSettings.fromJson(JSONObject(it)) }

    /** Saves settings; tokens left out keep the ones already stored (the plugin rotates them). */
    fun configure(s: UploadSettings) = synchronized(lock) {
        val old = settings()
        val merged = if (s.signedIn) s else s.copy(accessToken = old?.accessToken, refreshToken = old?.refreshToken)
        kv.put(CONFIG, merged.toJson().toString())
        if (merged.signedIn)
            records().filter { it.reason == LOGIN_REQUIRED }.forEach { save(it.copy(state = UploadRecord.QUEUED, reason = null)) }
    }

    fun clearCredentials() = synchronized(lock) {
        settings()?.let { kv.put(CONFIG, it.copy(accessToken = null, refreshToken = null).toJson().toString()) }
        Unit
    }

    private fun saveTokens(t: Tokens) = synchronized(lock) {
        settings()?.let { kv.put(CONFIG, it.copy(accessToken = t.access, refreshToken = t.refresh).toJson().toString()) }
        Unit
    }

    /** Idempotent: a take already queued keeps its record. */
    fun enqueue(job: UploadJob, bytesTotal: Long) = synchronized(lock) {
        if (record(job.takeId) == null) save(UploadRecord(job, bytesTotal = bytesTotal))
    }

    fun enqueueClose(clientSessionId: String, body: String) = synchronized(lock) {
        kv.put(closeKey(clientSessionId), JSONObject().put("clientSessionId", clientSessionId).put("body", body).toString())
    }

    fun record(takeId: String): UploadRecord? = kv.get(jobKey(takeId))?.let { UploadRecord.fromJson(JSONObject(it)) }

    fun records(): List<UploadRecord> = kv.keys(JOB_PREFIX).mapNotNull { k ->
        kv.get(k)?.let { UploadRecord.fromJson(JSONObject(it)) }
    }.sortedBy { it.job.takeId }

    /** Operator asked to retry: failed and network-paused takes go back to the queue now. */
    fun retry() = synchronized(lock) {
        records().filter {
            it.state == UploadRecord.FAILED_RETRYABLE || (it.state == UploadRecord.PAUSED && it.reason != LOGIN_REQUIRED)
        }.forEach { save(it.copy(state = UploadRecord.QUEUED, reason = null)) }
    }

    /** Marks waiting takes (e.g. "wifi_required") without touching completed or failed ones. */
    fun markWaiting(reason: String) = synchronized(lock) {
        records().filter { it.state == UploadRecord.QUEUED || it.state == UploadRecord.FAILED_RETRYABLE }
            .forEach { save(it.copy(state = UploadRecord.PAUSED, reason = reason)) }
    }

    fun pending(): Boolean = records().any { it.state != UploadRecord.COMPLETED && it.state != UploadRecord.FAILED_PERMANENT }

    class RunResult(val retry: Boolean, val nextRetentionAtMs: Long?)

    /**
     * Uploads every waiting take, then closes sessions whose takes are all confirmed, then applies
     * retention. [files] gives a take's encrypted files; [wrapKey] wraps its data key for the server.
     */
    fun runOnce(
        http: Http,
        files: (takeId: String) -> TakeFiles?,
        wrapKey: (takeId: String, pem: String) -> String,
        deleteTake: (takeId: String) -> Boolean,
    ): RunResult {
        var retry = false
        val cfg = settings()
        for (r0 in records()) {
            if (r0.state == UploadRecord.COMPLETED || r0.state == UploadRecord.FAILED_PERMANENT) continue
            if (cfg == null || !cfg.signedIn) {
                save(r0.copy(state = UploadRecord.PAUSED, reason = LOGIN_REQUIRED))
                continue
            }
            val takeFiles = files(r0.job.takeId)
            if (takeFiles == null || takeFiles.kinds.isEmpty()) {
                save(r0.copy(state = UploadRecord.FAILED_PERMANENT, reason = "files_missing"))
                continue
            }
            var r = r0.copy(state = UploadRecord.UPLOADING, reason = null, bytesTotal = takeFiles.kinds.sumOf { takeFiles.size(it) })
            if (r.job.serverSessionId == null) {
                // Another take of the same session already created it on the server.
                val known = records().firstNotNullOfOrNull { o ->
                    o.job.serverSessionId.takeIf { o.job.clientSessionId == r.job.clientSessionId }
                }
                if (known != null) r = r.copy(job = r.job.copy(serverSessionId = known))
            }
            if (r.job.wrappedDataKey.isEmpty() || r.job.keyId != cfg.serverKeyId) {
                // Wrapped at upload time with the current server key (key rotation, §14).
                val wrapped = try { wrapKey(r.job.takeId, cfg.serverPublicKeyPem) } catch (_: Exception) { null }
                if (wrapped == null) {
                    save(r.copy(state = UploadRecord.FAILED_PERMANENT, reason = "key_wrap_failed"))
                    continue
                }
                r = r.copy(job = r.job.copy(wrappedDataKey = wrapped, keyId = cfg.serverKeyId))
            }
            save(r)
            val client = UploadClient(http, cfg.endpoint, Tokens(cfg.accessToken!!, cfg.refreshToken!!), ::saveTokens)
            try {
                val confirmedAt = client.run(
                    r.job, takeFiles,
                    onJob = { j -> r = r.copy(job = j); save(r) },
                    onProgress = { sent, total -> r = r.copy(bytesSent = sent, bytesTotal = total); save(r) },
                )
                save(r.copy(state = UploadRecord.COMPLETED, confirmedAt = confirmedAt, confirmedAtMs = clock(), attempts = 0))
            } catch (e: UploadError) {
                when (e.kind) {
                    UploadError.Kind.AUTH -> save(r.copy(state = UploadRecord.PAUSED, reason = LOGIN_REQUIRED))
                    UploadError.Kind.PERMANENT -> save(r.copy(state = UploadRecord.FAILED_PERMANENT, reason = e.code ?: e.message))
                    UploadError.Kind.NETWORK -> {
                        save(r.copy(state = UploadRecord.FAILED_RETRYABLE, reason = "network", attempts = r.attempts + 1))
                        retry = true
                    }
                }
            } catch (e: Exception) {
                // Local read errors (e.g. storage) are retried; they never touch the files.
                save(r.copy(state = UploadRecord.FAILED_RETRYABLE, reason = "local_error", attempts = r.attempts + 1))
                retry = true
            }
        }
        if (cfg != null && cfg.signedIn) retry = closeSessions(http, cfg) || retry
        return RunResult(retry, applyRetention(deleteTake))
    }

    private fun closeSessions(http: Http, cfg: UploadSettings): Boolean {
        var retry = false
        val all = records()
        for (key in kv.keys(CLOSE_PREFIX)) {
            val c = JSONObject(kv.get(key) ?: continue)
            val mine = all.filter { it.job.clientSessionId == c.getString("clientSessionId") }
            val sid = mine.firstNotNullOfOrNull { it.job.serverSessionId }
            if (sid == null || mine.any { it.state != UploadRecord.COMPLETED }) continue
            try {
                UploadClient(http, cfg.endpoint, Tokens(cfg.accessToken!!, cfg.refreshToken!!), ::saveTokens)
                    .closeSession(sid, c.getString("body"))
                kv.delete(key)
            } catch (e: UploadError) {
                if (e.kind == UploadError.Kind.PERMANENT) kv.delete(key) else retry = true
            }
        }
        return retry
    }

    /**
     * Deletes local copies (and with them the data keys) of confirmed takes once the retention time
     * has passed. Returns when the next deletion is due, or null when none is waiting.
     */
    fun applyRetention(deleteTake: (takeId: String) -> Boolean): Long? = synchronized(lock) {
        val hours = settings()?.retentionHours ?: return@synchronized null
        var next: Long? = null
        for (r in records()) {
            if (r.state != UploadRecord.COMPLETED || r.localDeleted || r.confirmedAtMs == null) continue
            val due = r.confirmedAtMs + (hours * 3_600_000).toLong()
            if (clock() >= due) {
                deleteTake(r.job.takeId)
                save(r.copy(localDeleted = true))
            } else next = minOf(next ?: due, due)
        }
        next
    }

    /** Backoff for WorkManager-less callers: 30 s doubling, capped at 24 h (§15). */
    fun backoffMs(attempts: Int): Long =
        minOf(30_000L shl (attempts - 1).coerceIn(0, 20), 24 * 3_600_000L)

    private fun save(r: UploadRecord) {
        synchronized(lock) { kv.put(jobKey(r.job.takeId), r.toJson().toString()) }
        emit(r)
    }

    companion object {
        const val LOGIN_REQUIRED = "login_required"
        const val WIFI_REQUIRED = "wifi_required"
        private const val CONFIG = "upload.config"
        private const val JOB_PREFIX = "upload.job."
        private const val CLOSE_PREFIX = "upload.close."
        /** SecureStore keys are lower case; IDs are hex/ASCII so this stays unique in practice. */
        private fun jobKey(takeId: String) = JOB_PREFIX + takeId.lowercase()
        private fun closeKey(sid: String) = CLOSE_PREFIX + sid.lowercase()
    }
}

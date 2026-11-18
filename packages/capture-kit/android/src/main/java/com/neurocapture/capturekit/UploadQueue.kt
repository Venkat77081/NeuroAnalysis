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
    val refreshPath: String = "/auth/refresh",
) {
    fun toJson(): JSONObject = JSONObject().apply {
        put("endpoint", endpoint)
        put("accessToken", accessToken ?: JSONObject.NULL); put("refreshToken", refreshToken ?: JSONObject.NULL)
        put("serverKeyId", serverKeyId); put("serverPublicKeyPem", serverPublicKeyPem)
        put("wifiOnly", wifiOnly); put("retentionHours", retentionHours); put("refreshPath", refreshPath)
    }

    val signedIn get() = accessToken != null && refreshToken != null

    companion object {
        fun fromJson(o: JSONObject) = UploadSettings(
            o.getString("endpoint"), o.optStringOrNull("accessToken"), o.optStringOrNull("refreshToken"),
            o.getString("serverKeyId"), o.getString("serverPublicKeyPem"),
            o.optBoolean("wifiOnly", true), o.optDouble("retentionHours", 24.0),
            o.optString("refreshPath", "/auth/refresh"),
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
        put("profile", job.profile)
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

    /**
     * v3: settings of one upload profile. A patient who joined several hospitals has one profile per
     * hospital (its own tokens, NCID and take key); a clinic phone uses [DEFAULT_PROFILE] only.
     */
    fun settings(profile: String = DEFAULT_PROFILE): UploadSettings? =
        kv.get(configKey(profile))?.let { UploadSettings.fromJson(JSONObject(it)) }

    /** Every profile that has settings (default first). */
    fun profiles(): List<String> =
        kv.keys(CONFIG).map { if (it == CONFIG) DEFAULT_PROFILE else it.removePrefix("$CONFIG.") }
            .sortedBy { if (it == DEFAULT_PROFILE) "" else it }

    /** Saves settings; tokens left out keep the ones already stored (the plugin rotates them). */
    fun configure(s: UploadSettings, profile: String = DEFAULT_PROFILE) = synchronized(lock) {
        requireProfile(profile)
        val old = settings(profile)
        val merged = if (s.signedIn) s else s.copy(accessToken = old?.accessToken, refreshToken = old?.refreshToken)
        kv.put(configKey(profile), merged.toJson().toString())
        if (merged.signedIn)
            records().filter { it.job.profile == profile && it.reason == LOGIN_REQUIRED }
                .forEach { save(it.copy(state = UploadRecord.QUEUED, reason = null)) }
    }

    /** M13: a signed-in call for the app, only to [API_PATHS]. Throws [UploadError]. */
    fun api(http: Http, method: String, path: String, body: String?, profile: String = DEFAULT_PROFILE): String {
        require(method == "GET" || method == "POST") { "method" }
        require(API_PATHS.matches(path)) { "path not allowed" }
        requireProfile(profile)
        val cfg = settings(profile)
        if (cfg == null || !cfg.signedIn) throw UploadError(UploadError.Kind.AUTH, "login_required")
        return client(http, cfg, profile).api(method, path, body)
    }

    private fun client(http: Http, cfg: UploadSettings, profile: String) =
        UploadClient(http, cfg.endpoint, Tokens(cfg.accessToken!!, cfg.refreshToken!!), { t -> saveTokens(t, profile) }, cfg.refreshPath)

    /** resetDevice: forget the server, every queued upload, close and crash report. */
    fun clearAll() = synchronized(lock) {
        kv.keys("").forEach { kv.delete(it) }
    }

    fun clearCredentials(profile: String = DEFAULT_PROFILE) = synchronized(lock) {
        requireProfile(profile)
        settings(profile)?.let { kv.put(configKey(profile), it.copy(accessToken = null, refreshToken = null).toJson().toString()) }
        Unit
    }

    private fun saveTokens(t: Tokens, profile: String) = synchronized(lock) {
        settings(profile)?.let {
            kv.put(configKey(profile), it.copy(accessToken = t.access, refreshToken = t.refresh).toJson().toString())
        }
        Unit
    }

    /** Idempotent: a take already queued keeps its record. */
    fun enqueue(job: UploadJob, bytesTotal: Long) = synchronized(lock) {
        requireProfile(job.profile)
        if (record(job.takeId) == null) save(UploadRecord(job, bytesTotal = bytesTotal))
    }

    /** M9: a redacted crash report, sent once an operator is signed in. */
    fun enqueueDiagnostic(body: String) = synchronized(lock) {
        kv.put(DIAG_PREFIX + "${clock()}-${(1000..9999).random()}", JSONObject().put("body", body).toString())
    }

    fun enqueueClose(clientSessionId: String, body: String) = synchronized(lock) {
        kv.put(closeKey(clientSessionId), JSONObject().put("clientSessionId", clientSessionId).put("body", body).toString())
        Unit
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

    fun pending(): Boolean =
        records().any { it.state != UploadRecord.COMPLETED && it.state != UploadRecord.FAILED_PERMANENT } ||
            kv.keys(DIAG_PREFIX).isNotEmpty()

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
        val cfgs = profiles().associateWith { settings(it) }
        for (r0 in records()) {
            if (r0.state == UploadRecord.COMPLETED || r0.state == UploadRecord.FAILED_PERMANENT) continue
            val cfg = cfgs[r0.job.profile]
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
                val known = records().firstOrNull { o ->
                    o.job.serverSessionId != null && o.job.clientSessionId == r.job.clientSessionId &&
                        o.job.profile == r.job.profile
                }?.job
                if (known != null)
                    r = r.copy(job = r.job.copy(
                        serverSessionId = known.serverSessionId,
                        sessionKeyId = known.sessionKeyId,
                        sessionKeyPem = known.sessionKeyPem,
                    ))
            }
            if (r.job.sessionKeyId.isNullOrEmpty() && (r.job.wrappedDataKey.isEmpty() || r.job.keyId != cfg.serverKeyId)) {
                // Pre-M12 servers: wrapped with the configured server key. From M12 the upload client
                // re-wraps with the hospital key the server gives the session.
                val wrapped = try { wrapKey(r.job.takeId, cfg.serverPublicKeyPem) } catch (_: Exception) { null }
                if (wrapped == null) {
                    save(r.copy(state = UploadRecord.FAILED_PERMANENT, reason = "key_wrap_failed"))
                    continue
                }
                r = r.copy(job = r.job.copy(wrappedDataKey = wrapped, keyId = cfg.serverKeyId))
            }
            save(r)
            val client = client(http, cfg, r.job.profile)
            try {
                val confirmedAt = client.run(
                    r.job, takeFiles,
                    onJob = { j -> r = r.copy(job = j); save(r) },
                    onProgress = { sent, total -> r = r.copy(bytesSent = sent, bytesTotal = total); save(r) },
                    wrapKey = { pem -> wrapKey(r.job.takeId, pem) },
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
        retry = closeSessions(http, cfgs) || retry
        // Crash reports go with the first signed-in profile (they carry no patient data).
        cfgs.entries.firstOrNull { it.value?.signedIn == true }?.let { (profile, cfg) ->
            retry = sendDiagnostics(http, cfg!!, profile) || retry
        }
        return RunResult(retry, applyRetention(deleteTake))
    }

    private fun closeSessions(http: Http, cfgs: Map<String, UploadSettings?>): Boolean {
        var retry = false
        val all = records()
        for (key in kv.keys(CLOSE_PREFIX)) {
            val c = JSONObject(kv.get(key) ?: continue)
            val mine = all.filter { it.job.clientSessionId == c.getString("clientSessionId") }
            val sid = mine.firstNotNullOfOrNull { it.job.serverSessionId }
            if (sid == null || mine.any { it.state != UploadRecord.COMPLETED }) continue
            val profile = mine.first().job.profile
            val cfg = cfgs[profile]?.takeIf { it.signedIn } ?: continue
            try {
                client(http, cfg, profile).closeSession(sid, c.getString("body"))
                kv.delete(key)
            } catch (e: UploadError) {
                if (e.kind == UploadError.Kind.PERMANENT) kv.delete(key) else retry = true
            }
        }
        return retry
    }

    private fun sendDiagnostics(http: Http, cfg: UploadSettings, profile: String): Boolean {
        for (key in kv.keys(DIAG_PREFIX)) {
            val body = kv.get(key)?.let { JSONObject(it).getString("body") } ?: continue
            try {
                client(http, cfg, profile).sendDiagnostic(body)
                kv.delete(key)
            } catch (e: UploadError) {
                if (e.kind == UploadError.Kind.PERMANENT) kv.delete(key) else return true
            }
        }
        return false
    }

    /**
     * Deletes local copies (and with them the data keys) of confirmed takes once the retention time
     * has passed. Returns when the next deletion is due, or null when none is waiting.
     */
    fun applyRetention(deleteTake: (takeId: String) -> Boolean): Long? = synchronized(lock) {
        val hoursBy = profiles().associateWith { settings(it)?.retentionHours }
        var next: Long? = null
        for (r in records()) {
            if (r.state != UploadRecord.COMPLETED || r.localDeleted || r.confirmedAtMs == null) continue
            val hours = hoursBy[r.job.profile] ?: continue
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
        /** Paths the app may call through [api] (M13); nothing that uploads or changes takes. */
        val API_PATHS = Regex(
            "^/(patient/(plan|sessions|me|requests|consent/withdraw|pin/clear)|auth/(connector-token|change-password)" +
                // Decision 044: may this hospital record (its own storage connected)?
                "|sessions/can-record" +
                // v13: the patient's appointments and asking to change one.
                "|patient/appointments|patient/appointments/[A-Za-z0-9]{1,40}/change-request" +
                "|patient/change-requests/[A-Za-z0-9]{1,40}/withdraw" +
                // v14: offers, cancelling, booking from the app, free times.
                "|patient/appointments/[A-Za-z0-9]{1,40}/cancel|patient/bookings|patient/doctors" +
                "|patient/free-times\\?[A-Za-z0-9=&%:._-]{1,200}" +
                "|patient/offers/[A-Za-z0-9]{1,40}/(choose|keep|call|decline)" +
                // v16: clinic consent in the app (QR) and on the clinic phone.
                "|patient/requests/[A-Za-z0-9]{1,40}/clinic-consent(/withdraw)?" +
                "|clinic/requests/[A-Za-z0-9]{1,40}/(consent-scan|consent-on-phone)" +
                // Clinic phones (user, 16 Nov 2026): the day's clinic queue and "not recorded".
                "|clinic/queue\\?[A-Za-z0-9=&%:.+_-]{1,200}|clinic/requests/[A-Za-z0-9]{1,40}/not-done)$"
        )
        const val DEFAULT_PROFILE = "default"
        private val PROFILE = Regex("^[a-z0-9][a-z0-9_-]{0,39}$")
        fun requireProfile(p: String) = require(PROFILE.matches(p)) { "invalid profile" }
        const val LOGIN_REQUIRED = "login_required"
        const val WIFI_REQUIRED = "wifi_required"
        private const val CONFIG = "upload.config"
        private const val JOB_PREFIX = "upload.job."
        private const val CLOSE_PREFIX = "upload.close."
        private const val DIAG_PREFIX = "upload.diag."
        /** SecureStore keys are lower case; IDs are hex/ASCII so this stays unique in practice. */
        private fun configKey(profile: String) = if (profile == DEFAULT_PROFILE) CONFIG else "$CONFIG.$profile"
        private fun jobKey(takeId: String) = JOB_PREFIX + takeId.lowercase()
        private fun closeKey(sid: String) = CLOSE_PREFIX + sid.lowercase()
    }
}

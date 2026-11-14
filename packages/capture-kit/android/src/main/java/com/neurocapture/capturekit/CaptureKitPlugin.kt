package com.neurocapture.capturekit

import android.Manifest
import com.getcapacitor.JSObject
import com.getcapacitor.PermissionState
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback
import java.io.File
import java.util.concurrent.Executors

/**
 * CaptureKit Capacitor plugin (DEV_PLAN §5.3). Capabilities, camera + preview, fixed-duration
 * recording with per-frame timestamps and sensors, encrypted takes (Tink, Keystore-wrapped keys),
 * evidence, playback, crash recovery, sharpness calibration and the qualification benchmark.
 * Background upload (M7) runs in [UploadWorker] through the persistent [UploadQueue].
 */
@CapacitorPlugin(
    name = "CaptureKit",
    permissions = [Permission(alias = "camera", strings = [Manifest.permission.CAMERA])],
)
class CaptureKitPlugin : Plugin() {
    private lateinit var session: CameraSession
    private var benchmark: Benchmark? = null
    private var pendingStop: PluginCall? = null
    private lateinit var vault: TakeVault
    private lateinit var store: SecureStore
    private lateinit var uploads: UploadQueue
    private val io = Executors.newSingleThreadExecutor { Thread(it, "nc-vault") }
    @Volatile private var recovered: List<String> = emptyList()

    override fun load() {
        session = CameraSession(activity, bridge.webView) { event, data -> notifyListeners(event, data) }
        vault = Services.vault(context)
        store = Services.store(context)
        uploads = Services.queue(context)
        // Upload progress from the background worker reaches JS while the plugin is loaded.
        Services.uploadListener = { status -> notifyListeners("uploadProgress", JSObject(status.toString())) }
        io.execute {
            playbackDir().deleteRecursively() // decrypted playback copies never survive a restart
            recovered = try { vault.recover() } catch (_: Exception) { emptyList() }
            // Pending uploads continue (WorkManager also restarts them after a reboot).
            if (uploads.pending()) Services.kickUploads(context)
        }
    }

    private fun takesDir() = File(context.noBackupFilesDir, "takes")
    private fun playbackDir() = File(context.cacheDir, "playback")

    private fun withCamera(call: PluginCall, then: () -> Unit) {
        if (getPermissionState("camera") == PermissionState.GRANTED) then()
        else requestPermissionForAlias("camera", call, "cameraPermsCallback")
    }

    @PermissionCallback
    private fun cameraPermsCallback(call: PluginCall) {
        if (getPermissionState("camera") != PermissionState.GRANTED) {
            call.reject("Camera permission denied", "PERMISSION_DENIED")
            return
        }
        when (call.methodName) {
            "openCamera" -> doOpen(call)
            "runQualificationBenchmark" -> doBenchmark(call)
            else -> call.reject("unexpected permission callback for ${call.methodName}")
        }
    }

    @PluginMethod
    fun getCapabilities(call: PluginCall) {
        try {
            call.resolve(DeviceInfo.capabilities(context, PLUGIN_VERSION).apply {
                session.trackingGpu?.let { put("gpuDelegate", it) }
            })
        } catch (e: Exception) {
            call.reject("capabilities failed: ${e.message}", e)
        }
    }

    @PluginMethod
    fun openCamera(call: PluginCall) = withCamera(call) { doOpen(call) }

    private fun doOpen(call: PluginCall) {
        if (benchmark != null) return call.reject("benchmark running")
        if (session.isOpen) return call.reject("camera already open")
        val fps = call.getInt("targetFps", 60)!!
        if (fps != 60 && fps != 30) return call.reject("targetFps must be 60 or 30")
        val cfg = CameraSession.Config(
            facing = call.getString("facing", "back")!!,
            resolution = call.getString("resolution", "1080p")!!,
            targetFps = fps,
            orientation = call.getString("orientation", "portrait")!!,
            analysisFps = (call.getInt("analysisFps", 30)!!).coerceIn(1, 60),
            fallbackFps = call.getInt("fallbackFps")?.takeIf { it == 30 },
            debugAnalysisDelayMs = (call.getInt("debugAnalysisDelayMs", 0)!!).coerceIn(0, 200),
            trackers = try { call.getArray("trackers")?.toList<String>() ?: emptyList() } catch (_: Exception) { emptyList() },
            trackerDelegate = call.getString("trackerDelegate", "auto")!!.takeIf { it in setOf("auto", "gpu", "cpu", "mixed") } ?: "auto",
        )
        session.open(cfg) { result, err -> if (err != null) call.reject(err) else call.resolve(result) }
    }

    @PluginMethod
    fun lockCameraSettings(call: PluginCall) {
        session.lock(
            call.getBoolean("ae", true)!!,
            call.getBoolean("af", true)!!,
            call.getBoolean("awb", true)!!,
        ) { err -> if (err != null) call.reject(err) else call.resolve() }
    }

    @PluginMethod
    fun startRecording(call: PluginCall) {
        val takeId = call.getString("takeId") ?: return call.reject("takeId required")
        if (!TAKE_ID.matches(takeId)) return call.reject("invalid takeId")
        val durationS = call.getDouble("durationS") ?: return call.reject("durationS required")
        if (durationS <= 0 || durationS > 600) return call.reject("durationS out of range")
        val cfg = session.config ?: return call.reject("camera not open")
        if (vault.takeDir(takeId).exists()) return call.reject("take already exists")
        // §15 StorageLow: block new takes below the configured free space.
        val minFree = call.getDouble("minFreeBytes")?.toLong() ?: 0L
        if (minFree > 0 && takesDir().apply { mkdirs() }.usableSpace < minFree) return call.reject("storage low", "STORAGE_LOW")
        val stopBelow = call.getDouble("stopBelowFreeBytes")?.toLong() ?: 0L
        val video = File(vault.takeDir(takeId), "video.mp4") // plaintext only while recording; encrypted at stop
        session.startRecording(takeId, video, durationS, onDone = { outcome ->
            // Recording thread: no JS involved (DEV_PLAN §3).
            val result = try {
                val (offset, _) = session.calibrationResult()
                TakeFinalizer.finalize(
                    vault, outcome, cfg.targetFps, session.isTimestampRealtime(), offset, session.sensors.clockOffsetMs(),
                    stopLeadMs = session.stopLeadNs / 1e6,
                    trackers = cfg.trackers,
                    orientation = cfg.orientation,
                    mirrored = cfg.facing == "front",
                )
            } catch (e: Exception) {
                null.also { notifyListeners("recordingState", JSObject().apply {
                    put("takeId", takeId); put("state", "error"); put("elapsedS", 0)
                    put("reason", "finalize failed: ${e.javaClass.simpleName}")
                }) }
            }
            if (result != null && outcome.interrupted != null) {
                // Interrupted by the system: encrypted partial kept as RetainedForRecovery.
                try { File(vault.takeDir(takeId), TakeVault.RECOVERY_MARKER).writeText("RetainedForRecovery\n") } catch (_: Exception) {}
                recovered = recovered + takeId
                notifyListeners("recordingState", JSObject().apply {
                    put("takeId", takeId); put("state", "interrupted")
                    put("elapsedS", result.getDouble("durationS")); put("reason", outcome.interrupted)
                })
                pendingStop?.reject("interrupted: ${outcome.interrupted}")
            } else if (result != null) {
                val error = outcome.error
                // Learn the stop lead from this take's measured duration error (decision 010).
                if (error == null && !outcome.stoppedEarly) session.learnStopLead(result.getDouble("durationErrorMs"))
                notifyListeners("recordingState", JSObject().apply {
                    put("takeId", takeId)
                    put("state", if (error != null) "error" else "completed")
                    put("elapsedS", result.getDouble("durationS"))
                    put("result", result)
                    error?.let { put("reason", it) }
                })
                pendingStop?.let { if (error != null) it.reject(error) else it.resolve(result) }
            } else {
                pendingStop?.reject("finalize failed")
            }
            pendingStop = null
        }, stopBelowFreeBytes = stopBelow, started = { err ->
            if (err != null) {
                call.reject(err)
            } else {
                notifyListeners("recordingState", JSObject().apply {
                    put("takeId", takeId); put("state", "recording"); put("elapsedS", 0)
                })
                call.resolve(JSObject().apply { put("startedAtNs", android.os.SystemClock.elapsedRealtimeNanos().toString()) })
            }
        })
    }

    @PluginMethod
    fun stopRecording(call: PluginCall) {
        if (!session.isRecording) return call.reject("not recording")
        pendingStop = call
        session.stopRecording(early = true)
    }

    @PluginMethod
    fun closeCamera(call: PluginCall) {
        if (benchmark == null) session.close()
        call.resolve()
    }

    @PluginMethod
    fun runQualificationBenchmark(call: PluginCall) = withCamera(call) { doBenchmark(call) }

    private fun doBenchmark(call: PluginCall) {
        if (benchmark != null) return call.reject("benchmark already running")
        if (session.isRecording) return call.reject("recording in progress")
        val fps = call.getInt("targetFps", 60)!!
        if (fps != 60 && fps != 30) return call.reject("targetFps must be 60 or 30")
        val opts = Benchmark.Opts(
            facing = call.getString("facing", "back")!!,
            resolution = call.getString("resolution", "1080p")!!,
            targetFps = fps,
            recordMinutes = call.getDouble("recordMinutes") ?: 10.0,
            thermalMinutes = call.getDouble("thermalMinutes") ?: 30.0,
        )
        val b = Benchmark(activity, session, opts, PLUGIN_VERSION,
            onProgress = { notifyListeners("benchmarkProgress", it) },
            onDone = { report, err ->
                benchmark = null
                if (err != null) {
                    notifyListeners("benchmarkProgress", JSObject().apply {
                        put("phase", if (err == "benchmark cancelled") "cancelled" else "error")
                        put("elapsedS", 0); put("totalS", 0); put("message", err)
                    })
                    call.reject(err)
                } else {
                    call.resolve(report)
                }
            })
        benchmark = b
        // Plugin methods run on Capacitor's background thread; the benchmark touches the window
        // (keep-screen-on) and the camera, so it must start on the main thread.
        activity.runOnUiThread {
            try {
                b.start()
            } catch (e: Exception) {
                benchmark = null
                call.reject("benchmark failed to start: ${e.javaClass.simpleName}: ${e.message}")
            }
        }
    }

    @PluginMethod
    fun cancelBenchmark(call: PluginCall) {
        benchmark?.cancel()
        call.resolve()
    }

    @PluginMethod
    fun saveQualificationReport(call: PluginCall) {
        val fileName = call.getString("fileName") ?: return call.reject("fileName required")
        val json = call.getString("json") ?: return call.reject("json required")
        if (!REPORT_NAME.matches(fileName)) return call.reject("invalid fileName")
        try {
            org.json.JSONObject(json)
            // App-specific external storage: no permission needed; collect with
            // adb pull /sdcard/Android/data/<appId>/files/qualification/
            val dir = File(context.getExternalFilesDir(null) ?: context.filesDir, "qualification").apply { mkdirs() }
            File(dir, fileName).writeText(json)
            call.resolve(JSObject().apply { put("fileName", fileName) })
        } catch (e: Exception) {
            call.reject("saveQualificationReport failed: ${e.message}")
        }
    }

    @PluginMethod
    fun writeEvidence(call: PluginCall) {
        val takeId = call.getString("takeId") ?: return call.reject("takeId required")
        val name = call.getString("name") ?: return call.reject("name required")
        val json = call.getString("json") ?: return call.reject("json required")
        if (!TAKE_ID.matches(takeId) || name !in setOf("quality.json", "meta.json")) return call.reject("invalid takeId or name")
        io.execute {
            try {
                org.json.JSONObject(json)
                vault.writeText(takeId, name, json) // encrypted directly, never plaintext on disk
                call.resolve()
            } catch (e: Exception) {
                call.reject("writeEvidence failed: ${e.javaClass.simpleName}")
            }
        }
    }

    @PluginMethod
    fun deleteTake(call: PluginCall) {
        val takeId = call.getString("takeId") ?: return call.reject("takeId required")
        if (!TAKE_ID.matches(takeId)) return call.reject("invalid takeId")
        io.execute {
            File(playbackDir(), "$takeId.mp4").delete()
            vault.delete(takeId) // removes the wrapped data key too
            call.resolve()
        }
    }

    /** Decrypts the video into the app cache and returns a WebView URL. Call closePlayback when done. */
    @PluginMethod
    fun playTake(call: PluginCall) {
        val takeId = call.getString("takeId") ?: return call.reject("takeId required")
        if (!TAKE_ID.matches(takeId)) return call.reject("invalid takeId")
        io.execute {
            try {
                val out = File(playbackDir(), "$takeId.mp4")
                vault.decryptTo(takeId, "video.mp4", out)
                call.resolve(JSObject().apply { put("playerUrl", bridge.localUrl + "/_capacitor_file_" + out.absolutePath) })
            } catch (e: Exception) {
                call.reject("playTake failed: ${e.javaClass.simpleName}")
            }
        }
    }

    /** Decrypted landmarks.bin of a take as base64 (replay overlay); data = null when absent. */
    @PluginMethod
    fun readLandmarks(call: PluginCall) {
        val takeId = call.getString("takeId") ?: return call.reject("takeId required")
        if (!TAKE_ID.matches(takeId)) return call.reject("invalid takeId")
        io.execute {
            try {
                val bytes = vault.openDecrypting(takeId, "landmarks.bin").use { it.readBytes() }
                call.resolve(JSObject().apply { put("data", android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP)) })
            } catch (e: java.io.FileNotFoundException) {
                call.resolve(JSObject().apply { put("data", org.json.JSONObject.NULL) })
            } catch (e: Exception) {
                call.reject("readLandmarks failed: ${e.javaClass.simpleName}")
            }
        }
    }

    @PluginMethod
    fun closePlayback(call: PluginCall) {
        val takeId = call.getString("takeId")
        io.execute {
            if (takeId != null && TAKE_ID.matches(takeId)) File(playbackDir(), "$takeId.mp4").delete()
            else playbackDir().deleteRecursively()
            call.resolve()
        }
    }

    /** Takes recovered (encrypted, marked RetainedForRecovery) after a crash at the last start. */
    @PluginMethod
    fun getRecoveredTakes(call: PluginCall) {
        io.execute { call.resolve(JSObject().apply { put("takeIds", com.getcapacitor.JSArray().apply { recovered.forEach { put(it) } }) }) }
    }

    /** Stored takes (newest first) with their saved capture result; survives app restarts. */
    @PluginMethod
    fun listTakes(call: PluginCall) {
        io.execute {
            val arr = com.getcapacitor.JSArray()
            takesDir().listFiles()
                ?.filter { it.isDirectory && TAKE_ID.matches(it.name) }
                ?.sortedByDescending { it.lastModified() }
                ?.forEach { dir ->
                    val result = if (File(dir, "capture.json.enc").exists()) {
                        try { JSObject(vault.readText(dir.name, "capture.json")) } catch (_: Exception) { null }
                    } else null
                    arr.put(JSObject().apply {
                        put("takeId", dir.name)
                        put("recovered", File(dir, TakeVault.RECOVERY_MARKER).exists())
                        put("sizeBytes", dir.listFiles()?.sumOf { it.length() } ?: 0L)
                        put("files", com.getcapacitor.JSArray().apply { dir.listFiles()?.map { it.name }?.sorted()?.forEach { put(it) } })
                        put("result", result ?: org.json.JSONObject.NULL)
                    })
                }
            call.resolve(JSObject().apply { put("takes", arr) })
        }
    }

    /** Engineering only (M2 crash test): the next take kills the app after afterS seconds. */
    @PluginMethod
    fun debugArmCrash(call: PluginCall) {
        session.crashAfterS = (call.getDouble("afterS") ?: 0.0).coerceIn(0.0, 60.0)
        call.resolve()
    }

    @PluginMethod
    fun secureGet(call: PluginCall) {
        val key = call.getString("key") ?: return call.reject("key required")
        io.execute {
            try {
                call.resolve(JSObject().apply { put("json", store.get(key) ?: org.json.JSONObject.NULL) })
            } catch (e: Exception) {
                call.reject("secureGet failed: ${e.javaClass.simpleName}")
            }
        }
    }

    @PluginMethod
    fun securePut(call: PluginCall) {
        val key = call.getString("key") ?: return call.reject("key required")
        val json = call.getString("json") ?: return call.reject("json required")
        io.execute {
            try {
                org.json.JSONTokener(json).nextValue()
                store.put(key, json)
                call.resolve()
            } catch (e: Exception) {
                call.reject("securePut failed: ${e.javaClass.simpleName}")
            }
        }
    }

    @PluginMethod
    fun secureDelete(call: PluginCall) {
        val key = call.getString("key") ?: return call.reject("key required")
        io.execute {
            try {
                store.delete(key)
                call.resolve()
            } catch (e: Exception) {
                call.reject("secureDelete failed: ${e.javaClass.simpleName}")
            }
        }
    }

    @PluginMethod
    fun secureKeys(call: PluginCall) {
        val prefix = call.getString("prefix") ?: ""
        io.execute {
            call.resolve(JSObject().apply { put("keys", com.getcapacitor.JSArray().apply { store.keys(prefix).forEach { put(it) } }) })
        }
    }

    /** Canonical clock (elapsedRealtimeNanos) for JS latency measurement (DEV_PLAN §5.5). */
    @PluginMethod
    fun clockNow(call: PluginCall) {
        call.resolve(JSObject().apply { put("elapsedRealtimeNs", android.os.SystemClock.elapsedRealtimeNanos().toString()) })
    }

    @PluginMethod
    fun calibrateSharpness(call: PluginCall) {
        if (!session.isOpen) return call.reject("camera not open")
        val durationS = (call.getDouble("durationS") ?: 3.0).coerceIn(1.0, 10.0)
        session.calibrateSharpness(durationS) { baseline, frames ->
            if (baseline == null) call.reject("no analysis frames during calibration")
            else call.resolve(JSObject().apply { put("baseline", baseline); put("frames", frames) })
        }
    }

    /** Upload settings; tokens only at sign-in (later calls keep the rotated tokens the queue holds). */
    @PluginMethod
    fun configureUploads(call: PluginCall) {
        val endpoint = call.getString("endpoint") ?: return call.reject("endpoint required")
        val keyId = call.getString("serverKeyId") ?: return call.reject("serverKeyId required")
        val pem = call.getString("serverPublicKeyPem") ?: return call.reject("serverPublicKeyPem required")
        if (!endpoint.startsWith("https://") && !(debuggable() && endpoint.startsWith("http://")))
            return call.reject("endpoint must use https")
        io.execute {
            try {
                KeyWrap.publicKey(pem) // reject a bad key now, not at upload time
                uploads.configure(UploadSettings(
                    endpoint.trimEnd('/'), call.getString("accessToken"), call.getString("refreshToken"), keyId, pem,
                    call.getBoolean("wifiOnly", true)!!, call.getDouble("retentionHours") ?: 24.0,
                ))
                Services.kickUploads(context)
                call.resolve()
            } catch (e: Exception) {
                call.reject("configureUploads failed: ${e.javaClass.simpleName}")
            }
        }
    }

    @PluginMethod
    fun clearUploadCredentials(call: PluginCall) {
        io.execute { uploads.clearCredentials(); call.resolve() }
    }

    @PluginMethod
    fun enqueueUpload(call: PluginCall) {
        val takeId = call.getString("takeId") ?: return call.reject("takeId required")
        val sid = call.getString("clientSessionId") ?: return call.reject("clientSessionId required")
        val sessionBody = call.getString("session") ?: return call.reject("session required")
        val takeBody = call.getString("take") ?: return call.reject("take required")
        if (!TAKE_ID.matches(takeId)) return call.reject("invalid takeId")
        io.execute {
            try {
                org.json.JSONObject(sessionBody); org.json.JSONObject(takeBody)
                val files = VaultTakeFiles(vault, takeId)
                if (files.kinds.isEmpty()) return@execute call.reject("unknown take")
                uploads.enqueue(UploadJob(takeId, sid, sessionBody, takeBody), files.kinds.sumOf { files.size(it) })
                Services.kickUploads(context)
                call.resolve()
            } catch (e: Exception) {
                call.reject("enqueueUpload failed: ${e.javaClass.simpleName}")
            }
        }
    }

    @PluginMethod
    fun enqueueSessionClose(call: PluginCall) {
        val sid = call.getString("clientSessionId") ?: return call.reject("clientSessionId required")
        val body = call.getString("body") ?: return call.reject("body required")
        io.execute {
            try {
                org.json.JSONObject(body)
                uploads.enqueueClose(sid, body)
                Services.kickUploads(context)
                call.resolve()
            } catch (e: Exception) {
                call.reject("enqueueSessionClose failed: ${e.javaClass.simpleName}")
            }
        }
    }

    @PluginMethod
    fun getUploadStatus(call: PluginCall) {
        val takeId = call.getString("takeId") ?: return call.reject("takeId required")
        io.execute {
            val s = uploads.record(takeId)?.status()
                ?: org.json.JSONObject().put("takeId", takeId).put("state", "failed_permanent")
                    .put("bytesSent", 0).put("bytesTotal", 0).put("reason", "unknown")
            call.resolve(JSObject(s.toString()))
        }
    }

    @PluginMethod
    fun listUploads(call: PluginCall) {
        io.execute {
            val arr = com.getcapacitor.JSArray()
            uploads.records().forEach { arr.put(it.status()) }
            call.resolve(JSObject().apply { put("uploads", arr) })
        }
    }

    @PluginMethod
    fun retryUploads(call: PluginCall) {
        io.execute { uploads.retry(); Services.kickUploads(context); call.resolve() }
    }

    @PluginMethod
    fun getStorageStatus(call: PluginCall) {
        val dir = takesDir().apply { mkdirs() }
        call.resolve(JSObject().apply { put("freeBytes", dir.usableSpace); put("totalBytes", dir.totalSpace) })
    }

    /** §15 AppBackgrounded (also an incoming call taking the screen): stop now, take = Interrupted. */
    override fun handleOnPause() {
        if (::session.isInitialized && session.isRecording) session.interrupt("app_backgrounded")
        super.handleOnPause()
    }

    private fun debuggable() =
        (context.applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0

    override fun handleOnDestroy() {
        Services.uploadListener = null
        benchmark?.cancel()
        if (::session.isInitialized) {
            session.close()
            session.sensors.stop()
        }
        super.handleOnDestroy()
    }

    companion object {
        const val PLUGIN_VERSION = "0.8.0"
        private val TAKE_ID = Regex("^[A-Za-z0-9_-]{1,64}$")
        private val REPORT_NAME = Regex("^[A-Za-z0-9._-]{1,120}\\.json$")
    }
}

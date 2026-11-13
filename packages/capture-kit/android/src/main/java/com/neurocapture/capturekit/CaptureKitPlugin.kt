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
import com.google.crypto.tink.integration.android.AndroidKeystoreKmsClient
import java.io.File
import java.util.concurrent.Executors

/**
 * CaptureKit Capacitor plugin (DEV_PLAN §5.3). Capabilities, camera + preview, fixed-duration
 * recording with per-frame timestamps and sensors, encrypted takes (Tink, Keystore-wrapped keys),
 * evidence, playback, crash recovery, sharpness calibration and the qualification benchmark.
 * Upload arrives in M7.
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
    private val io = Executors.newSingleThreadExecutor { Thread(it, "nc-vault") }
    @Volatile private var recovered: List<String> = emptyList()

    override fun load() {
        session = CameraSession(activity, bridge.webView) { event, data -> notifyListeners(event, data) }
        val master = AndroidKeystoreKmsClient.getOrGenerateNewAeadKey(MASTER_KEY_URI)
        vault = TakeVault(takesDir(), master)
        io.execute {
            playbackDir().deleteRecursively() // decrypted playback copies never survive a restart
            recovered = try { vault.recover() } catch (_: Exception) { emptyList() }
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
            call.resolve(DeviceInfo.capabilities(context, PLUGIN_VERSION))
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
        val video = File(vault.takeDir(takeId), "video.mp4") // plaintext only while recording; encrypted at stop
        session.startRecording(takeId, video, durationS, onDone = { outcome ->
            // Recording thread: no JS involved (DEV_PLAN §3).
            val result = try {
                val (offset, _) = session.calibrationResult()
                TakeFinalizer.finalize(vault, outcome, cfg.targetFps, session.isTimestampRealtime(), offset, session.sensors.clockOffsetMs())
            } catch (e: Exception) {
                null.also { notifyListeners("recordingState", JSObject().apply {
                    put("takeId", takeId); put("state", "error"); put("elapsedS", 0)
                    put("reason", "finalize failed: ${e.javaClass.simpleName}")
                }) }
            }
            if (result != null) {
                val error = outcome.error
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
        }, started = { err ->
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
        io.execute { call.resolve(JSObject().apply { put("takeIds", com.getcapacitor.JSArray(recovered)) }) }
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

    @PluginMethod
    fun enqueueUpload(call: PluginCall) = call.unimplemented("upload arrives in M7")

    @PluginMethod
    fun getUploadStatus(call: PluginCall) = call.unimplemented("upload arrives in M7")

    override fun handleOnDestroy() {
        benchmark?.cancel()
        if (::session.isInitialized) {
            session.close()
            session.sensors.stop()
        }
        super.handleOnDestroy()
    }

    companion object {
        const val PLUGIN_VERSION = "0.3.0"
        private const val MASTER_KEY_URI = "android-keystore://neurocapture_master_v1"
        private val TAKE_ID = Regex("^[A-Za-z0-9_-]{1,64}$")
        private val REPORT_NAME = Regex("^[A-Za-z0-9._-]{1,120}\\.json$")
    }
}

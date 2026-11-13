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

/**
 * CaptureKit Capacitor plugin (DEV_PLAN §5.3). M1 implements capabilities, camera + preview,
 * fixed-duration MP4 recording with per-frame timestamps, and the qualification benchmark.
 * Encryption, evidence, playback (M2) and upload (M7) are not implemented yet.
 */
@CapacitorPlugin(
    name = "CaptureKit",
    permissions = [Permission(alias = "camera", strings = [Manifest.permission.CAMERA])],
)
class CaptureKitPlugin : Plugin() {
    private lateinit var session: CameraSession
    private var benchmark: Benchmark? = null
    private var pendingStop: PluginCall? = null

    override fun load() {
        session = CameraSession(activity, bridge.webView) { event, data -> notifyListeners(event, data) }
    }

    private fun takesDir() = File(context.noBackupFilesDir, "takes")

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
        val targetFps = session.config?.targetFps ?: return call.reject("camera not open")
        val dir = File(takesDir(), takeId)
        val video = File(dir, "video.mp4")
        session.startRecording(takeId, video, durationS, onDone = { outcome ->
            outcome.log.writeTo(File(dir, "frames.bin"))
            val sensor = outcome.log.sensorSnapshot()
            val stats = FrameStats.recording(sensor, sensor.size, targetFps, outcome.mp4Frames, outcome.mp4DurationS)
            val result = JSObject().apply {
                put("takeId", takeId)
                put("durationS", stats.durationS)
                put("stoppedEarly", outcome.stoppedEarly)
                put("frameCount", stats.frameCount)
                put("effectiveFps", stats.effectiveFps)
                put("droppedFrames", stats.droppedFrames)
                put("droppedFrac", stats.droppedFrac)
                put("files", JSObject().apply {
                    // Opaque references, never absolute paths (PII-safe logging, §14).
                    put("video", "capturekit://takes/$takeId/video.mp4")
                    put("frames", "capturekit://takes/$takeId/frames.bin")
                    put("landmarks", "capturekit://takes/$takeId/landmarks.bin")
                    put("sensors", "capturekit://takes/$takeId/sensors.bin")
                })
            }
            notifyListeners("recordingState", JSObject().apply {
                put("takeId", takeId)
                put("state", if (outcome.error != null) "error" else "completed")
                put("elapsedS", stats.durationS)
                put("result", result)
                outcome.error?.let { put("reason", it) }
            })
            pendingStop?.let { if (outcome.error != null) it.reject(outcome.error) else it.resolve(result) }
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
        try {
            org.json.JSONObject(json)
            // M1: plaintext in app-private no-backup storage. M2 encrypts (Tink StreamingAead).
            File(File(takesDir(), takeId).apply { mkdirs() }, name).writeText(json)
            call.resolve()
        } catch (e: Exception) {
            call.reject("writeEvidence failed: ${e.message}")
        }
    }

    @PluginMethod
    fun deleteTake(call: PluginCall) {
        val takeId = call.getString("takeId") ?: return call.reject("takeId required")
        if (!TAKE_ID.matches(takeId)) return call.reject("invalid takeId")
        File(takesDir(), takeId).deleteRecursively()
        call.resolve()
    }

    @PluginMethod
    fun playTake(call: PluginCall) = call.unimplemented("playTake arrives in M2")

    @PluginMethod
    fun enqueueUpload(call: PluginCall) = call.unimplemented("upload arrives in M7")

    @PluginMethod
    fun getUploadStatus(call: PluginCall) = call.unimplemented("upload arrives in M7")

    override fun handleOnDestroy() {
        benchmark?.cancel()
        if (::session.isInitialized) session.close()
        super.handleOnDestroy()
    }

    companion object {
        const val PLUGIN_VERSION = "0.2.0"
        private val TAKE_ID = Regex("^[A-Za-z0-9_-]{1,64}$")
        private val REPORT_NAME = Regex("^[A-Za-z0-9._-]{1,120}\\.json$")
    }
}

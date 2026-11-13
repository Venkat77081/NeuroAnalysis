package com.neurocapture.capturekit

import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.os.StatFs
import android.view.WindowManager
import androidx.annotation.OptIn
import androidx.appcompat.app.AppCompatActivity
import androidx.camera.camera2.interop.Camera2CameraInfo
import androidx.camera.camera2.interop.ExperimentalCamera2Interop
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import org.json.JSONObject
import java.io.File
import java.time.Instant

/**
 * Device qualification benchmark (DEV_PLAN §7, M1). Collects raw measurements only; the tier is
 * assigned in TypeScript. Phases: storage check → open + clock calibration (60 frames) →
 * continuous recording (recordMinutes, analysis running) → thermal run (thermalMinutes, recorded
 * in ≤5-minute segments that are deleted as soon as they are measured).
 */
class Benchmark(
    private val activity: AppCompatActivity,
    private val session: CameraSession,
    private val opts: Opts,
    private val pluginVersion: String,
    private val onProgress: (JSObject) -> Unit,
    private val onDone: (JSObject?, String?) -> Unit,
) {
    data class Opts(val facing: String, val resolution: String, val targetFps: Int, val recordMinutes: Double, val thermalMinutes: Double)

    private val main = Handler(Looper.getMainLooper())
    private val dir = File(activity.cacheDir, "nc-benchmark")
    private val errors = ArrayList<String>()
    private val totalS = (opts.recordMinutes + opts.thermalMinutes) * 60
    private var startedMs = 0L
    private var phase = "calibrating"
    private var finished = false
    @Volatile private var cancelled = false

    private var freeBytes: Long? = null
    private var recordStats: FrameStats.Recording? = null
    private var analysisFrames = 0
    private var analysisP95: Double? = null
    private var thermalDurationS = 0.0
    private val thermalWindows = ArrayList<Int>()
    private var thermalStart = "unsupported"
    private var thermalMax = "unsupported"
    private var thermalMaxLevel = -1

    private val ticker = object : Runnable {
        override fun run() {
            if (finished) return
            sampleThermal()
            onProgress(JSObject().apply {
                put("phase", phase)
                put("elapsedS", (System.currentTimeMillis() - startedMs) / 1000.0)
                put("totalS", totalS)
                put("liveFps", session.takeFramesThisSecond())
                put("thermalStatus", thermalName(currentThermal()))
            })
            main.postDelayed(this, 1000)
        }
    }

    fun start() {
        startedMs = System.currentTimeMillis()
        activity.window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        dir.mkdirs()
        freeBytes = try { StatFs(activity.filesDir.absolutePath).availableBytes } catch (_: Exception) { null }
        val needed = if (opts.resolution == "1080p" && opts.targetFps == 60) 3L shl 30 else 2L shl 30
        if (freeBytes != null && freeBytes!! < needed && totalS > 0) {
            return fail("not enough free storage: ${freeBytes!! shr 20} MB free, ${needed shr 20} MB needed")
        }
        thermalStart = thermalName(currentThermal())
        sampleThermal()
        val cfg = CameraSession.Config(opts.facing, opts.resolution, opts.targetFps, "portrait", 30)
        session.emitAnalysisEvents = false
        if (session.isOpen) session.close()
        main.post(ticker)
        main.postDelayed({
            session.open(cfg) { _, err ->
                if (err != null) fail(err) else waitForCalibration(System.currentTimeMillis())
            }
        }, 300)
    }

    private fun waitForCalibration(since: Long) {
        if (cancelled) return
        if (session.calibrationSamples() >= CameraSession.CALIBRATION_FRAMES || System.currentTimeMillis() - since > 10_000) {
            if (session.calibrationSamples() < CameraSession.CALIBRATION_FRAMES) errors.add("clock calibration: only ${session.calibrationSamples()} frames in 10 s")
            recordPhase()
        } else {
            main.postDelayed({ waitForCalibration(since) }, 100)
        }
    }

    private fun recordPhase() {
        if (cancelled) return
        val seconds = opts.recordMinutes * 60
        if (seconds <= 0) return thermalPhase(opts.thermalMinutes * 60)
        phase = "recording"
        session.resetAnalysisStats()
        segment("record", seconds) { outcome ->
            val sensor = outcome.log.sensorSnapshot()
            recordStats = FrameStats.recording(sensor, sensor.size, opts.targetFps, outcome.mp4Frames, outcome.mp4DurationS)
            val (frames, p95) = session.analysisStats()
            analysisFrames = frames
            analysisP95 = p95
            thermalPhase(opts.thermalMinutes * 60)
        }
    }

    private fun thermalPhase(remainingS: Double) {
        if (cancelled) return
        if (remainingS <= 0.5) return finish()
        phase = "thermal"
        val seg = minOf(remainingS, SEGMENT_S)
        segment("thermal", seg) { outcome ->
            val sensor = outcome.log.sensorSnapshot()
            FrameStats.windowFps(sensor).forEach { thermalWindows.add(it) }
            thermalDurationS += outcome.mp4DurationS ?: seg
            thermalPhase(remainingS - seg)
        }
    }

    /** Records one segment, measures it, deletes the file, then continues. */
    private fun segment(name: String, seconds: Double, then: (CameraSession.Outcome) -> Unit) {
        val file = File(dir, "$name-${System.currentTimeMillis()}.mp4")
        session.startRecording("benchmark", file, seconds, onDone = { outcome ->
            file.delete()
            outcome.error?.let { errors.add("$name: $it") }
            main.post { if (!cancelled) then(outcome) }
        }, started = { err -> if (err != null) main.post { fail("$name: $err") } })
    }

    fun cancel() {
        if (finished) return
        cancelled = true
        session.stopRecording(early = true)
        main.postDelayed({ cleanup(); onDone(null, "benchmark cancelled") }, 500)
    }

    private fun fail(message: String) {
        if (finished) return
        errors.add(message)
        cleanup()
        onDone(null, message)
    }

    @OptIn(ExperimentalCamera2Interop::class)
    private fun finish() {
        val cam = session.camera
        val camera = if (cam != null) {
            val info = Camera2CameraInfo.from(cam.cameraInfo)
            val mgr = activity.getSystemService(Context.CAMERA_SERVICE) as android.hardware.camera2.CameraManager
            DeviceInfo.cameraBlock(mgr.getCameraCharacteristics(info.cameraId))
        } else null
        val (offsetMedian, spread) = session.calibrationResult()
        val rec = recordStats
        val windows = thermalWindows.sorted()
        val report = JSObject().apply {
            put("schemaVersion", "1.0.0")
            put("implementation", "native")
            put("pluginVersion", pluginVersion)
            put("ranAt", Instant.ofEpochMilli(startedMs).toString())
            put("device", DeviceInfo.device().apply { put("sdkInt", Build.VERSION.SDK_INT) })
            put("settings", JSObject().apply {
                put("facing", opts.facing)
                put("resolution", opts.resolution)
                put("targetFps", opts.targetFps)
                put("recordMinutes", opts.recordMinutes)
                put("thermalMinutes", opts.thermalMinutes)
            })
            put("camera", camera ?: JSONObject.NULL)
            put("timestamp", JSObject().apply {
                put("samples", session.calibrationSamples())
                put("offsetNsMedian", offsetMedian?.toString() ?: JSONObject.NULL)
                put("offsetSpreadMs", spread ?: JSONObject.NULL)
            })
            put("recording", JSObject().apply {
                put("durationS", rec?.durationS ?: 0.0)
                put("frameCount", rec?.frameCount ?: 0)
                put("effectiveFps", rec?.effectiveFps ?: 0.0)
                put("droppedFrames", rec?.droppedFrames ?: 0)
                put("droppedFrac", (rec?.droppedFrac ?: 0.0).coerceIn(0.0, 1.0))
                put("windowFpsMin", rec?.windowFpsMin ?: JSONObject.NULL)
            })
            val recS = rec?.durationS ?: 0.0
            put("analysis", JSObject().apply {
                put("fps", if (recS > 0) analysisFrames / recS else 0.0)
                put("p95ProcessingMs", analysisP95 ?: JSONObject.NULL)
                put("frames", analysisFrames)
            })
            put("thermal", JSObject().apply {
                put("durationS", thermalDurationS)
                put("statusStart", thermalStart)
                put("statusMax", thermalMax)
                put("windowFpsMin", windows.firstOrNull() ?: JSONObject.NULL)
                put("windowFpsMedian", if (windows.isEmpty()) JSONObject.NULL else windows[windows.size / 2])
            })
            put("storage", JSObject().apply { put("freeBytesBefore", freeBytes ?: JSONObject.NULL) })
            put("errors", JSArray().apply { errors.forEach { put(it) } })
        }
        if (camera == null) return fail("camera closed before the benchmark finished")
        cleanup()
        onProgress(JSObject().apply { put("phase", "done"); put("elapsedS", totalS); put("totalS", totalS) })
        onDone(report, null)
    }

    private fun cleanup() {
        finished = true
        main.removeCallbacksAndMessages(null)
        session.emitAnalysisEvents = true
        session.close()
        dir.listFiles()?.forEach { it.delete() }
        activity.runOnUiThread { activity.window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON) }
    }

    private fun currentThermal(): Int {
        if (Build.VERSION.SDK_INT < 29) return -1
        val pm = activity.getSystemService(Context.POWER_SERVICE) as PowerManager
        return pm.currentThermalStatus
    }

    private fun sampleThermal() {
        val level = currentThermal()
        if (level > thermalMaxLevel) {
            thermalMaxLevel = level
            thermalMax = thermalName(level)
        }
    }

    companion object {
        const val SEGMENT_S = 300.0

        fun thermalName(level: Int): String = when (level) {
            0 -> "none"
            1 -> "light"
            2 -> "moderate"
            3 -> "severe"
            4 -> "critical"
            5 -> "emergency"
            6 -> "shutdown"
            else -> "unsupported"
        }
    }
}

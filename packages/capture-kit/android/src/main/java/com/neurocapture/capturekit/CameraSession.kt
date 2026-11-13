package com.neurocapture.capturekit

import android.annotation.SuppressLint
import android.content.pm.ActivityInfo
import android.graphics.Color
import android.hardware.camera2.CameraCaptureSession
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CaptureRequest
import android.hardware.camera2.CaptureResult
import android.hardware.camera2.TotalCaptureResult
import android.media.MediaMetadataRetriever
import android.os.Handler
import android.os.HandlerThread
import android.os.SystemClock
import android.util.Range
import android.view.Surface
import android.view.ViewGroup
import android.webkit.WebView
import androidx.annotation.OptIn
import androidx.appcompat.app.AppCompatActivity
import androidx.camera.camera2.interop.Camera2CameraControl
import androidx.camera.camera2.interop.Camera2CameraInfo
import androidx.camera.camera2.interop.Camera2Interop
import androidx.camera.camera2.interop.CaptureRequestOptions
import androidx.camera.camera2.interop.ExperimentalCamera2Interop
import androidx.camera.core.AspectRatio
import androidx.camera.core.Camera
import androidx.camera.core.CameraSelector
import androidx.camera.core.FocusMeteringAction
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.core.SurfaceOrientedMeteringPointFactory
import androidx.camera.core.resolutionselector.AspectRatioStrategy
import androidx.camera.core.resolutionselector.ResolutionSelector
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.video.FileOutputOptions
import androidx.camera.video.Quality
import androidx.camera.video.QualitySelector
import androidx.camera.video.Recorder
import androidx.camera.video.Recording
import androidx.camera.video.VideoCapture
import androidx.camera.video.VideoRecordEvent
import androidx.camera.view.PreviewView
import androidx.core.content.ContextCompat
import com.getcapacitor.JSObject
import java.io.File
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong

/**
 * Owns the camera for one open/close cycle (DEV_PLAN §5.1–5.2).
 *
 * Threads: CameraX binding on the main thread; capture callbacks on [cbThread]; analysis on
 * [analysisExecutor]; recording events and the fixed-duration stop timer on [recThread].
 * Nothing here waits on JavaScript: the stop timer ends a take even if the WebView is frozen.
 */
class CameraSession(
    private val activity: AppCompatActivity,
    private val webView: WebView,
    private val emit: (String, JSObject) -> Unit,
) {
    data class Config(
        val facing: String,
        val resolution: String,
        val targetFps: Int,
        val orientation: String,
        val analysisFps: Int,
        val fallbackFps: Int? = null,
        val debugAnalysisDelayMs: Int = 0,
    )

    data class Outcome(
        val takeId: String,
        val file: File,
        val log: TimestampLog,
        val sensorLog: SensorLog,
        val requestedDurationS: Double,
        val actualFps: Int,
        val mp4Frames: Int?,
        val mp4DurationS: Double?,
        val stoppedEarly: Boolean,
        val error: String?,
    )

    private val main = ContextCompat.getMainExecutor(activity)
    private val cbThread = HandlerThread("nc-capture-cb").apply { start() }
    private val cbHandler = Handler(cbThread.looper)
    private val recThread = HandlerThread("nc-recording").apply { start() }
    private val recHandler = Handler(recThread.looper)
    private val recExecutor = java.util.concurrent.Executor { recHandler.post(it) }
    private val analysisExecutor: ExecutorService = Executors.newSingleThreadExecutor { Thread(it, "nc-analysis") }

    var config: Config? = null
        private set
    /** Frame rate actually requested from the camera (targetFps, or fallbackFps when unsupported). */
    var actualFps: Int = 0
        private set
    val sensors = SensorCapture(activity, emit)
    var camera: Camera? = null
        private set
    private var provider: ProcessCameraProvider? = null
    private var previewView: PreviewView? = null
    private var videoCapture: VideoCapture<Recorder>? = null
    private var timestampSourceRealtime = false

    // Clock calibration (first N frames after open).
    private val calibrationOffsets = ArrayList<Long>()
    @Volatile private var offsetNs: Long = 0

    // Frame counters for live fps.
    private val framesThisSecond = AtomicInteger(0)
    private val totalFrames = AtomicLong(0)

    // Analysis statistics.
    private val analysisFrames = AtomicInteger(0)
    private val processingMs = ArrayList<Double>()
    private var lastAnalysisTs = 0L
    private var analysisSeq = 0
    @Volatile var emitAnalysisEvents = true
    private var sharpnessSamples: ArrayList<Double>? = null

    // Recording state.
    @Volatile private var recordingLog: TimestampLog? = null
    private var recording: Recording? = null
    private var recordingTakeId: String? = null
    private var recordingFile: File? = null
    private var stoppedEarly = false
    private var recordStartElapsed = 0L
    private var onRecordingDone: ((Outcome) -> Unit)? = null
    private val stopRunnable = Runnable { stopRecording(early = false) }
    /** Engineering only (M2 crash test): kill the process this many seconds into the next take. */
    @Volatile var crashAfterS: Double = 0.0
    private val tickRunnable = object : Runnable {
        override fun run() {
            val id = recordingTakeId ?: return
            emit("recordingState", JSObject().apply {
                put("takeId", id)
                put("state", "recording")
                put("elapsedS", (SystemClock.elapsedRealtimeNanos() - recordStartElapsed) / 1e9)
            })
            recHandler.postDelayed(this, 500)
        }
    }

    val isOpen get() = camera != null
    val isRecording get() = recording != null

    private val captureCallback = object : CameraCaptureSession.CaptureCallback() {
        override fun onCaptureCompleted(session: CameraCaptureSession, request: CaptureRequest, result: TotalCaptureResult) {
            val sensorTs = result.get(CaptureResult.SENSOR_TIMESTAMP) ?: return
            val now = SystemClock.elapsedRealtimeNanos()
            framesThisSecond.incrementAndGet()
            totalFrames.incrementAndGet()
            if (calibrationOffsets.size < CALIBRATION_FRAMES) {
                synchronized(calibrationOffsets) { calibrationOffsets.add(now - sensorTs) }
                if (calibrationOffsets.size == CALIBRATION_FRAMES && !timestampSourceRealtime) {
                    offsetNs = FrameStats.median(calibrationOffsets.toLongArray()) ?: 0
                }
            }
            recordingLog?.add(result.frameNumber, sensorTs, toCanonical(sensorTs))
        }
    }

    fun toCanonical(sensorTs: Long): Long = if (timestampSourceRealtime) sensorTs else sensorTs + offsetNs

    /** Opens the camera with preview behind the transparent WebView. Calls [done] on the main thread. */
    @OptIn(ExperimentalCamera2Interop::class)
    fun open(cfg: Config, done: (JSObject?, String?) -> Unit) {
        main.execute {
            try {
                config = cfg
                activity.requestedOrientation =
                    if (cfg.orientation == "landscape") ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE else ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
                val rotation = if (cfg.orientation == "landscape") Surface.ROTATION_90 else Surface.ROTATION_0
                actualFps = chooseFps(cfg)
                val fpsRange = Range(actualFps, actualFps)
                val aspect = ResolutionSelector.Builder()
                    .setAspectRatioStrategy(AspectRatioStrategy.RATIO_16_9_FALLBACK_AUTO_STRATEGY)
                    .build()

                val previewBuilder = Preview.Builder().setResolutionSelector(aspect).setTargetRotation(rotation)
                Camera2Interop.Extender(previewBuilder)
                    .setCaptureRequestOption(CaptureRequest.CONTROL_AE_TARGET_FPS_RANGE, fpsRange)
                    .setSessionCaptureCallback(captureCallback)
                val preview = previewBuilder.build()

                val quality = if (cfg.resolution == "720p") Quality.HD else Quality.FHD
                // No quality fallback: an unsupported mode must fail loudly, never record lower quality silently.
                val recorder = Recorder.Builder().setQualitySelector(QualitySelector.from(quality)).build()
                val videoBuilder = VideoCapture.Builder(recorder)
                    .setTargetFrameRate(fpsRange)
                    .setVideoStabilizationEnabled(false)
                    .setTargetRotation(rotation)
                Camera2Interop.Extender(videoBuilder)
                    .setCaptureRequestOption(CaptureRequest.CONTROL_AE_TARGET_FPS_RANGE, fpsRange)
                    .setCaptureRequestOption(CaptureRequest.CONTROL_VIDEO_STABILIZATION_MODE, CaptureRequest.CONTROL_VIDEO_STABILIZATION_MODE_OFF)
                    .setCaptureRequestOption(CaptureRequest.LENS_OPTICAL_STABILIZATION_MODE, CaptureRequest.LENS_OPTICAL_STABILIZATION_MODE_OFF)
                val video = videoBuilder.build()

                val analysisBuilder = ImageAnalysis.Builder()
                    .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                    .setResolutionSelector(
                        ResolutionSelector.Builder()
                            .setAspectRatioStrategy(AspectRatioStrategy(AspectRatio.RATIO_16_9, AspectRatioStrategy.FALLBACK_RULE_AUTO))
                            .setResolutionStrategy(
                                androidx.camera.core.resolutionselector.ResolutionStrategy(
                                    android.util.Size(854, 480),
                                    androidx.camera.core.resolutionselector.ResolutionStrategy.FALLBACK_RULE_CLOSEST_HIGHER_THEN_LOWER,
                                ),
                            )
                            .build(),
                    )
                    .setTargetRotation(rotation)
                Camera2Interop.Extender(analysisBuilder)
                    .setCaptureRequestOption(CaptureRequest.CONTROL_AE_TARGET_FPS_RANGE, fpsRange)
                val analysis = analysisBuilder.build()
                analysis.setAnalyzer(analysisExecutor) { image -> analyze(image) }

                val pv = PreviewView(activity).apply {
                    implementationMode = PreviewView.ImplementationMode.COMPATIBLE
                    scaleType = PreviewView.ScaleType.FILL_CENTER
                    layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
                }
                (webView.parent as ViewGroup).addView(pv, 0)
                webView.setBackgroundColor(Color.TRANSPARENT)
                preview.setSurfaceProvider(pv.surfaceProvider)
                previewView = pv

                val selector = if (cfg.facing == "front") CameraSelector.DEFAULT_FRONT_CAMERA else CameraSelector.DEFAULT_BACK_CAMERA
                val future = ProcessCameraProvider.getInstance(activity)
                future.addListener({
                    try {
                        val p = future.get()
                        p.unbindAll()
                        val cam = p.bindToLifecycle(activity, selector, preview, video, analysis)
                        provider = p
                        camera = cam
                        videoCapture = video
                        sensors.start()
                        val info = Camera2CameraInfo.from(cam.cameraInfo)
                        timestampSourceRealtime = info.getCameraCharacteristic(CameraCharacteristics.SENSOR_INFO_TIMESTAMP_SOURCE) ==
                            CameraCharacteristics.SENSOR_INFO_TIMESTAMP_SOURCE_REALTIME
                        done(JSObject().apply {
                            put("previewTransform", previewTransform(pv, cfg))
                            put("actualFps", actualFps)
                        }, null)
                    } catch (e: Exception) {
                        teardownViews()
                        done(null, "camera bind failed: ${e.javaClass.simpleName}: ${e.message}")
                    }
                }, main)
            } catch (e: Exception) {
                teardownViews()
                done(null, "camera open failed: ${e.javaClass.simpleName}: ${e.message}")
            }
        }
    }

    /** targetFps if the default camera for this facing supports it at the resolution, else fallbackFps (decision 007). */
    private fun chooseFps(cfg: Config): Int {
        val fallback = cfg.fallbackFps ?: return cfg.targetFps
        return try {
            val mgr = activity.getSystemService(android.content.Context.CAMERA_SERVICE) as android.hardware.camera2.CameraManager
            val wanted = if (cfg.facing == "front") CameraCharacteristics.LENS_FACING_FRONT else CameraCharacteristics.LENS_FACING_BACK
            val id = mgr.cameraIdList.first { mgr.getCameraCharacteristics(it).get(CameraCharacteristics.LENS_FACING) == wanted }
            val size = if (cfg.resolution == "720p") android.util.Size(1280, 720) else android.util.Size(1920, 1080)
            val max = DeviceInfo.maxFps(mgr.getCameraCharacteristics(id), size) ?: 0.0
            if (max + 0.5 >= cfg.targetFps) cfg.targetFps else fallback
        } catch (_: Exception) {
            fallback
        }
    }

    /** Maps normalized upright analysis coordinates to CSS pixels (FILL_CENTER, 16:9 streams). Refined in M4. */
    private fun previewTransform(pv: PreviewView, cfg: Config): JSObject {
        val density = activity.resources.displayMetrics.density
        val viewW = (if (pv.width > 0) pv.width else activity.resources.displayMetrics.widthPixels).toDouble()
        val viewH = (if (pv.height > 0) pv.height else activity.resources.displayMetrics.heightPixels).toDouble()
        val (aw, ah) = if (cfg.orientation == "landscape") 16.0 to 9.0 else 9.0 to 16.0
        val scale = maxOf(viewW / aw, viewH / ah)
        val dw = aw * scale
        val dh = ah * scale
        return JSObject().apply {
            put("scaleX", dw / density)
            put("scaleY", dh / density)
            put("offsetX", (viewW - dw) / 2 / density)
            put("offsetY", (viewH - dh) / 2 / density)
            put("rotationDeg", 0)
            put("mirrored", cfg.facing == "front")
        }
    }

    private fun analyze(image: ImageProxy) {
        try {
            val cfg = config ?: return
            val ts = image.imageInfo.timestamp
            val minGap = 1_000_000_000L / cfg.analysisFps * 9 / 10
            if (ts - lastAnalysisTs < minGap) return
            lastAnalysisTs = ts
            val t0 = System.nanoTime()
            // Dummy analyzer for M1: mean luma and clipped fraction of the Y plane (sampled). MediaPipe arrives in M4.
            val plane = image.planes[0]
            val buf = plane.buffer
            val rowStride = plane.rowStride
            var sum = 0L
            var n = 0
            var clipped = 0
            var y = 0
            while (y < image.height) {
                var x = 0
                while (x < image.width) {
                    val v = buf.get(y * rowStride + x).toInt() and 0xFF
                    sum += v
                    if (v <= 2 || v >= 253) clipped++
                    n++
                    x += 8
                }
                y += 8
            }
            val sharp = laplacianVariance(buf, rowStride, image.width, image.height)
            sharpnessSamples?.let { synchronized(it) { it.add(sharp) } }
            if (cfg.debugAnalysisDelayMs > 0) Thread.sleep(cfg.debugAnalysisDelayMs.toLong()) // M2 isolation test only
            val ms = (System.nanoTime() - t0) / 1e6
            analysisFrames.incrementAndGet()
            synchronized(processingMs) { if (processingMs.size < 200_000) processingMs.add(ms) }
            if (!emitAnalysisEvents) return
            val rotated = image.imageInfo.rotationDegrees % 180 != 0
            emit("analysisFrame", JSObject().apply {
                put("seq", analysisSeq++)
                put("tsNs", toCanonical(ts).toString())
                put("imageW", if (rotated) image.height else image.width)
                put("imageH", if (rotated) image.width else image.height)
                put("stats", JSObject().apply {
                    put("lumaMean", if (n > 0) sum.toDouble() / n else 0.0)
                    put("clippedFrac", if (n > 0) clipped.toDouble() / n else 0.0)
                    put("sharpness", sharp)
                })
                put("trackerStatus", JSObject().apply {
                    put("hand", "off"); put("pose", "off"); put("face", "off")
                })
            })
        } finally {
            image.close()
        }
    }

    /** Variance of the 4-neighbour Laplacian over the central 50 % of the Y plane (step 2). */
    private fun laplacianVariance(buf: java.nio.ByteBuffer, stride: Int, w: Int, h: Int): Double {
        val x0 = w / 4; val x1 = w * 3 / 4; val y0 = h / 4; val y1 = h * 3 / 4
        var sum = 0.0; var sumSq = 0.0; var n = 0
        fun px(x: Int, y: Int) = (buf.get(y * stride + x).toInt() and 0xFF)
        var y = maxOf(y0, 1)
        while (y < minOf(y1, h - 1)) {
            var x = maxOf(x0, 1)
            while (x < minOf(x1, w - 1)) {
                val l = (px(x - 1, y) + px(x + 1, y) + px(x, y - 1) + px(x, y + 1) - 4 * px(x, y)).toDouble()
                sum += l; sumSq += l * l; n++
                x += 2
            }
            y += 2
        }
        if (n == 0) return 0.0
        val mean = sum / n
        return sumSq / n - mean * mean
    }

    /** Collects per-frame sharpness for [durationS] and returns the median (device baseline, §9.2). */
    fun calibrateSharpness(durationS: Double, done: (Double?, Int) -> Unit) {
        val samples = ArrayList<Double>()
        sharpnessSamples = samples
        recHandler.postDelayed({
            sharpnessSamples = null
            val arr = synchronized(samples) { samples.toDoubleArray() }
            done(FrameStats.percentile(arr, 50.0), arr.size)
        }, (durationS * 1000).toLong())
    }

    /** Frames delivered by the camera since the last call (≈ live fps when polled every second). */
    fun takeFramesThisSecond(): Int = framesThisSecond.getAndSet(0)

    fun calibrationSamples(): Int = synchronized(calibrationOffsets) { calibrationOffsets.size }

    fun calibrationResult(): Pair<Long?, Double?> = synchronized(calibrationOffsets) {
        val arr = calibrationOffsets.toLongArray()
        FrameStats.median(arr) to FrameStats.offsetSpreadMs(arr)
    }

    fun isTimestampRealtime() = timestampSourceRealtime

    fun resetAnalysisStats() {
        analysisFrames.set(0)
        synchronized(processingMs) { processingMs.clear() }
    }

    fun analysisStats(): Pair<Int, Double?> = analysisFrames.get() to synchronized(processingMs) {
        FrameStats.percentile(processingMs.toDoubleArray(), 95.0)
    }

    @OptIn(ExperimentalCamera2Interop::class)
    fun lock(ae: Boolean, af: Boolean, awb: Boolean, done: (String?) -> Unit) {
        main.execute {
            val cam = camera ?: return@execute done("camera not open")
            Camera2CameraControl.from(cam.cameraControl).setCaptureRequestOptions(
                CaptureRequestOptions.Builder()
                .setCaptureRequestOption(CaptureRequest.CONTROL_AE_LOCK, ae)
                    .setCaptureRequestOption(CaptureRequest.CONTROL_AWB_LOCK, awb)
                    .build(),
            )
            if (af) {
                val point = SurfaceOrientedMeteringPointFactory(1f, 1f).createPoint(0.5f, 0.5f)
                cam.cameraControl.startFocusAndMetering(
                    FocusMeteringAction.Builder(point, FocusMeteringAction.FLAG_AF).disableAutoCancel().build(),
                )
            }
            done(null)
        }
    }

    /** Starts recording to [file]; the native timer stops it after [durationS] (decision 002). */
    @SuppressLint("MissingPermission")
    fun startRecording(takeId: String, file: File, durationS: Double, onDone: (Outcome) -> Unit, started: (String?) -> Unit) {
        main.execute {
            val vc = videoCapture
            if (vc == null) return@execute started("camera not open")
            if (recording != null) return@execute started("already recording")
            file.parentFile?.mkdirs()
            val log = TimestampLog()
            val sLog = SensorLog()
            // Log from the request on, so the first encoded frame is always in the log (k ≥ 0).
            recordingLog = log
            sensors.recordingLog = sLog
            val fps = actualFps
            stoppedEarly = false
            onRecordingDone = onDone
            recordingTakeId = takeId
            recordingFile = file
            // Stop when the video itself reaches durationS (recorded media time), aiming half a frame
            // early because the encoder adds about one more frame after stop(). A native safety timer
            // still ends the take at durationS + 1 s. Neither depends on JavaScript (decision 009).
            val frameNs = 1_000_000_000L / fps
            val targetNs = (durationS * 1e9).toLong() - frameNs / 2
            val stopIssued = java.util.concurrent.atomic.AtomicBoolean(false)
            // Video only: no .withAudioEnabled().
            recording = vc.output.prepareRecording(activity, FileOutputOptions.Builder(file).build())
                .start(recExecutor) { event ->
                    when (event) {
                        is VideoRecordEvent.Start -> {
                            recordStartElapsed = SystemClock.elapsedRealtimeNanos()
                            recHandler.postDelayed(stopRunnable, (durationS * 1000).toLong() + 1000)
                            recHandler.post(tickRunnable)
                            val crash = crashAfterS
                            if (crash > 0) {
                                crashAfterS = 0.0
                                recHandler.postDelayed({ android.os.Process.killProcess(android.os.Process.myPid()) }, (crash * 1000).toLong())
                            }
                            started(null)
                        }
                        is VideoRecordEvent.Status -> {
                            if (event.recordingStats.recordedDurationNanos >= targetNs && stopIssued.compareAndSet(false, true)) {
                                stopRecording(early = false)
                            }
                        }
                        is VideoRecordEvent.Finalize -> finalizeRecording(event, takeId, file, log, sLog, durationS, fps)
                        else -> Unit
                    }
                }
        }
    }

    fun stopRecording(early: Boolean) {
        recHandler.removeCallbacks(stopRunnable)
        if (early) stoppedEarly = true
        recording?.stop()
    }

    private fun finalizeRecording(
        event: VideoRecordEvent.Finalize, takeId: String, file: File, log: TimestampLog, sLog: SensorLog, requestedS: Double, fps: Int,
    ) {
        recordingLog = null
        sensors.recordingLog = null
        recHandler.removeCallbacks(stopRunnable)
        recHandler.removeCallbacks(tickRunnable)
        val error = if (event.hasError() && event.error != VideoRecordEvent.Finalize.ERROR_DURATION_LIMIT_REACHED) {
            "recording error ${event.error}: ${event.cause?.message ?: ""}".trim()
        } else null
        var frames: Int? = null
        var durationS: Double? = null
        if (file.exists() && file.length() > 0) {
            val mmr = MediaMetadataRetriever()
            try {
                mmr.setDataSource(file.absolutePath)
                durationS = mmr.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toDoubleOrNull()?.div(1000.0)
                if (android.os.Build.VERSION.SDK_INT >= 28) {
                    frames = mmr.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_FRAME_COUNT)?.toIntOrNull()
                }
            } catch (_: Exception) {
            } finally {
                mmr.release()
            }
        }
        val outcome = Outcome(takeId, file, log, sLog, requestedS, fps, frames, durationS, stoppedEarly, error)
        recording = null
        recordingTakeId = null
        recordingFile = null
        val cb = onRecordingDone
        onRecordingDone = null
        cb?.invoke(outcome)
    }

    fun close() {
        stopRecording(early = true)
        main.execute {
            try {
                provider?.unbindAll()
            } catch (_: Exception) {
            }
            sensors.stop()
            camera = null
            videoCapture = null
            provider = null
            config = null
            synchronized(calibrationOffsets) { calibrationOffsets.clear() }
            teardownViews()
            activity.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
        }
    }

    private fun teardownViews() {
        previewView?.let { (it.parent as? ViewGroup)?.removeView(it) }
        previewView = null
        webView.setBackgroundColor(Color.WHITE)
    }

    companion object {
        const val CALIBRATION_FRAMES = 60
    }
}

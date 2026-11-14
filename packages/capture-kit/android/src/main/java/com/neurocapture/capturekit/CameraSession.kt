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
        val trackers: List<String> = emptyList(),
        /** "auto" = GPU then CPU; "gpu" or "cpu" to force one (device tuning, decision 016). */
        val trackerDelegate: String = "auto",
    )

    data class Outcome(
        val takeId: String,
        val file: File,
        val log: TimestampLog,
        val sensorLog: SensorLog,
        val landmarks: List<LandmarkFormat.Record>,
        val requestedDurationS: Double,
        val actualFps: Int,
        val mp4Frames: Int?,
        val mp4DurationS: Double?,
        val stoppedEarly: Boolean,
        val error: String?,
        /** Analysis image size (upright) for the landmarks.bin header. */
        val imageW: Int = 0,
        val imageH: Int = 0,
        /** §15: 'storage_low' or 'app_backgrounded' when the take was cut short by the system. */
        val interrupted: String? = null,
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
    @Volatile private var interruptReason: String? = null
    @Volatile private var lastImageW = 0
    @Volatile private var lastImageH = 0
    private var recordStartElapsed = 0L
    private var onRecordingDone: ((Outcome) -> Unit)? = null
    private val stopRunnable = Runnable { stopRecording(early = false) }
    private val prefs = activity.getSharedPreferences("neurocapture.capture", android.content.Context.MODE_PRIVATE)

    /**
     * How early to call stop() before the target duration: the encoder keeps writing the frames
     * already in its pipeline (≈ 100 ms on the first device). Learned per device from each take's
     * measured duration error and persisted (decision 010).
     */
    var stopLeadNs: Long = prefs.getLong(PREF_STOP_LEAD, DEFAULT_STOP_LEAD_NS)
        private set

    /** Update the stop lead from a completed take: positive error (too long) → stop earlier. */
    fun learnStopLead(durationErrorMs: Double) {
        if (durationErrorMs.isNaN() || kotlin.math.abs(durationErrorMs) > 1000) return
        val next = (stopLeadNs + (durationErrorMs * 0.7 * 1e6).toLong()).coerceIn(0L, MAX_STOP_LEAD_NS)
        stopLeadNs = next
        prefs.edit().putLong(PREF_STOP_LEAD, next).apply()
    }

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
                    .setOutputImageFormat(ImageAnalysis.OUTPUT_IMAGE_FORMAT_RGBA_8888)
                    // Upright frames: MediaPipe returns landmarks in its input image's frame, so feed it upright.
                    .setOutputImageRotationEnabled(true)
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

    /** Per-frame data kept until the trackers' results for that frame arrive. */
    private class FrameInfo(
        val seq: Int,
        val tsNs: Long,
        val w: Int,
        val h: Int,
        val stats: FrameMath.Stats,
        /** Small RGBA copy (≈ 80 px wide) for the face light-balance ratio. */
        val grid: java.nio.ByteBuffer,
        val gw: Int,
        val gh: Int,
        val startNs: Long,
        /** Analysis start → submit to MediaPipe (stats, copy, grid). */
        val prepNs: Long = 0,
    )

    private val pendingFrames = java.util.concurrent.ConcurrentHashMap<Long, FrameInfo>()
    private var tracking: Tracking? = null
    private val bitmapPool = arrayOfNulls<android.graphics.Bitmap>(3)
    private var poolIndex = 0
    private var lastFrameMs = 0L
    @Volatile private var landmarkLog: ArrayList<LandmarkFormat.Record>? = null
    val trackingGpu: Boolean? get() = tracking?.gpu

    private fun analyze(image: ImageProxy) {
        try {
            val cfg = config ?: return
            val ts = image.imageInfo.timestamp
            val minGap = 1_000_000_000L / cfg.analysisFps * 9 / 10
            if (ts - lastAnalysisTs < minGap) return
            // Tracker still busy with the previous frame: skip this one entirely (no queue).
            if (tracking?.ready() == false) return
            lastAnalysisTs = ts
            val t0 = System.nanoTime()
            val plane = image.planes[0] // RGBA_8888, single plane
            val buf = plane.buffer
            val rowStride = plane.rowStride
            val w = image.width
            val h = image.height
            // One bulk copy into a reused, tightly packed array; stats and the bitmap use the copy.
            val frameSize = w * h * 4
            val bytes = frameBytes?.takeIf { it.size == frameSize } ?: ByteArray(frameSize).also { frameBytes = it }
            buf.rewind()
            if (rowStride == w * 4) buf.get(bytes, 0, frameSize)
            else for (row in 0 until h) { buf.position(row * rowStride); buf.get(bytes, row * w * 4, w * 4) }
            val stats = FrameMath.stats(bytes, w, h, w * 4)
            sharpnessSamples?.let { synchronized(it) { it.add(stats.sharpness.toDouble()) } }
            if (cfg.debugAnalysisDelayMs > 0) Thread.sleep(cfg.debugAnalysisDelayMs.toLong()) // M2 isolation test only
            analysisFrames.incrementAndGet()
            synchronized(processingMs) { if (processingMs.size < 200_000) processingMs.add((System.nanoTime() - t0) / 1e6) }
            val rotation = image.imageInfo.rotationDegrees
            val rotated = rotation % 180 != 0
            val seq = analysisSeq++
            val canonical = toCanonical(ts)
            val enabled = cfg.trackers.filter { it in LandmarkFormat.TRACKERS.keys }.toSet()
            if (enabled.isEmpty()) {
                if (emitAnalysisEvents) emit("analysisFrame", statsOnlyEvent(seq, canonical, if (rotated) h else w, if (rotated) w else h, stats, t0))
                return
            }
            val tr = tracking ?: Tracking(activity, enabled, cfg.trackerDelegate, ::onTracked) { msg -> emit("trackingError", JSObject().apply { put("message", msg) }) }
                .also { tracking = it }
            var bmp = nextBitmap(w, h)
            bmp.copyPixelsFromBuffer(java.nio.ByteBuffer.wrap(bytes))
            // Normally 0 (rotation done by CameraX); rotate here if a device ignores that setting.
            if (rotation != 0) {
                val m = android.graphics.Matrix().apply { postRotate(rotation.toFloat()) }
                bmp = android.graphics.Bitmap.createBitmap(bmp, 0, 0, w, h, m, false)
            }
            val uw = bmp.width
            val uh = bmp.height
            // Small upright grid (≈ 80 px wide) for the face light-balance ratio.
            val gw = 80
            val gh = maxOf(1, uh * gw / maxOf(uw, 1))
            // One native scale + copy instead of 3600 getPixel calls. ARGB_8888 bytes are RGBA.
            val small = android.graphics.Bitmap.createScaledBitmap(bmp, gw, gh, false)
            val grid = java.nio.ByteBuffer.allocate(gw * gh * 4)
            small.copyPixelsToBuffer(grid)
            small.recycle()
            grid.rewind()
            // MediaPipe live stream needs strictly increasing millisecond timestamps.
            val frameMs = maxOf(canonical / 1_000_000L, lastFrameMs + 1).also { lastFrameMs = it }
            pendingFrames[frameMs] = FrameInfo(seq, canonical, uw, uh, stats, grid, gw, gh, t0, System.nanoTime() - t0)
            if (pendingFrames.size > 16) pendingFrames.keys.sorted().take(pendingFrames.size - 16).forEach { pendingFrames.remove(it) }
            tr.submit(bmp, 0, frameMs)
        } catch (e: Exception) {
            emit("trackingError", JSObject().apply { put("message", "analysis: ${e.javaClass.simpleName}") })
        } finally {
            image.close()
        }
    }

    private var frameBytes: ByteArray? = null

    private fun nextBitmap(w: Int, h: Int): android.graphics.Bitmap {
        poolIndex = (poolIndex + 1) % bitmapPool.size
        val cur = bitmapPool[poolIndex]
        if (cur != null && cur.width == w && cur.height == h) return cur
        return android.graphics.Bitmap.createBitmap(w, h, android.graphics.Bitmap.Config.ARGB_8888).also { bitmapPool[poolIndex] = it }
    }

    private fun statsOnlyEvent(seq: Int, tsNs: Long, w: Int, h: Int, stats: FrameMath.Stats, t0: Long) = JSObject().apply {
        put("seq", seq)
        put("tsNs", tsNs.toString())
        put("imageW", w)
        put("imageH", h)
        put("stats", JSObject().apply {
            put("lumaMean", stats.lumaMean.toDouble()); put("clippedFrac", stats.clippedFrac.toDouble()); put("sharpness", stats.sharpness.toDouble())
        })
        put("trackerStatus", JSObject().apply { put("hand", "off"); put("pose", "off"); put("face", "off") })
        put("emitNs", SystemClock.elapsedRealtimeNanos().toString())
        put("procMs", (System.nanoTime() - t0) / 1e6)
    }

    private fun b64(f: FloatArray): String {
        val bb = java.nio.ByteBuffer.allocate(f.size * 4).order(java.nio.ByteOrder.LITTLE_ENDIAN)
        f.forEach { bb.putFloat(it) }
        return android.util.Base64.encodeToString(bb.array(), android.util.Base64.NO_WRAP)
    }

    private val statusNames = arrayOf("off", "ok", "no_result", "error")

    /** Joined tracker results for one frame → analysisFrame event (+ landmarks.bin record while recording). */
    private fun onTracked(j: Tracking.Joined) {
        val info = pendingFrames.remove(j.frameMs) ?: return
        val hands = ArrayList<LandmarkFormat.Hand>()
        j.hand?.let { r ->
            r.landmarks().forEachIndexed { i, lms ->
                val cat = r.handedness().getOrNull(i)?.firstOrNull()
                val pts = FloatArray(LandmarkFormat.HAND_VALUES)
                lms.forEachIndexed { k, p ->
                    if (k < 21) {
                        pts[k * 4] = p.x(); pts[k * 4 + 1] = p.y(); pts[k * 4 + 2] = p.z()
                        pts[k * 4 + 3] = p.visibility().orElse(p.presence().orElse(1f))
                    }
                }
                hands.add(LandmarkFormat.Hand(cat?.categoryName() == "Right", cat?.score() ?: 0f, pts))
            }
        }
        val poseCount = j.pose?.landmarks()?.size ?: 0
        val pose = j.pose?.landmarks()?.firstOrNull()?.let { lms ->
            FloatArray(LandmarkFormat.POSE_VALUES).also { pts ->
                lms.forEachIndexed { k, p ->
                    if (k < 33) { pts[k * 4] = p.x(); pts[k * 4 + 1] = p.y(); pts[k * 4 + 2] = p.z(); pts[k * 4 + 3] = p.visibility().orElse(0f) }
                }
            }
        }
        val faceCount = j.face?.faceLandmarks()?.size ?: 0
        var faceRatio: Float? = null
        val face = j.face?.faceLandmarks()?.firstOrNull()?.let { lms ->
            val pts = FloatArray(LandmarkFormat.FACE_VALUES)
            lms.forEachIndexed { k, p -> if (k < 478) { pts[k * 3] = p.x(); pts[k * 3 + 1] = p.y(); pts[k * 3 + 2] = p.z() } }
            val blend = j.face.faceBlendshapes().orElse(null)?.firstOrNull()?.let { cats ->
                FloatArray(LandmarkFormat.BLEND_VALUES).also { b -> cats.forEachIndexed { k, c -> if (k < 52) b[k] = c.score() } }
            }
            val angles = j.face.facialTransformationMatrixes().orElse(null)?.firstOrNull()?.let { FrameMath.faceAngles(it) }
                ?: FrameMath.Angles(0f, 0f, 0f)
            faceRatio = FrameMath.faceLumaRatio(info.grid.also { it.rewind() }, info.gw, info.gh, info.gw * 4, pts)
            LandmarkFormat.Face(angles.yawDeg, angles.pitchDeg, angles.rollDeg, pts, blend)
        }
        val record = LandmarkFormat.Record(
            info.tsNs, info.seq, j.statusOf("hand"), j.statusOf("pose"), j.statusOf("face"),
            info.stats.lumaMean, info.stats.clippedFrac, info.stats.sharpness, faceRatio, hands, pose, face,
        )
        landmarkLog?.let { synchronized(it) { if (it.size < MAX_LANDMARK_FRAMES) it.add(record) } }
        lastImageW = info.w
        lastImageH = info.h
        if (!emitAnalysisEvents) return
        emit("analysisFrame", JSObject().apply {
            put("seq", info.seq)
            put("tsNs", info.tsNs.toString())
            put("imageW", info.w)
            put("imageH", info.h)
            if (hands.isNotEmpty()) put("hands", com.getcapacitor.JSArray().apply {
                hands.forEach { hd -> put(JSObject().apply { put("handedness", if (hd.labelRight) "Right" else "Left"); put("score", hd.score.toDouble()); put("lm", b64(hd.pts)) }) }
            })
            if (pose != null) put("pose", JSObject().apply { put("lm", b64(pose)) })
            if (face != null) put("face", JSObject().apply {
                put("lm", b64(face.pts)); face.blend?.let { put("blendshapes", b64(it)) }
                put("yawDeg", face.yaw.toDouble()); put("pitchDeg", face.pitch.toDouble()); put("rollDeg", face.roll.toDouble())
            })
            put("counts", JSObject().apply { put("hands", hands.size); put("poses", poseCount); put("faces", faceCount) })
            put("stats", JSObject().apply {
                put("lumaMean", info.stats.lumaMean.toDouble()); put("clippedFrac", info.stats.clippedFrac.toDouble()); put("sharpness", info.stats.sharpness.toDouble())
                faceRatio?.let { put("faceLumaRatio", it.toDouble()) }
            })
            put("trackerStatus", JSObject().apply {
                put("hand", statusNames[j.statusOf("hand")]); put("pose", statusNames[j.statusOf("pose")]); put("face", statusNames[j.statusOf("face")])
            })
            put("emitNs", SystemClock.elapsedRealtimeNanos().toString())
            put("procMs", (System.nanoTime() - info.startNs) / 1e6)
            put("prepMs", info.prepNs / 1e6)
        })
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
    fun startRecording(
        takeId: String, file: File, durationS: Double, onDone: (Outcome) -> Unit, started: (String?) -> Unit,
        stopBelowFreeBytes: Long = 0,
    ) {
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
            val lLog = ArrayList<LandmarkFormat.Record>()
            landmarkLog = lLog
            val fps = actualFps
            stoppedEarly = false
            interruptReason = null
            var lastSpaceCheckNs = 0L
            onRecordingDone = onDone
            recordingTakeId = takeId
            recordingFile = file
            // Stop when the video itself reaches durationS − stopLeadNs (recorded media time): the
            // encoder still writes the frames in its pipeline after stop(). A native safety timer ends
            // the take at durationS + 1 s. Neither depends on JavaScript (decisions 009, 010).
            val targetNs = ((durationS * 1e9).toLong() - stopLeadNs).coerceAtLeast(0L)
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
                            // §15 StorageLow: check about once a second; stop gracefully and keep the partial.
                            val t = SystemClock.elapsedRealtimeNanos()
                            if (stopBelowFreeBytes > 0 && t - lastSpaceCheckNs > 1_000_000_000L) {
                                lastSpaceCheckNs = t
                                if ((file.parentFile?.usableSpace ?: Long.MAX_VALUE) < stopBelowFreeBytes &&
                                    stopIssued.compareAndSet(false, true)
                                ) interrupt("storage_low")
                            }
                        }
                        is VideoRecordEvent.Finalize -> finalizeRecording(event, takeId, file, log, sLog, lLog, durationS, fps)
                        else -> Unit
                    }
                }
        }
    }

    /** Ends the take now because of the system (§15); the partial is encrypted and kept for recovery. */
    fun interrupt(reason: String) {
        if (recording == null) return
        interruptReason = reason
        stopRecording(early = true)
    }

    fun stopRecording(early: Boolean) {
        recHandler.removeCallbacks(stopRunnable)
        if (early) stoppedEarly = true
        recording?.stop()
    }

    private fun finalizeRecording(
        event: VideoRecordEvent.Finalize, takeId: String, file: File, log: TimestampLog, sLog: SensorLog,
        lLog: ArrayList<LandmarkFormat.Record>, requestedS: Double, fps: Int,
    ) {
        recordingLog = null
        sensors.recordingLog = null
        landmarkLog = null
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
        val landmarks = synchronized(lLog) { ArrayList(lLog) }
        val outcome = Outcome(takeId, file, log, sLog, landmarks, requestedS, fps, frames, durationS, stoppedEarly, error, lastImageW, lastImageH, interruptReason)
        interruptReason = null
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
            analysisExecutor.execute {
                tracking?.close()
                tracking = null
                pendingFrames.clear()
            }
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
        /** ≈ 2 min at 30 analysis fps; takes are ≤ 30 s. */
        const val MAX_LANDMARK_FRAMES = 3600
        private const val PREF_STOP_LEAD = "stopLeadNs"
        const val DEFAULT_STOP_LEAD_NS = 110_000_000L
        const val MAX_STOP_LEAD_NS = 400_000_000L
    }
}

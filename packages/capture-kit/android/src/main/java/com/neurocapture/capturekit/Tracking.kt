package com.neurocapture.capturekit

import android.content.Context
import android.graphics.Bitmap
import com.google.mediapipe.framework.image.BitmapImageBuilder
import com.google.mediapipe.framework.image.MPImage
import com.google.mediapipe.tasks.core.BaseOptions
import com.google.mediapipe.tasks.core.Delegate
import com.google.mediapipe.tasks.vision.core.ImageProcessingOptions
import com.google.mediapipe.tasks.vision.core.RunningMode
import com.google.mediapipe.tasks.vision.facelandmarker.FaceLandmarker
import com.google.mediapipe.tasks.vision.facelandmarker.FaceLandmarkerResult
import com.google.mediapipe.tasks.vision.handlandmarker.HandLandmarker
import com.google.mediapipe.tasks.vision.handlandmarker.HandLandmarkerResult
import com.google.mediapipe.tasks.vision.poselandmarker.PoseLandmarker
import com.google.mediapipe.tasks.vision.poselandmarker.PoseLandmarkerResult

/**
 * MediaPipe Hand / Pose / Face landmarkers in live-stream mode (DEV_PLAN §4, M4). Only the trackers
 * the test config lists are created. GPU delegate first, CPU fallback. Results for one camera frame
 * arrive on separate listeners and are merged by [FrameJoiner]; [onFrame] gets one [Joined] per
 * frame. Runs entirely off the recording path: if tracking is slow, frames are dropped here only.
 */
class Tracking(
    context: Context,
    val enabled: Set<String>,
    /** "auto" (GPU, CPU on failure), "gpu" or "cpu". */
    delegate: String,
    private val onFrame: (Joined) -> Unit,
    private val onError: (String) -> Unit,
) {
    /** Per-tracker outcome for one frame: result (may be empty = no_result) or null = error. */
    class Joined(
        val frameMs: Long,
        val hand: HandLandmarkerResult?,
        val pose: PoseLandmarkerResult?,
        val face: FaceLandmarkerResult?,
        val statusOf: (String) -> Int,
    )

    private fun isEmpty(r: Any?): Boolean = when (r) {
        is HandLandmarkerResult -> r.landmarks().isEmpty()
        is PoseLandmarkerResult -> r.landmarks().isEmpty()
        is FaceLandmarkerResult -> r.faceLandmarks().isEmpty()
        else -> true
    }

    private var hand: HandLandmarker? = null
    private var pose: PoseLandmarker? = null
    private var face: FaceLandmarker? = null
    var gpu: Boolean = false
        private set
    private val errored = HashSet<String>()

    // One frame in flight at a time: feeding MediaPipe faster than it finishes only builds a queue
    // (latency grows, busy trackers drop frames). Decision 016.
    @Volatile private var inFlightMs = -1L
    @Volatile private var inFlightSinceNs = 0L

    /** True when the previous frame's results are all back (or it is stuck for > 1 s). */
    fun ready(): Boolean = inFlightMs < 0 || System.nanoTime() - inFlightSinceNs > 1_000_000_000L

    private val joiner = FrameJoiner<Any>(enabled) { ms, results ->
        if (ms >= inFlightMs) inFlightMs = -1L
        // 0 off · 1 ok (found something) · 2 no_result (ran, found nothing) · 3 error (failed, or
        // the frame was dropped by a busy tracker: input unavailable → UNKNOWN in the checks).
        fun status(name: String): Int = when {
            name !in enabled -> 0
            name !in results -> 3
            results[name] == null -> if (name in errored) 3 else 2
            isEmpty(results[name]) -> 2
            else -> 1
        }
        onFrame(
            Joined(
                ms,
                results["hand"] as? HandLandmarkerResult,
                results["pose"] as? PoseLandmarkerResult,
                results["face"] as? FaceLandmarkerResult,
                ::status,
            ),
        )
    }

    init {
        gpu = when (delegate) {
            "cpu" -> { create(context, Delegate.CPU); false }
            "gpu" -> { create(context, Delegate.GPU); true }
            // Pose on CPU, hands and face on GPU: the two run in parallel on different hardware.
            "mixed" -> { create(context, Delegate.GPU, poseDelegate = Delegate.CPU); true }
            else -> try {
                create(context, Delegate.GPU)
                true
            } catch (e: Throwable) {
                close()
                create(context, Delegate.CPU)
                false
            }
        }
    }

    private fun base(path: String, delegate: Delegate) =
        BaseOptions.builder().setModelAssetPath("mediapipe/$path").setDelegate(delegate).build()

    private fun create(context: Context, delegate: Delegate, poseDelegate: Delegate = delegate) {
        if ("hand" in enabled) {
            hand = HandLandmarker.createFromOptions(
                context,
                HandLandmarker.HandLandmarkerOptions.builder()
                    .setBaseOptions(base("hand_landmarker.task", delegate))
                    .setRunningMode(RunningMode.LIVE_STREAM)
                    .setNumHands(2)
                    .setResultListener { r: HandLandmarkerResult, _: MPImage -> joiner.offer(r.timestampMs(), "hand", r) }
                    .setErrorListener { e: RuntimeException -> fail("hand", e) }
                    .build(),
            )
        }
        if ("pose" in enabled) {
            pose = PoseLandmarker.createFromOptions(
                context,
                PoseLandmarker.PoseLandmarkerOptions.builder()
                    .setBaseOptions(base("pose_landmarker_lite.task", poseDelegate))
                    .setRunningMode(RunningMode.LIVE_STREAM)
                    .setNumPoses(2)
                    .setResultListener { r: PoseLandmarkerResult, _: MPImage -> joiner.offer(r.timestampMs(), "pose", r) }
                    .setErrorListener { e: RuntimeException -> fail("pose", e) }
                    .build(),
            )
        }
        if ("face" in enabled) {
            face = FaceLandmarker.createFromOptions(
                context,
                FaceLandmarker.FaceLandmarkerOptions.builder()
                    .setBaseOptions(base("face_landmarker.task", delegate))
                    .setRunningMode(RunningMode.LIVE_STREAM)
                    .setNumFaces(2)
                    .setOutputFaceBlendshapes(true)
                    .setOutputFacialTransformationMatrixes(true)
                    .setResultListener { r: FaceLandmarkerResult, _: MPImage -> joiner.offer(r.timestampMs(), "face", r) }
                    .setErrorListener { e: RuntimeException -> fail("face", e) }
                    .build(),
            )
        }
    }

    private fun fail(name: String, e: RuntimeException) {
        synchronized(errored) { errored.add(name) }
        onError("$name: ${e.javaClass.simpleName}")
    }

    /** Submit one upright-able frame. [frameMs] must increase (MediaPipe live-stream rule). */
    fun submit(bitmap: Bitmap, rotationDegrees: Int, frameMs: Long) {
        if (enabled.isEmpty()) return
        val image = BitmapImageBuilder(bitmap).build()
        val opts = ImageProcessingOptions.builder().setRotationDegrees(rotationDegrees).build()
        synchronized(errored) { errored.clear() }
        inFlightMs = frameMs
        inFlightSinceNs = System.nanoTime()
        try { hand?.detectAsync(image, opts, frameMs) } catch (e: RuntimeException) { fail("hand", e); joiner.offer(frameMs, "hand", null) }
        try { pose?.detectAsync(image, opts, frameMs) } catch (e: RuntimeException) { fail("pose", e); joiner.offer(frameMs, "pose", null) }
        try { face?.detectAsync(image, opts, frameMs) } catch (e: RuntimeException) { fail("face", e); joiner.offer(frameMs, "face", null) }
    }

    fun close() {
        try { hand?.close() } catch (_: Exception) {}
        try { pose?.close() } catch (_: Exception) {}
        try { face?.close() } catch (_: Exception) {}
        hand = null; pose = null; face = null
        joiner.clear()
    }
}

package com.neurocapture.capturekit

import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.roundToInt

/** Pure statistics over frame timestamps (unit-tested on the JVM; no Android APIs). */
object FrameStats {
    const val NS_PER_S = 1_000_000_000L

    fun median(values: LongArray): Long? {
        if (values.isEmpty()) return null
        val s = values.sortedArray()
        val m = s.size / 2
        return if (s.size % 2 == 1) s[m] else (s[m - 1] + s[m]) / 2
    }

    /** Linear-interpolated percentile, p in 0..100. */
    fun percentile(values: DoubleArray, p: Double): Double? {
        if (values.isEmpty()) return null
        val s = values.sortedArray()
        val idx = (p / 100.0) * (s.size - 1)
        val lo = floor(idx).toInt()
        val hi = ceil(idx).toInt()
        return s[lo] + (s[hi] - s[lo]) * (idx - lo)
    }

    /** Spread of the sensor→canonical clock offset: p95 − p5, in milliseconds (DEV_PLAN §5.6). */
    fun offsetSpreadMs(offsetsNs: LongArray): Double? {
        if (offsetsNs.size < 2) return null
        val d = DoubleArray(offsetsNs.size) { offsetsNs[it].toDouble() }
        return (percentile(d, 95.0)!! - percentile(d, 5.0)!!) / 1e6
    }

    /** Number of frames in each complete 1-second window, starting at the first timestamp. */
    fun windowFps(ts: LongArray, count: Int = ts.size): IntArray {
        if (count < 2) return IntArray(0)
        val start = ts[0]
        val windows = ((ts[count - 1] - start) / NS_PER_S).toInt()
        val out = IntArray(windows)
        for (i in 0 until count) {
            val w = ((ts[i] - start) / NS_PER_S).toInt()
            if (w < windows) out[w]++
        }
        return out
    }

    /** Frames missing between consecutive timestamps (gaps longer than 1.5 frame intervals). */
    fun droppedFromIntervals(ts: LongArray, count: Int, targetFps: Int): Int {
        val expected = NS_PER_S.toDouble() / targetFps
        var dropped = 0
        for (i in 1 until count) {
            val dt = (ts[i] - ts[i - 1]).toDouble()
            if (dt > 1.5 * expected) dropped += (dt / expected).roundToInt() - 1
        }
        return dropped
    }

    data class Recording(
        val durationS: Double,
        val frameCount: Int,
        val effectiveFps: Double,
        val droppedFrames: Int,
        val droppedFrac: Double,
        val windowFpsMin: Int?,
    )

    /**
     * Recording statistics. Prefer the encoded MP4 frame count and duration when known (what was
     * actually recorded); otherwise fall back to the sensor timestamps of the capture session.
     */
    fun recording(sensorTs: LongArray, count: Int, targetFps: Int, mp4Frames: Int?, mp4DurationS: Double?): Recording {
        val windows = windowFps(sensorTs, count)
        val windowMin = windows.minOrNull()
        if (mp4Frames != null && mp4DurationS != null && mp4DurationS > 0) {
            val expected = (mp4DurationS * targetFps).roundToInt()
            val dropped = (expected - mp4Frames).coerceAtLeast(0)
            return Recording(mp4DurationS, mp4Frames, mp4Frames / mp4DurationS, dropped, if (expected > 0) dropped.toDouble() / expected else 0.0, windowMin)
        }
        if (count < 2) return Recording(0.0, count, 0.0, 0, 0.0, windowMin)
        val spanS = (sensorTs[count - 1] - sensorTs[0]).toDouble() / NS_PER_S
        val durationS = spanS + 1.0 / targetFps
        val dropped = droppedFromIntervals(sensorTs, count, targetFps)
        return Recording(durationS, count, count / durationS, dropped, dropped.toDouble() / (count + dropped), windowMin)
    }
}

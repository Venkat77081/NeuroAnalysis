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

    data class Recording(
        val durationS: Double,
        val frameCount: Int,
        val effectiveFps: Double,
        /** Frames actually lost: gaps in the capture timeline + captured frames missing from the MP4. */
        val droppedFrames: Int,
        val droppedFrac: Double,
        val windowFpsMin: Int?,
    )

    /** Median frame interval in ns (the camera's real frame period, e.g. 16.875 ms at "60" fps). */
    fun medianIntervalNs(ts: LongArray, count: Int): Long? {
        if (count < 2) return null
        return median(LongArray(count - 1) { ts[it + 1] - ts[it] })
    }

    /** Frames missing from the capture timeline: gaps longer than 1.5 × the median interval. */
    fun gapDrops(ts: LongArray, count: Int): Int {
        val m = medianIntervalNs(ts, count)?.toDouble() ?: return 0
        if (m <= 0) return 0
        var dropped = 0
        for (i in 1 until count) {
            val dt = (ts[i] - ts[i - 1]).toDouble()
            if (dt > 1.5 * m) dropped += (dt / m).roundToInt() - 1
        }
        return dropped
    }

    /**
     * Recording statistics over the frames inside the video's span. Duration and frame count come from
     * the MP4 when known. Dropped frames are real losses (decision 009), not the gap between the
     * nominal rate (60) and the camera's actual rate (e.g. 59.26).
     */
    fun recording(sensorTs: LongArray, count: Int, nominalFps: Int, mp4Frames: Int?, mp4DurationS: Double?): Recording {
        val windowMin = windowFps(sensorTs, count).minOrNull()
        val gaps = gapDrops(sensorTs, count)
        if (mp4Frames != null && mp4DurationS != null && mp4DurationS > 0) {
            val encoderLost = (count - mp4Frames).coerceAtLeast(0)
            val dropped = gaps + encoderLost
            return Recording(mp4DurationS, mp4Frames, mp4Frames / mp4DurationS, dropped, frac(dropped, mp4Frames + dropped), windowMin)
        }
        if (count < 2) return Recording(0.0, count, 0.0, 0, 0.0, windowMin)
        val period = medianIntervalNs(sensorTs, count)!!.toDouble()
        val durationS = ((sensorTs[count - 1] - sensorTs[0]) + period) / NS_PER_S
        return Recording(durationS, count, count / durationS, gaps, frac(gaps, count + gaps), windowMin)
    }

    private fun frac(a: Int, b: Int) = if (b > 0) a.toDouble() / b else 0.0
}

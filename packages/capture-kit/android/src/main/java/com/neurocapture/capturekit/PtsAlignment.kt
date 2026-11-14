package com.neurocapture.capturekit

import kotlin.math.abs

/**
 * Maps MP4 sample times (µs, relative to the first sample) to recorded camera frames (canonical ns),
 * DEV_PLAN §5.6. The first MP4 sample is anchored at frame record k; every sample is then matched to
 * the nearest logged frame in time, so one frame missing from either side affects one sample only.
 * k is chosen by fewest unmatched samples, then smallest worst residual; when several k fit equally
 * well (evenly spaced frames) the earliest is chosen and flagged (decisions 008, 009).
 */
object PtsAlignment {
    /** Offsets whose worst residual is within this of the best are equally good (a 1-frame shift is ≥ 16 ms off at a gap). */
    private const val TIE_MS = 1.0

    private class Fit(val k: Int, val unmatched: Int, val residuals: DoubleArray) {
        val max = residuals.maxOrNull() ?: 0.0
    }

    fun align(ptsUs: LongArray, canonicalNs: LongArray, maxShift: Int = 40): StreamFormat.Mp4Alignment? {
        if (ptsUs.isEmpty() || canonicalNs.isEmpty()) return null
        val pts = ptsUs.sortedArray()
        val p0 = pts[0]
        val c = DoubleArray(canonicalNs.size) { canonicalNs[it] / 1e6 } // ms
        val periodMs = (FrameStats.medianIntervalNs(canonicalNs, canonicalNs.size) ?: 16_666_667L) / 1e6
        val half = periodMs / 2
        val fits = ArrayList<Fit>()
        for (k in 0..minOf(maxShift, c.size - 1)) {
            val base = c[k]
            var i = k
            var unmatched = 0
            val res = ArrayList<Double>(pts.size)
            for (p in pts) {
                val t = base + (p - p0) / 1e3
                while (i + 1 < c.size && abs(c[i + 1] - t) <= abs(c[i] - t)) i++
                val r = abs(c[i] - t)
                if (r > half) unmatched++ else res.add(r)
            }
            fits.add(Fit(k, unmatched, res.toDoubleArray()))
        }
        val fewest = fits.minOf { it.unmatched }
        val candidates = fits.filter { it.unmatched == fewest }
        val bestMax = candidates.minOf { it.max }
        val ties = candidates.filter { it.max <= bestMax + TIE_MS }
        val chosen = ties.minBy { it.k }
        val anchor = if (ties.size == 1) "pattern" else "earliest_candidate"
        val p95 = FrameStats.percentile(chosen.residuals, 95.0) ?: 0.0
        return StreamFormat.Mp4Alignment(pts.size, chosen.k, chosen.max, p95, chosen.unmatched, anchor)
    }
}

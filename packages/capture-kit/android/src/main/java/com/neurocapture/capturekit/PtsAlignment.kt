package com.neurocapture.capturekit

import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min

/**
 * Maps MP4 sample times (µs, relative to the first sample) to recorded camera frames (canonical ns),
 * DEV_PLAN §5.6. MP4 sample j ↔ frame record j + k. k is chosen by matching the interval pattern;
 * when several k fit equally well (evenly spaced frames) the earliest is chosen and flagged (decision 008).
 */
object PtsAlignment {
    private const val TIE_MS = 0.5

    fun align(ptsUs: LongArray, canonicalNs: LongArray, maxShift: Int = 40): StreamFormat.Mp4Alignment? {
        if (ptsUs.isEmpty() || canonicalNs.isEmpty()) return null
        val pts = ptsUs.sortedArray()
        val p0 = pts[0]
        data class Cand(val k: Int, val mean: Double, val diffs: DoubleArray)
        val cands = ArrayList<Cand>()
        val minOverlap = min(pts.size, canonicalNs.size).coerceAtMost(30).coerceAtLeast(1)
        for (k in -maxShift..maxShift) {
            val j0 = max(0, -k)
            val j1 = min(pts.size, canonicalNs.size - k)
            if (j1 - j0 < minOverlap || j0 + k < 0) continue
            // Absolute model: sample j is at p0 + (pts[j] − p0) and frame j+k at c[j+k]; fit the single
            // constant offset c[k+j0] − p0 using sample j0, then measure every residual.
            val base = canonicalNs[j0 + k] / 1e6 - (pts[j0] - p0) / 1e3
            val diffs = DoubleArray(j1 - j0) { i ->
                val j = j0 + i
                abs(canonicalNs[j + k] / 1e6 - base - (pts[j] - p0) / 1e3)
            }
            cands.add(Cand(k, diffs.average(), diffs))
        }
        if (cands.isEmpty()) return null
        val bestMean = cands.minOf { it.mean }
        val ties = cands.filter { it.mean <= bestMean + TIE_MS }
        // Prefer the largest overlap among ties (covers all samples), then the earliest k ≥ its minimum.
        val chosen = ties.sortedWith(compareByDescending<Cand> { it.diffs.size }.thenBy { it.k }).first()
        val anchor = if (ties.count { it.diffs.size == chosen.diffs.size } == 1) "pattern" else "earliest_candidate"
        val p95 = FrameStats.percentile(chosen.diffs, 95.0) ?: 0.0
        return StreamFormat.Mp4Alignment(pts.size, chosen.k, chosen.diffs.maxOrNull() ?: 0.0, p95, anchor)
    }
}

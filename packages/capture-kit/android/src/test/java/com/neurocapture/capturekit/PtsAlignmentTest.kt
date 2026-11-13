package com.neurocapture.capturekit

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PtsAlignmentTest {
    private fun frameTimes(n: Int, fps: Int, gapsAt: Set<Int> = emptySet()): LongArray {
        val out = ArrayList<Long>()
        var t = 5_000_000_000L
        val step = 1e9 / fps
        var i = 0
        while (out.size < n) {
            if (i !in gapsAt) out.add(t + Math.round(i * step))
            i++
        }
        return out.toLongArray()
    }

    @Test fun findsTheFirstEncodedFrameFromAnIrregularPattern() {
        val canon = frameTimes(200, 60, gapsAt = setOf(17, 18, 55, 120))
        val k = 7 // encoder started at record 7
        val pts = LongArray(150) { (canon[it + k] - canon[k]) / 1000 }
        val a = PtsAlignment.align(pts, canon)!!
        assertEquals(7, a.firstRecordIndex)
        assertEquals("pattern", a.anchor)
        assertEquals(150, a.sampleCount)
        assertTrue("max diff ${a.maxAbsDiffMs}", a.maxAbsDiffMs < 0.01)
    }

    @Test fun flagsAmbiguousEvenlySpacedFrames() {
        val canon = frameTimes(120, 30)
        val pts = LongArray(100) { (canon[it + 3] - canon[3]) / 1000 }
        val a = PtsAlignment.align(pts, canon)!!
        assertEquals("earliest_candidate", a.anchor)
        assertTrue(a.maxAbsDiffMs < 0.01)
        assertEquals(0, a.firstRecordIndex)
    }

    @Test fun reportsTimingErrorsAndHandlesUnsortedSamples() {
        val canon = frameTimes(60, 60, gapsAt = setOf(10))
        val pts = LongArray(60) { (canon[it] - canon[0]) / 1000 }
        pts[30] += 3_000 // one sample 3 ms late
        pts.reverse()
        val a = PtsAlignment.align(pts, canon)!!
        assertEquals(0, a.firstRecordIndex)
        assertEquals(3.0, a.maxAbsDiffMs, 0.01)
        assertNull(PtsAlignment.align(LongArray(0), canon))
        assertNull(PtsAlignment.align(pts, LongArray(0)))
    }

    @Test fun countsLoggedFramesInsideTheVideoSpan() {
        val canon = frameTimes(100, 60) // log: 100 frames
        val pts = LongArray(80) { (canon[it + 5] - canon[5]) / 1000 } // video: records 5..84
        assertEquals(80, TakeFinalizer.framesInSpan(canon, 5, pts, 60))
        assertEquals(0, TakeFinalizer.framesInSpan(canon, 500, pts, 60))
    }
}

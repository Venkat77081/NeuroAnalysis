package com.neurocapture.capturekit

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class FrameStatsTest {
    private fun steady(fps: Int, seconds: Int, dropEvery: Int = 0): LongArray {
        // Exact frame times (rounded per frame), so frame `fps` lands at exactly +1 s.
        val out = ArrayList<Long>()
        for (i in 0 until fps * seconds) {
            if (dropEvery == 0 || i % dropEvery != dropEvery - 1) out.add(1_000L + Math.round(i * 1e9 / fps))
        }
        return out.toLongArray()
    }

    @Test fun medianAndPercentile() {
        assertEquals(3L, FrameStats.median(longArrayOf(5, 1, 3)))
        assertEquals(2L, FrameStats.median(longArrayOf(1, 3, 2, 2)))
        assertNull(FrameStats.median(LongArray(0)))
        assertEquals(5.5, FrameStats.percentile(doubleArrayOf(1.0, 10.0), 50.0)!!, 1e-9)
        assertNull(FrameStats.percentile(DoubleArray(0), 50.0))
    }

    @Test fun offsetSpread() {
        val offsets = LongArray(101) { 20_000_000L + it * 10_000L } // 20.0 .. 21.0 ms
        assertEquals(0.9, FrameStats.offsetSpreadMs(offsets)!!, 1e-6)
        assertNull(FrameStats.offsetSpreadMs(longArrayOf(1)))
    }

    @Test fun windowsAndGapDrops() {
        val ts = steady(60, 3)
        assertArrayEquals(intArrayOf(60, 60), FrameStats.windowFps(ts))
        assertEquals(0, FrameStats.gapDrops(ts, ts.size))
        val gappy = steady(60, 3, dropEvery = 30) // drops 2 per second
        assertEquals(5, FrameStats.gapDrops(gappy, gappy.size))
        assertEquals(0, FrameStats.windowFps(longArrayOf(1)).size)
        assertNull(FrameStats.medianIntervalNs(longArrayOf(1), 1))
    }

    @Test fun aSteadyCameraBelowTheNominalRateHasNoDrops() {
        // 59.26 fps sensor (16.875 ms) for 15 s: real rate below "60", but nothing is lost.
        val n = 889
        val ts = LongArray(n) { 1_000L + it * 16_875_000L }
        val r = FrameStats.recording(ts, n, 60, mp4Frames = n, mp4DurationS = n * 0.016875)
        assertEquals(0, r.droppedFrames)
        assertEquals(59.26, r.effectiveFps, 0.01)
    }

    @Test fun recordingCountsGapAndEncoderLosses() {
        val ts = steady(60, 10, dropEvery = 100) // slots 99, 199 … 599 missing: 5 interior gaps (599 is the end)
        val r = FrameStats.recording(ts, ts.size, 60, mp4Frames = ts.size - 2, mp4DurationS = 10.0)
        assertEquals(ts.size - 2, r.frameCount)
        assertEquals(5 + 2, r.droppedFrames)
        assertEquals(7.0 / (ts.size - 2 + 7), r.droppedFrac, 1e-9)
        assertEquals(59, r.windowFpsMin)
    }

    @Test fun recordingFallsBackToSensorTimestamps() {
        val ts = steady(30, 4)
        val r = FrameStats.recording(ts, ts.size, 30, null, null)
        assertEquals(4.0, r.durationS, 1e-3)
        assertEquals(30.0, r.effectiveFps, 1e-2)
        assertEquals(0, r.droppedFrames)
        val empty = FrameStats.recording(LongArray(0), 0, 30, null, null)
        assertEquals(0.0, empty.effectiveFps, 0.0)
    }

    @Test fun timestampLogGrowsAndSnapshots() {
        val log = TimestampLog(initial = 2)
        for (i in 0 until 5) log.add(i.toLong(), 100L + i, 200L + i)
        assertEquals(5, log.size)
        assertArrayEquals(longArrayOf(100, 101, 102, 103, 104), log.sensorSnapshot())
        assertArrayEquals(longArrayOf(200, 201, 202, 203, 204), log.canonicalSnapshot())
        assertArrayEquals(longArrayOf(0, 1, 2, 3, 4), log.frameNumberSnapshot())
    }
}

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

    @Test fun windowsAndDrops() {
        val ts = steady(60, 3)
        assertArrayEquals(intArrayOf(60, 60), FrameStats.windowFps(ts))
        assertEquals(0, FrameStats.droppedFromIntervals(ts, ts.size, 60))
        val gappy = steady(60, 3, dropEvery = 30) // drops 2 per second
        assertEquals(5, FrameStats.droppedFromIntervals(gappy, gappy.size, 60))
        assertEquals(0, FrameStats.windowFps(longArrayOf(1)).size)
    }

    @Test fun recordingPrefersMp4Counts() {
        val ts = steady(60, 10)
        val r = FrameStats.recording(ts, ts.size, 60, mp4Frames = 597, mp4DurationS = 10.0)
        assertEquals(597, r.frameCount)
        assertEquals(59.7, r.effectiveFps, 1e-9)
        assertEquals(3, r.droppedFrames)
        assertEquals(0.005, r.droppedFrac, 1e-9)
        assertEquals(60, r.windowFpsMin)
    }

    @Test fun recordingFallsBackToSensorTimestamps() {
        val ts = steady(30, 4)
        val r = FrameStats.recording(ts, ts.size, 30, null, null)
        assertEquals(4.0, r.durationS, 1e-6)
        assertEquals(30.0, r.effectiveFps, 1e-6)
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

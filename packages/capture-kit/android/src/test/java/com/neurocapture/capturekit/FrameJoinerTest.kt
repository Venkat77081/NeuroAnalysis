package com.neurocapture.capturekit

import org.junit.Assert.assertEquals
import org.junit.Test

class FrameJoinerTest {
    @Test fun emitsWhenAllTrackersReported() {
        val out = ArrayList<Pair<Long, Map<String, String?>>>()
        val j = FrameJoiner<String>(setOf("hand", "pose")) { ts, m -> out.add(ts to m) }
        j.offer(10, "hand", "h10")
        assertEquals(0, out.size)
        j.offer(10, "face", "ignored") // not enabled
        j.offer(10, "pose", null) // ran, found nothing
        assertEquals(listOf(10L to mapOf("hand" to "h10", "pose" to null)), out)
    }

    @Test fun flushesOlderIncompleteFramesInOrder() {
        val out = ArrayList<Long>()
        val missing = ArrayList<Map<String, String?>>()
        val j = FrameJoiner<String>(setOf("hand", "pose")) { ts, m -> out.add(ts); missing.add(m) }
        j.offer(1, "hand", "a") // pose never reports for frame 1
        j.offer(2, "hand", "b")
        j.offer(2, "pose", "c")
        assertEquals(listOf(1L, 2L), out)
        assertEquals(mapOf("hand" to "a"), missing[0]) // pose dropped: absent, not null
    }

    @Test fun boundsPendingFrames() {
        val out = ArrayList<Long>()
        val j = FrameJoiner<Int>(setOf("hand", "pose")) { ts, _ -> out.add(ts) }
        for (i in 0L until 12L) j.offer(i, "hand", 1)
        assertEquals((0L until 4L).toList(), out)
        j.clear()
        j.offer(99, "pose", 1)
        assertEquals(4, out.size)
    }
}

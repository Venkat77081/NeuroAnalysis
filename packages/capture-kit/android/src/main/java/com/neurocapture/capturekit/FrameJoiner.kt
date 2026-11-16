package com.neurocapture.capturekit

/**
 * Joins asynchronous tracker results that belong to one camera frame (MediaPipe live-stream mode
 * calls each landmarker's listener separately). A frame is emitted when every enabled tracker has
 * reported, or — if one never does — when a newer frame completes. Trackers that never reported
 * (MediaPipe drops frames when busy) are ABSENT from the emitted map, so callers can tell
 * "dropped" (unknown) from "ran and found nothing" (null). Thread-safe; pure (JVM-tested).
 */
class FrameJoiner<T>(private val trackers: Set<String>, private val emit: (Long, Map<String, T?>) -> Unit) {
    private val pending = sortedMapOf<Long, MutableMap<String, T?>>()

    @Synchronized
    fun offer(frameMs: Long, tracker: String, result: T?) {
        if (tracker !in trackers) return
        val slot = pending.getOrPut(frameMs) { mutableMapOf() }
        slot[tracker] = result
        if (slot.keys.containsAll(trackers)) {
            // Older incomplete frames will never complete: flush them first, in order.
            val older = pending.headMap(frameMs).entries.toList()
            older.forEach { (ts, m) -> emit(ts, m.toMap()); pending.remove(ts) }
            pending.remove(frameMs)
            emit(frameMs, slot)
        }
        while (pending.size > MAX_PENDING) {
            val first = pending.firstKey()
            emit(first, pending[first]!!.toMap())
            pending.remove(first)
        }
    }

    @Synchronized
    fun clear() = pending.clear()

    companion object {
        const val MAX_PENDING = 8
    }
}

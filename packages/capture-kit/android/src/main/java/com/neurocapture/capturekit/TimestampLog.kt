package com.neurocapture.capturekit

/**
 * Per-frame timestamps of the capture session while recording (DEV_PLAN §5.6).
 * Written as frames.bin by [StreamFormat] (contracts/stream-header.schema.json).
 */
class TimestampLog(initial: Int = 4096) {
    private var frameNumbers = LongArray(initial)
    private var sensor = LongArray(initial)
    private var canonical = LongArray(initial)
    var size = 0
        private set

    @Synchronized
    fun add(frameNumber: Long, sensorTsNs: Long, canonicalTsNs: Long) {
        if (size == sensor.size) {
            val n = size * 2
            frameNumbers = frameNumbers.copyOf(n)
            sensor = sensor.copyOf(n)
            canonical = canonical.copyOf(n)
        }
        frameNumbers[size] = frameNumber
        sensor[size] = sensorTsNs
        canonical[size] = canonicalTsNs
        size++
    }

    @Synchronized
    fun sensorSnapshot(): LongArray = sensor.copyOf(size)

    @Synchronized
    fun canonicalSnapshot(): LongArray = canonical.copyOf(size)

    @Synchronized
    fun frameNumberSnapshot(): LongArray = frameNumbers.copyOf(size)
}

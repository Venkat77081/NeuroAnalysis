package com.neurocapture.capturekit

import java.io.BufferedOutputStream
import java.io.File
import java.io.FileOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * Per-frame timestamps of the capture session while recording (DEV_PLAN §5.6).
 * frames.bin layout (M1, little-endian): repeated { int64 frameNumber, int64 sensorTsNs, int64 canonicalTsNs }.
 * M2 adds the header/contract and encryption.
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
    fun writeTo(file: File) {
        file.parentFile?.mkdirs()
        BufferedOutputStream(FileOutputStream(file)).use { out ->
            val buf = ByteBuffer.allocate(24).order(ByteOrder.LITTLE_ENDIAN)
            for (i in 0 until size) {
                buf.clear()
                buf.putLong(frameNumbers[i]).putLong(sensor[i]).putLong(canonical[i])
                out.write(buf.array())
            }
        }
    }
}

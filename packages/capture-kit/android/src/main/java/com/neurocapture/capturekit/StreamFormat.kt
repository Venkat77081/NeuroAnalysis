package com.neurocapture.capturekit

import java.io.OutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.Locale

/**
 * Writer for frames.bin / sensors.bin (contracts/stream-header.schema.json). Byte-for-byte compatible
 * with the TypeScript codec (packages/capture-kit/src/streams.ts); verified against
 * contracts/tests/golden/*.bin in StreamFormatTest. Header JSON is built by hand (fixed key order) so the
 * bytes do not depend on a JSON library.
 */
object StreamFormat {
    const val RECORD_SIZE = 24

    data class Mp4Alignment(
        val sampleCount: Int,
        val firstRecordIndex: Int,
        val maxAbsDiffMs: Double,
        val p95AbsDiffMs: Double,
        val anchor: String, // "pattern" | "earliest_candidate"
    )

    private fun str(s: String) = "\"" + s.replace("\\", "\\\\").replace("\"", "\\\"") + "\""

    /** Shortest round-trip decimal for small positive numbers, 3 decimals max (matches JSON.stringify). */
    fun num(d: Double): String {
        val r = Math.round(d * 1000) / 1000.0
        if (r == Math.floor(r) && !r.isInfinite()) return r.toLong().toString()
        return String.format(Locale.ROOT, "%.3f", r).trimEnd('0')
    }

    fun framesHeader(takeId: String, clockSource: String, offsetNs: Long?, targetFps: Int, actualFps: Int, mp4: Mp4Alignment?): String {
        val m = if (mp4 == null) "null" else "{\"sampleCount\":${mp4.sampleCount},\"firstRecordIndex\":${mp4.firstRecordIndex}," +
            "\"maxAbsDiffMs\":${num(mp4.maxAbsDiffMs)},\"p95AbsDiffMs\":${num(mp4.p95AbsDiffMs)},\"anchor\":${str(mp4.anchor)}}"
        return "{\"schemaVersion\":\"1.0.0\",\"stream\":\"frames\",\"takeId\":${str(takeId)},\"clockSource\":${str(clockSource)}," +
            "\"timestampSemantics\":\"capture_session_frame_sensor_and_canonical_elapsed_realtime_ns\"," +
            "\"offsetNs\":${if (offsetNs == null) "null" else str(offsetNs.toString())},\"recordSize\":24," +
            "\"fields\":[{\"name\":\"frameNumber\",\"type\":\"int64\"},{\"name\":\"sensorTsNs\",\"type\":\"int64\"},{\"name\":\"canonicalTsNs\",\"type\":\"int64\"}]," +
            "\"targetFps\":$targetFps,\"actualFps\":$actualFps,\"mp4\":$m}"
    }

    fun sensorsHeader(takeId: String, clockSource: String): String =
        "{\"schemaVersion\":\"1.0.0\",\"stream\":\"sensors\",\"takeId\":${str(takeId)},\"clockSource\":${str(clockSource)}," +
            "\"timestampSemantics\":\"sensor_event_elapsed_realtime_ns\",\"recordSize\":24," +
            "\"fields\":[{\"name\":\"type\",\"type\":\"uint8\"},{\"name\":\"_\",\"type\":\"pad3\"},{\"name\":\"tsNs\",\"type\":\"int64\"}," +
            "{\"name\":\"x\",\"type\":\"float32\"},{\"name\":\"y\",\"type\":\"float32\"},{\"name\":\"z\",\"type\":\"float32\"}]," +
            "\"sensorTypes\":{\"1\":\"gyro\",\"2\":\"gravity\"}}"

    private fun envelope(out: OutputStream, magic: String, headerJson: String) {
        val h = headerJson.toByteArray(Charsets.UTF_8)
        out.write(magic.toByteArray(Charsets.US_ASCII))
        out.write(ByteBuffer.allocate(4).order(ByteOrder.LITTLE_ENDIAN).putInt(h.size).array())
        out.write(h)
    }

    fun writeFrames(out: OutputStream, headerJson: String, frameNumbers: LongArray, sensorTs: LongArray, canonicalTs: LongArray) {
        envelope(out, "NCFR", headerJson)
        val buf = ByteBuffer.allocate(RECORD_SIZE).order(ByteOrder.LITTLE_ENDIAN)
        for (i in sensorTs.indices) {
            buf.clear()
            buf.putLong(frameNumbers[i]).putLong(sensorTs[i]).putLong(canonicalTs[i])
            out.write(buf.array())
        }
    }

    fun writeSensors(out: OutputStream, headerJson: String, log: SensorLog) {
        envelope(out, "NCSE", headerJson)
        val buf = ByteBuffer.allocate(RECORD_SIZE).order(ByteOrder.LITTLE_ENDIAN)
        log.read { types, ts, x, y, z, n ->
            for (i in 0 until n) {
                buf.clear()
                buf.put(types[i]).put(0).put(0).put(0).putLong(ts[i]).putFloat(x[i]).putFloat(y[i]).putFloat(z[i])
                out.write(buf.array())
            }
        }
    }
}

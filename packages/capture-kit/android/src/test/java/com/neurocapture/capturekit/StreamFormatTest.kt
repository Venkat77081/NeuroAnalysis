package com.neurocapture.capturekit

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Test
import java.io.ByteArrayOutputStream

/** The Kotlin writer must reproduce the golden files in contracts/tests/golden (written by the TS codec) byte for byte. */
class StreamFormatTest {
    private fun headerOf(bytes: ByteArray): String {
        val len = (bytes[4].toInt() and 0xFF) or ((bytes[5].toInt() and 0xFF) shl 8) or
            ((bytes[6].toInt() and 0xFF) shl 16) or ((bytes[7].toInt() and 0xFF) shl 24)
        return String(bytes, 8, len, Charsets.UTF_8)
    }

    @Test fun framesMatchGolden() {
        val golden = RepoFiles.find("contracts/tests/golden/frames-1.0.0.bin").readBytes()
        val header = StreamFormat.framesHeader(
            "golden", "REALTIME", null, 60, 60,
            StreamFormat.Mp4Alignment(3, 1, 0.2, 0.1, 0, "pattern"),
        )
        assertEquals(headerOf(golden), header)
        val out = ByteArrayOutputStream()
        StreamFormat.writeFrames(
            out, header,
            longArrayOf(0, 1, 2, 3),
            longArrayOf(1_000_000_000, 1_016_666_667, 1_033_333_333, 1_050_000_000),
            longArrayOf(1_000_000_000, 1_016_666_667, 1_033_333_333, 1_050_000_000),
        )
        assertArrayEquals(golden, out.toByteArray())
    }

    @Test fun sensorsMatchGolden() {
        val golden = RepoFiles.find("contracts/tests/golden/sensors-1.0.0.bin").readBytes()
        val header = StreamFormat.sensorsHeader("golden", "REALTIME")
        assertEquals(headerOf(golden), header)
        val log = SensorLog(initial = 1)
        log.add(SensorLog.GYRO, 1_000_000_000, 0.001f, -0.002f, 0.003f)
        log.add(SensorLog.GRAVITY, 1_005_000_000, 0.05f, 9.79f, 0.3f)
        val out = ByteArrayOutputStream()
        StreamFormat.writeSensors(out, header, log)
        assertArrayEquals(golden, out.toByteArray())
    }

    @Test fun numbersFormatLikeJsonStringify() {
        assertEquals("0", StreamFormat.num(0.0))
        assertEquals("2", StreamFormat.num(2.0))
        assertEquals("0.2", StreamFormat.num(0.2))
        assertEquals("1.235", StreamFormat.num(1.23456))
        assertEquals("{\"schemaVersion\":\"1.0.0\"", StreamFormat.framesHeader("t", "UNKNOWN", -5, 60, 30, null).substring(0, 24))
        assertEquals(true, StreamFormat.framesHeader("t", "UNKNOWN", -5, 60, 30, null).contains("\"offsetNs\":\"-5\""))
    }
}

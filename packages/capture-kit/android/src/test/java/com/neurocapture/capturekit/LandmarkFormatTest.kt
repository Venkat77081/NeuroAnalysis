package com.neurocapture.capturekit

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Test
import java.io.ByteArrayOutputStream

/** The Kotlin writer must reproduce the golden landmarks.bin written by the TS codec. */
class LandmarkFormatTest {
    private fun fill(n: Int, f: (Int) -> Float) = FloatArray(n) { f(it) }

    @Test fun matchesGolden() {
        val golden = RepoFiles.find("contracts/tests/golden/landmarks-1.0.0.bin").readBytes()
        val out = ByteArrayOutputStream()
        val header = LandmarkFormat.header("golden", "portrait", false, "REALTIME", listOf("hand", "pose", "face"))
        LandmarkFormat.writeHeader(out, header)
        LandmarkFormat.writeRecord(
            out,
            LandmarkFormat.Record(
                2_000_000_000L, 0, 1, 0, 0, 128f, 0.25f, 230.5f, null,
                listOf(LandmarkFormat.Hand(false, 0.75f, fill(84) { (it % 7) * 0.125f })), null, null,
            ),
        )
        LandmarkFormat.writeRecord(
            out,
            LandmarkFormat.Record(
                2_033_333_333L, 1, 2, 1, 1, 100.5f, 0f, 12f, 0.875f, emptyList(),
                fill(132) { (it % 5) * 0.25f },
                LandmarkFormat.Face(1.5f, -2.25f, 0.5f, fill(1434) { (it % 9) * 0.0625f }, fill(52) { it / 64f }),
            ),
        )
        val len = (golden[4].toInt() and 0xFF) or ((golden[5].toInt() and 0xFF) shl 8)
        assertEquals(String(golden, 8, len, Charsets.UTF_8), header)
        assertArrayEquals(golden, out.toByteArray())
    }
}

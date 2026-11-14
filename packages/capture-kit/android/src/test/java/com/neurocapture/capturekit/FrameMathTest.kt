package com.neurocapture.capturekit

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.nio.ByteBuffer
import kotlin.math.cos
import kotlin.math.sin

class FrameMathTest {
    /** Column-major 4×4 of Rz(roll)·Ry(yaw)·Rx(pitch). */
    private fun matrix(yawDeg: Double, pitchDeg: Double, rollDeg: Double): FloatArray {
        val y = Math.toRadians(yawDeg); val p = Math.toRadians(pitchDeg); val r = Math.toRadians(rollDeg)
        val rx = arrayOf(doubleArrayOf(1.0, 0.0, 0.0), doubleArrayOf(0.0, cos(p), -sin(p)), doubleArrayOf(0.0, sin(p), cos(p)))
        val ry = arrayOf(doubleArrayOf(cos(y), 0.0, sin(y)), doubleArrayOf(0.0, 1.0, 0.0), doubleArrayOf(-sin(y), 0.0, cos(y)))
        val rz = arrayOf(doubleArrayOf(cos(r), -sin(r), 0.0), doubleArrayOf(sin(r), cos(r), 0.0), doubleArrayOf(0.0, 0.0, 1.0))
        fun mul(a: Array<DoubleArray>, b: Array<DoubleArray>) = Array(3) { i -> DoubleArray(3) { j -> (0..2).sumOf { a[i][it] * b[it][j] } } }
        val m = mul(mul(rz, ry), rx)
        val out = FloatArray(16)
        for (row in 0..2) for (col in 0..2) out[col * 4 + row] = m[row][col].toFloat()
        out[15] = 1f
        return out
    }

    @Test fun recoversFaceAngles() {
        val a = FrameMath.faceAngles(matrix(20.0, -10.0, 5.0))
        assertEquals(20f, a.yawDeg, 0.01f)
        assertEquals(-10f, a.pitchDeg, 0.01f)
        assertEquals(5f, a.rollDeg, 0.01f)
        val z = FrameMath.faceAngles(matrix(0.0, 0.0, 0.0))
        assertEquals(0f, z.yawDeg, 1e-4f)
    }

    private fun image(w: Int, h: Int, f: (Int, Int) -> Int): ByteBuffer {
        val b = ByteBuffer.allocate(w * h * 4)
        for (y in 0 until h) for (x in 0 until w) {
            val v = f(x, y).toByte()
            b.put(v).put(v).put(v).put(255.toByte())
        }
        return b
    }

    @Test fun brightnessClippingAndSharpness() {
        val flat = FrameMath.stats(image(64, 64) { _, _ -> 128 }, 64, 64, 256)
        assertEquals(128f, flat.lumaMean, 1f)
        assertEquals(0f, flat.clippedFrac, 0f)
        assertEquals(0f, flat.sharpness, 0.001f)
        val checker = FrameMath.stats(image(64, 64) { x, y -> if ((x + y) % 2 == 0) 255 else 0 }, 64, 64, 256)
        assertTrue("checkerboard is sharp", checker.sharpness > 1000f)
        assertEquals(1f, checker.clippedFrac, 0.01f)
    }

    @Test fun faceLightBalance() {
        val img = image(100, 100) { x, _ -> if (x < 50) 200 else 100 }
        val face = floatArrayOf(0.2f, 0.2f, 0f, 0.8f, 0.8f, 0f) // box 20..80
        assertEquals(2f, FrameMath.faceLumaRatio(img, 100, 100, 400, face)!!, 0.05f)
        assertNull(FrameMath.faceLumaRatio(img, 100, 100, 400, floatArrayOf(0.5f, 0.5f, 0f)))
        assertNull(FrameMath.faceLumaRatio(image(10, 10) { _, _ -> 0 }, 10, 10, 40, floatArrayOf(0f, 0f, 0f, 1f, 1f, 0f)))
    }
}

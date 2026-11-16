package com.neurocapture.capturekit

import java.nio.ByteBuffer
import kotlin.math.asin
import kotlin.math.atan2

/** Pure image/geometry helpers for the analysis stage (JVM-tested). */
object FrameMath {
    data class Angles(val yawDeg: Float, val pitchDeg: Float, val rollDeg: Float)

    /**
     * Yaw/pitch/roll in degrees from MediaPipe's 4×4 facial transformation matrix (column-major).
     * R = Rz(roll)·Ry(yaw)·Rx(pitch): yaw = asin(−r20), pitch = atan2(r21, r22), roll = atan2(r10, r00).
     */
    fun faceAngles(m: FloatArray): Angles {
        fun r(row: Int, col: Int) = m[col * 4 + row].toDouble()
        val yaw = asin((-r(2, 0)).coerceIn(-1.0, 1.0))
        val pitch = atan2(r(2, 1), r(2, 2))
        val roll = atan2(r(1, 0), r(0, 0))
        return Angles(Math.toDegrees(yaw).toFloat(), Math.toDegrees(pitch).toFloat(), Math.toDegrees(roll).toFloat())
    }

    /** Luma (BT.601) of an RGBA pixel. */
    private fun luma(buf: ByteBuffer, i: Int): Int {
        val r = buf.get(i).toInt() and 0xFF
        val g = buf.get(i + 1).toInt() and 0xFF
        val b = buf.get(i + 2).toInt() and 0xFF
        return (77 * r + 150 * g + 29 * b) shr 8
    }

    data class Stats(val lumaMean: Float, val clippedFrac: Float, val sharpness: Float)

    /**
     * Mean luma and clipped fraction over the frame (every 8th pixel), and Laplacian variance over the
     * central 50 % (every 2nd pixel) of an RGBA image (DEV_PLAN §9.2 brightness, sharpness).
     */
    fun stats(buf: ByteBuffer, w: Int, h: Int, rowStride: Int): Stats {
        val arr = ByteArray(rowStride * (h - 1) + w * 4)
        buf.position(0)
        buf.get(arr, 0, minOf(arr.size, buf.remaining()))
        buf.position(0)
        return stats(arr, w, h, rowStride)
    }

    /**
     * Same statistics on a byte array (fast path for the analysis thread: ByteBuffer.get(index)
     * per pixel cost ~50 ms per frame on the first device, decision 016).
     */
    fun stats(px: ByteArray, w: Int, h: Int, rowStride: Int): Stats {
        fun luma(i: Int): Int =
            (77 * (px[i].toInt() and 0xFF) + 150 * (px[i + 1].toInt() and 0xFF) + 29 * (px[i + 2].toInt() and 0xFF)) shr 8
        var sum = 0L
        var n = 0
        var clipped = 0
        var y = 0
        while (y < h) {
            var x = 0
            while (x < w) {
                val l = luma(y * rowStride + x * 4)
                sum += l
                if (l <= 2 || l >= 253) clipped++
                n++
                x += 8
            }
            y += 8
        }
        var s = 0.0
        var s2 = 0.0
        var m = 0
        fun p(xx: Int, yy: Int) = luma(yy * rowStride + xx * 4)
        y = maxOf(h / 4, 1)
        while (y < minOf(h * 3 / 4, h - 1)) {
            var x = maxOf(w / 4, 1)
            while (x < minOf(w * 3 / 4, w - 1)) {
                val lap = (p(x - 1, y) + p(x + 1, y) + p(x, y - 1) + p(x, y + 1) - 4 * p(x, y)).toDouble()
                s += lap; s2 += lap * lap; m++
                x += 2
            }
            y += 2
        }
        val variance = if (m > 0) s2 / m - (s / m) * (s / m) else 0.0
        return Stats(if (n > 0) sum.toFloat() / n else 0f, if (n > 0) clipped.toFloat() / n else 0f, variance.toFloat())
    }

    /**
     * Mean luma of the left half of the face box over the right half (image coordinates), for the
     * face_light_balance check (§9.2). Box from normalized face landmarks (x, y, z triples). Null when
     * the box is empty or a half is black.
     */
    fun faceLumaRatio(buf: ByteBuffer, w: Int, h: Int, rowStride: Int, facePts: FloatArray): Float? {
        var minX = 1f; var maxX = 0f; var minY = 1f; var maxY = 0f
        var i = 0
        while (i + 2 < facePts.size) {
            minX = minOf(minX, facePts[i]); maxX = maxOf(maxX, facePts[i])
            minY = minOf(minY, facePts[i + 1]); maxY = maxOf(maxY, facePts[i + 1])
            i += 3
        }
        val x0 = (minX.coerceIn(0f, 1f) * w).toInt(); val x1 = (maxX.coerceIn(0f, 1f) * w).toInt()
        val y0 = (minY.coerceIn(0f, 1f) * h).toInt(); val y1 = (maxY.coerceIn(0f, 1f) * h).toInt()
        if (x1 - x0 < 4 || y1 - y0 < 4) return null
        val mid = (x0 + x1) / 2
        var l = 0L; var ln = 0; var r = 0L; var rn = 0
        var y = y0
        while (y < y1) {
            var x = x0
            while (x < x1) {
                val v = luma(buf, y * rowStride + x * 4)
                if (x < mid) { l += v; ln++ } else { r += v; rn++ }
                x += 2
            }
            y += 2
        }
        if (ln == 0 || rn == 0 || r == 0L) return null
        return (l.toFloat() / ln) / (r.toFloat() / rn)
    }
}

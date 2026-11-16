package com.neurocapture.capturekit

import java.io.OutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * landmarks.bin writer, layout NCLM-v1 (contracts/landmarks-header.schema.json). Byte-for-byte
 * compatible with the TypeScript codec (packages/capture-kit/src/landmarks.ts); checked against the
 * golden file in LandmarkFormatTest. Records keep MediaPipe's raw handedness label (decision 012).
 */
object LandmarkFormat {
    const val HAND_VALUES = 21 * 4
    const val POSE_VALUES = 33 * 4
    const val FACE_VALUES = 478 * 3
    const val BLEND_VALUES = 52

    class Hand(val labelRight: Boolean, val score: Float, val pts: FloatArray)
    class Face(val yaw: Float, val pitch: Float, val roll: Float, val pts: FloatArray, val blend: FloatArray?)

    class Record(
        val tsNs: Long,
        val seq: Int,
        /** 0 off, 1 ok, 2 no_result, 3 error */
        val handStatus: Int,
        val poseStatus: Int,
        val faceStatus: Int,
        val lumaMean: Float,
        val clippedFrac: Float,
        val sharpness: Float,
        val faceLumaRatio: Float?,
        val hands: List<Hand>,
        val pose: FloatArray?,
        val face: Face?,
    ) {
        fun bodySize(): Int {
            var n = 8 + 4 + 4 + 16
            n += hands.size * (8 + HAND_VALUES * 4)
            if (pose != null) n += POSE_VALUES * 4
            if (face != null) n += 12 + FACE_VALUES * 4 + (if (face.blend != null) BLEND_VALUES * 4 else 0)
            return n
        }
    }

    data class TrackerInfo(val name: String, val modelVersion: String, val points: Int, val values: Int)

    val TRACKERS = mapOf(
        "hand" to TrackerInfo("hand", "hand_landmarker/float16/1", 21, 4),
        "pose" to TrackerInfo("pose", "pose_landmarker_lite/float16/1", 33, 4),
        "face" to TrackerInfo("face", "face_landmarker/float16/1", 478, 3),
    )

    private fun str(s: String) = "\"" + s.replace("\\", "\\\\").replace("\"", "\\\"") + "\""

    fun header(
        takeId: String, orientation: String, mirrored: Boolean, clockSource: String, trackers: List<String>,
        imageW: Int = 0, imageH: Int = 0,
    ): String {
        val ts = trackers.mapNotNull { TRACKERS[it] }.joinToString(",") {
            "{\"name\":${str(it.name)},\"modelVersion\":${str(it.modelVersion)},\"pointsPerFrame\":${it.points},\"valuesPerPoint\":${it.values}}"
        }
        return "{\"schemaVersion\":\"1.0.0\",\"layout\":\"NCLM-v1\",\"takeId\":${str(takeId)}," +
            "\"coordinateSystem\":\"normalized_upright_analysis_frame\",\"orientation\":${str(orientation)}," +
            "\"mirrored\":$mirrored,\"imageMirrored\":false,\"handednessLabels\":\"mediapipe_raw\"," +
            "\"timestampSemantics\":\"camera_frame_canonical_elapsed_realtime_ns\",\"clockSource\":${str(clockSource)}," +
            "\"record\":{\"endianness\":\"little\",\"dtype\":\"float32\"},\"trackers\":[$ts]" +
            (if (imageW > 0 && imageH > 0) ",\"image\":{\"w\":$imageW,\"h\":$imageH}}" else "}")
    }

    fun writeHeader(out: OutputStream, headerJson: String) {
        val h = headerJson.toByteArray(Charsets.UTF_8)
        out.write("NCLM".toByteArray(Charsets.US_ASCII))
        out.write(ByteBuffer.allocate(4).order(ByteOrder.LITTLE_ENDIAN).putInt(h.size).array())
        out.write(h)
    }

    fun writeRecord(out: OutputStream, r: Record) {
        val body = r.bodySize()
        val b = ByteBuffer.allocate(4 + body).order(ByteOrder.LITTLE_ENDIAN)
        b.putInt(body)
        b.putLong(r.tsNs).putInt(r.seq)
        b.put((r.handStatus or (r.poseStatus shl 2) or (r.faceStatus shl 4)).toByte())
        b.put(r.hands.size.toByte())
        b.put(((if (r.pose != null) 1 else 0) or (if (r.face != null) 2 else 0) or (if (r.face?.blend != null) 4 else 0)).toByte())
        b.put(0)
        b.putFloat(r.lumaMean).putFloat(r.clippedFrac).putFloat(r.sharpness).putFloat(r.faceLumaRatio ?: Float.NaN)
        for (h in r.hands) {
            b.put(if (h.labelRight) 1 else 0).put(0).put(0).put(0).putFloat(h.score)
            h.pts.forEach { b.putFloat(it) }
        }
        r.pose?.forEach { b.putFloat(it) }
        r.face?.let { f ->
            b.putFloat(f.yaw).putFloat(f.pitch).putFloat(f.roll)
            f.pts.forEach { b.putFloat(it) }
            f.blend?.forEach { b.putFloat(it) }
        }
        out.write(b.array())
    }
}

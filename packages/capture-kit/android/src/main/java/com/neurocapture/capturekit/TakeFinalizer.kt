package com.neurocapture.capturekit

import android.media.MediaExtractor
import android.media.MediaFormat
import android.media.MediaMetadataRetriever
import com.getcapacitor.JSObject
import org.json.JSONObject
import java.io.File

/**
 * Runs after every take on the recording thread (never waits on JS): MP4 ↔ frame alignment,
 * encrypted frames.bin / sensors.bin, encrypted video (plaintext deleted), verification (DEV_PLAN M2).
 */
object TakeFinalizer {
    /** Presentation times (µs) of all video samples, in file order. */
    fun mp4SampleTimesUs(file: File): LongArray? {
        val ex = MediaExtractor()
        return try {
            ex.setDataSource(file.absolutePath)
            val track = (0 until ex.trackCount).firstOrNull {
                ex.getTrackFormat(it).getString(MediaFormat.KEY_MIME)?.startsWith("video/") == true
            } ?: return null
            ex.selectTrack(track)
            val out = ArrayList<Long>(2048)
            while (true) {
                val t = ex.sampleTime
                if (t < 0) break
                out.add(t)
                if (!ex.advance()) break
            }
            out.toLongArray()
        } catch (_: Exception) {
            null
        } finally {
            ex.release()
        }
    }

    /** Logged frames whose time falls inside the MP4's span (first..last sample, ± half a frame). */
    fun framesInSpan(canonicalNs: LongArray, firstIndex: Int, ptsUs: LongArray, fps: Int): Int {
        if (firstIndex !in canonicalNs.indices || ptsUs.isEmpty()) return 0
        val sorted = ptsUs.sortedArray()
        val half = 500_000_000L / fps
        val start = canonicalNs[firstIndex] - half
        val end = canonicalNs[firstIndex] + (sorted.last() - sorted.first()) * 1000 + half
        return canonicalNs.count { it in start..end }
    }

    private fun isPlayable(file: File): Boolean {
        val mmr = MediaMetadataRetriever()
        return try {
            mmr.setDataSource(file.absolutePath)
            mmr.extractMetadata(MediaMetadataRetriever.METADATA_KEY_HAS_VIDEO) == "yes"
        } catch (_: Exception) {
            false
        } finally {
            mmr.release()
        }
    }

    fun finalize(
        vault: TakeVault,
        o: CameraSession.Outcome,
        targetFps: Int,
        timestampRealtime: Boolean,
        offsetNs: Long?,
        sensorClockOffsetMs: Double?,
    ): JSObject {
        val takeId = o.takeId
        val canonical = o.log.canonicalSnapshot()
        val sensor = o.log.sensorSnapshot()
        val pts = if (o.file.exists()) mp4SampleTimesUs(o.file) else null
        val alignment = pts?.let { PtsAlignment.align(it, canonical) }
        // Count only frames from the first encoded one, so pre-start frames do not skew the stats.
        val from = (alignment?.firstRecordIndex ?: 0).coerceIn(0, sensor.size)
        val window = sensor.copyOfRange(from, sensor.size)
        val stats = FrameStats.recording(window, window.size, o.actualFps, o.mp4Frames ?: pts?.size, o.mp4DurationS)
        val inSpan = if (alignment != null && pts != null) framesInSpan(canonical, alignment.firstRecordIndex, pts, o.actualFps) else null

        val clock = if (timestampRealtime) "REALTIME" else "UNKNOWN"
        vault.openEncrypting(takeId, "frames.bin").use { out ->
            StreamFormat.writeFrames(
                out,
                StreamFormat.framesHeader(takeId, clock, if (timestampRealtime) null else offsetNs, targetFps, o.actualFps, alignment),
                o.log.frameNumberSnapshot(), sensor, canonical,
            )
        }
        vault.openEncrypting(takeId, "sensors.bin").use { out ->
            StreamFormat.writeSensors(out, StreamFormat.sensorsHeader(takeId, "REALTIME"), o.sensorLog)
        }
        var encrypted = false
        var notPlayable: Boolean? = null
        if (o.file.exists()) {
            val enc = vault.encryptFile(takeId, o.file, "video.mp4")
            encrypted = !o.file.exists() && enc.exists()
            notPlayable = !isPlayable(enc)
        }
        return JSObject().apply {
            put("takeId", takeId)
            put("durationS", stats.durationS)
            put("requestedDurationS", o.requestedDurationS)
            put("durationErrorMs", (stats.durationS - o.requestedDurationS) * 1000)
            put("stoppedEarly", o.stoppedEarly)
            put("frameCount", stats.frameCount)
            put("effectiveFps", stats.effectiveFps)
            put("droppedFrames", stats.droppedFrames)
            put("droppedFrac", stats.droppedFrac)
            put("actualFps", o.actualFps)
            put("framesLogged", canonical.size)
            put("framesInVideoSpan", inSpan ?: JSONObject.NULL)
            put("mp4", if (alignment == null) JSONObject.NULL else JSObject().apply {
                put("sampleCount", alignment.sampleCount)
                put("firstRecordIndex", alignment.firstRecordIndex)
                put("maxAbsDiffMs", alignment.maxAbsDiffMs)
                put("p95AbsDiffMs", alignment.p95AbsDiffMs)
                put("anchor", alignment.anchor)
            })
            put("sensorSamples", o.sensorLog.size)
            put("sensorClockOffsetMs", sensorClockOffsetMs ?: JSONObject.NULL)
            put("encrypted", encrypted)
            put("encryptedNotPlayable", notPlayable ?: JSONObject.NULL)
            put("files", JSObject().apply {
                // Opaque references, never absolute paths (PII-safe logging, §14).
                put("video", "capturekit://takes/$takeId/video.mp4.enc")
                put("frames", "capturekit://takes/$takeId/frames.bin.enc")
                put("landmarks", "capturekit://takes/$takeId/landmarks.bin.enc")
                put("sensors", "capturekit://takes/$takeId/sensors.bin.enc")
            })
        }
    }
}

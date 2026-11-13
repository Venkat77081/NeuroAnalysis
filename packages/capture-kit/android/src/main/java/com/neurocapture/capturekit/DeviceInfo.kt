package com.neurocapture.capturekit

import android.content.Context
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraManager
import android.media.MediaRecorder
import android.os.Build
import android.util.Size
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import org.json.JSONObject

/** Camera capabilities read from Camera2 characteristics (no camera is opened). */
object DeviceInfo {
    fun device(): JSObject = JSObject().apply {
        put("manufacturer", Build.MANUFACTURER)
        put("model", Build.MODEL)
        put("osName", "android")
        put("osVersion", Build.VERSION.RELEASE)
    }

    fun hardwareLevel(ch: CameraCharacteristics): String = when (ch.get(CameraCharacteristics.INFO_SUPPORTED_HARDWARE_LEVEL)) {
        CameraCharacteristics.INFO_SUPPORTED_HARDWARE_LEVEL_LEGACY -> "LEGACY"
        CameraCharacteristics.INFO_SUPPORTED_HARDWARE_LEVEL_LIMITED -> "LIMITED"
        CameraCharacteristics.INFO_SUPPORTED_HARDWARE_LEVEL_FULL -> "FULL"
        CameraCharacteristics.INFO_SUPPORTED_HARDWARE_LEVEL_3 -> "LEVEL_3"
        CameraCharacteristics.INFO_SUPPORTED_HARDWARE_LEVEL_EXTERNAL -> "EXTERNAL"
        else -> "UNKNOWN"
    }

    fun timestampSource(ch: CameraCharacteristics): String =
        if (ch.get(CameraCharacteristics.SENSOR_INFO_TIMESTAMP_SOURCE) == CameraCharacteristics.SENSOR_INFO_TIMESTAMP_SOURCE_REALTIME) "REALTIME" else "UNKNOWN"

    fun aeFpsRanges(ch: CameraCharacteristics): JSArray {
        val arr = JSArray()
        ch.get(CameraCharacteristics.CONTROL_AE_AVAILABLE_TARGET_FPS_RANGES)?.forEach { r ->
            arr.put(JSArray().apply { put(r.lower); put(r.upper) })
        }
        return arr
    }

    /** Highest fps for a video-sized stream: limited by both min frame duration and the AE ranges. */
    fun maxFps(ch: CameraCharacteristics, size: Size): Double? {
        val map = ch.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP) ?: return null
        val sizes = map.getOutputSizes(MediaRecorder::class.java) ?: return null
        if (sizes.none { it.width == size.width && it.height == size.height }) return null
        val minDur = map.getOutputMinFrameDuration(MediaRecorder::class.java, size)
        val byDuration = if (minDur > 0) 1e9 / minDur else Double.MAX_VALUE
        val aeMax = ch.get(CameraCharacteristics.CONTROL_AE_AVAILABLE_TARGET_FPS_RANGES)?.maxOfOrNull { it.upper }?.toDouble()
        return minOf(byDuration, aeMax ?: byDuration).let { if (it == Double.MAX_VALUE) null else Math.round(it * 10) / 10.0 }
    }

    fun lockSupported(ch: CameraCharacteristics): JSObject = JSObject().apply {
        put("ae", ch.get(CameraCharacteristics.CONTROL_AE_LOCK_AVAILABLE) == true)
        put("awb", ch.get(CameraCharacteristics.CONTROL_AWB_LOCK_AVAILABLE) == true)
        put("af", ch.get(CameraCharacteristics.CONTROL_AF_AVAILABLE_MODES)?.contains(CameraCharacteristics.CONTROL_AF_MODE_AUTO) == true)
    }

    fun cameraBlock(ch: CameraCharacteristics): JSObject = JSObject().apply {
        put("hardwareLevel", hardwareLevel(ch))
        put("timestampSource", timestampSource(ch))
        put("aeFpsRanges", aeFpsRanges(ch))
        put("maxFps1080p", maxFps(ch, Size(1920, 1080)) ?: JSONObject.NULL)
        put("maxFps720p", maxFps(ch, Size(1280, 720)) ?: JSONObject.NULL)
        put("lockSupported", lockSupported(ch))
    }

    fun capabilities(context: Context, pluginVersion: String): JSObject {
        val mgr = context.getSystemService(Context.CAMERA_SERVICE) as CameraManager
        val cameras = JSArray()
        val seen = HashSet<String>()
        for (id in mgr.cameraIdList) {
            val ch = mgr.getCameraCharacteristics(id)
            val facing = when (ch.get(CameraCharacteristics.LENS_FACING)) {
                CameraCharacteristics.LENS_FACING_BACK -> "back"
                CameraCharacteristics.LENS_FACING_FRONT -> "front"
                else -> continue
            }
            if (!seen.add(facing)) continue // first (default) camera per facing, as CameraX selects
            cameras.put(JSObject().apply {
                put("facing", facing)
                put("maxFps", JSObject().apply {
                    maxFps(ch, Size(1920, 1080))?.let { put("1080p", it) }
                    maxFps(ch, Size(1280, 720))?.let { put("720p", it) }
                })
                put("timestampSource", timestampSource(ch))
                put("supportsLock", lockSupported(ch))
                put("hardwareLevel", hardwareLevel(ch))
            })
        }
        return JSObject().apply {
            put("implementation", "native")
            put("pluginVersion", pluginVersion)
            put("device", device())
            put("cameras", cameras)
            put("gpuDelegate", false) // known after MediaPipe init (M4)
        }
    }
}

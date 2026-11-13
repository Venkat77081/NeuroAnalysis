package com.neurocapture.capturekit

import android.content.Context
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.os.Handler
import android.os.HandlerThread
import android.os.SystemClock
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject

/**
 * Gyroscope + gravity at ~100 Hz on its own thread (DEV_PLAN §5.1). Emits `sensorBatch` every 100 ms
 * and appends to [recordingLog] while a take is recording. SensorEvent.timestamp is on the
 * elapsedRealtimeNanos clock (canonical); [clockOffsetMs] measures that per device.
 */
class SensorCapture(context: Context, private val emit: (String, JSObject) -> Unit) : SensorEventListener {
    private val mgr = context.getSystemService(Context.SENSOR_SERVICE) as SensorManager
    private val thread = HandlerThread("nc-sensors").apply { start() }
    private val handler = Handler(thread.looper)
    private val pending = JSArray()
    private var pendingCount = 0
    private val offsets = ArrayList<Long>()
    @Volatile var recordingLog: SensorLog? = null
    @Volatile var emitBatches = true
    private var running = false

    private val flush = object : Runnable {
        override fun run() {
            if (pendingCount > 0 && emitBatches) {
                val batch: JSArray
                synchronized(pending) {
                    batch = JSArray(pending.toString())
                    while (pending.length() > 0) pending.remove(0)
                    pendingCount = 0
                }
                emit("sensorBatch", JSObject().apply { put("samples", batch) })
            }
            if (running) handler.postDelayed(this, 100)
        }
    }

    fun start() {
        if (running) return
        running = true
        mgr.getDefaultSensor(Sensor.TYPE_GYROSCOPE)?.let { mgr.registerListener(this, it, 10_000, handler) }
        mgr.getDefaultSensor(Sensor.TYPE_GRAVITY)?.let { mgr.registerListener(this, it, 10_000, handler) }
        handler.postDelayed(flush, 100)
    }

    fun stop() {
        running = false
        mgr.unregisterListener(this)
        handler.removeCallbacks(flush)
        synchronized(pending) { while (pending.length() > 0) pending.remove(0); pendingCount = 0 }
    }

    fun available(): Pair<Boolean, Boolean> =
        (mgr.getDefaultSensor(Sensor.TYPE_GYROSCOPE) != null) to (mgr.getDefaultSensor(Sensor.TYPE_GRAVITY) != null)

    /** Median (callback time − event timestamp) in ms: near 0 when sensors use the canonical clock. */
    fun clockOffsetMs(): Double? = synchronized(offsets) { FrameStats.median(offsets.toLongArray())?.div(1e6) }

    override fun onSensorChanged(e: SensorEvent) {
        val type = when (e.sensor.type) {
            Sensor.TYPE_GYROSCOPE -> SensorLog.GYRO
            Sensor.TYPE_GRAVITY -> SensorLog.GRAVITY
            else -> return
        }
        synchronized(offsets) { if (offsets.size < 200) offsets.add(SystemClock.elapsedRealtimeNanos() - e.timestamp) }
        recordingLog?.add(type, e.timestamp, e.values[0], e.values[1], e.values[2])
        if (!emitBatches) return
        synchronized(pending) {
            if (pendingCount >= 60) return // ≤ 50 Hz per sensor to JS is enough; never grow unbounded
            pending.put(JSObject().apply {
                put("type", if (type == SensorLog.GYRO) "gyro" else "gravity")
                put("tsNs", e.timestamp.toString())
                put("x", e.values[0].toDouble()); put("y", e.values[1].toDouble()); put("z", e.values[2].toDouble())
            })
            pendingCount++
        }
    }

    override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) = Unit
}

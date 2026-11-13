package com.neurocapture.capturekit

/** Gyroscope / gravity samples while recording (type 1 = gyro, 2 = gravity). Thread-safe, growable. */
class SensorLog(initial: Int = 2048) {
    private var types = ByteArray(initial)
    private var ts = LongArray(initial)
    private var xs = FloatArray(initial)
    private var ys = FloatArray(initial)
    private var zs = FloatArray(initial)
    var size = 0
        private set

    @Synchronized
    fun add(type: Int, tsNs: Long, x: Float, y: Float, z: Float) {
        if (size == ts.size) {
            val n = size * 2
            types = types.copyOf(n); ts = ts.copyOf(n); xs = xs.copyOf(n); ys = ys.copyOf(n); zs = zs.copyOf(n)
        }
        types[size] = type.toByte(); ts[size] = tsNs; xs[size] = x; ys[size] = y; zs[size] = z
        size++
    }

    @Synchronized
    fun <T> read(block: (types: ByteArray, ts: LongArray, x: FloatArray, y: FloatArray, z: FloatArray, n: Int) -> T): T =
        block(types, ts, xs, ys, zs, size)

    companion object {
        const val GYRO = 1
        const val GRAVITY = 2
    }
}

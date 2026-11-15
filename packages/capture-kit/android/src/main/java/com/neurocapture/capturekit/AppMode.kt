package com.neurocapture.capturekit

/**
 * M13: which app this phone is. Set once and kept in the encrypted store under a key JS cannot
 * write (securePut/secureDelete refuse the reserved prefix), so a WebView change cannot turn a
 * clinic phone into a patient phone or back. Only resetDevice clears it.
 */
object AppMode {
    const val RESERVED = "sys."
    private const val KEY = "sys.app_mode"
    private val MODES = setOf("clinic", "patient")

    class LockedException : Exception()

    fun get(kv: Kv): String? = kv.get(KEY)?.let { org.json.JSONObject(it).optString("mode") }?.takeIf { it in MODES }

    /** Returns the mode; throws [LockedException] if a different mode is already set. */
    @Synchronized
    fun lock(kv: Kv, mode: String): String {
        require(mode in MODES) { "invalid mode" }
        val current = get(kv)
        if (current != null && current != mode) throw LockedException()
        if (current == null) kv.put(KEY, org.json.JSONObject().put("mode", mode).toString())
        return mode
    }
}

package com.neurocapture.capturekit

import com.google.crypto.tink.Aead
import java.io.File

/**
 * Small encrypted key–value store for app data (patients, session snapshot, settings), DEV_PLAN §14.
 * Each value is a JSON string encrypted with the Keystore-backed master AEAD; the key is bound as
 * associated data, so a file cannot be swapped for another key's. Writes are atomic (tmp + rename).
 * Lives in no-backup storage. Decision 011.
 */
class SecureStore(private val dir: File, private val master: Aead) : Kv {
    init {
        dir.mkdirs()
    }

    private fun file(key: String): File {
        require(KEY.matches(key)) { "invalid key" }
        return File(dir, "$key.enc")
    }

    private fun ad(key: String) = "nc-store-v1:$key".toByteArray()

    @Synchronized
    override fun get(key: String): String? {
        val f = file(key)
        if (!f.exists()) return null
        return String(master.decrypt(f.readBytes(), ad(key)), Charsets.UTF_8)
    }

    @Synchronized
    override fun put(key: String, json: String) {
        val f = file(key)
        val tmp = File(dir, "$key.enc.tmp")
        tmp.writeBytes(master.encrypt(json.toByteArray(Charsets.UTF_8), ad(key)))
        if (!tmp.renameTo(f)) {
            f.delete()
            if (!tmp.renameTo(f)) throw IllegalStateException("could not store $key")
        }
    }

    @Synchronized
    override fun delete(key: String): Boolean = file(key).delete()

    @Synchronized
    override fun keys(prefix: String): List<String> =
        dir.listFiles()?.map { it.name }?.filter { it.endsWith(".enc") }?.map { it.removeSuffix(".enc") }
            ?.filter { it.startsWith(prefix) }?.sorted() ?: emptyList()

    companion object {
        val KEY = Regex("^[a-z0-9][a-z0-9._-]{0,99}$")
    }
}

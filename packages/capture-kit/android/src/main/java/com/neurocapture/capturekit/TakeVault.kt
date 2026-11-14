package com.neurocapture.capturekit

import com.google.crypto.tink.Aead
import com.google.crypto.tink.InsecureSecretKeyAccess
import com.google.crypto.tink.KeyTemplates
import com.google.crypto.tink.KeysetHandle
import com.google.crypto.tink.RegistryConfiguration
import com.google.crypto.tink.StreamingAead
import com.google.crypto.tink.TinkProtoKeysetFormat
import com.google.crypto.tink.streamingaead.StreamingAeadConfig
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.InputStream
import java.io.OutputStream

/**
 * Encrypted per-take storage (DEV_PLAN §14). Each take has a random StreamingAead data key
 * (AES256_GCM_HKDF_4KB), stored as `datakey.enc` wrapped by the master AEAD (Android Keystore on a
 * device). Files are `<name>.enc`; plaintext never stays on disk except a recording in progress,
 * which [recover] encrypts after a crash. Deleting the take directory destroys its key.
 */
class TakeVault(private val root: File, private val master: Aead) {
    init {
        StreamingAeadConfig.register()
    }

    fun takeDir(takeId: String): File {
        require(TAKE_ID.matches(takeId)) { "invalid takeId" }
        return File(root, takeId)
    }

    private fun keyAd(takeId: String) = "nc-datakey-v1:$takeId".toByteArray()
    private fun fileAd(takeId: String, name: String) = "nc-file-v1:$takeId/$name".toByteArray()

    @Synchronized
    private fun dataKey(takeId: String): StreamingAead =
        keyset(takeId).getPrimitive(RegistryConfiguration.get(), StreamingAead::class.java)

    /**
     * The take's data key as a plain Tink keyset, only to be wrapped for the server at once
     * (never stored or logged). Fails if the take has no key.
     */
    fun exportDataKeyForWrapping(takeId: String): ByteArray {
        require(File(takeDir(takeId), "datakey.enc").exists()) { "take has no data key" }
        return TinkProtoKeysetFormat.serializeKeyset(keyset(takeId), InsecureSecretKeyAccess.get())
    }

    @Synchronized
    private fun keyset(takeId: String): KeysetHandle {
        val dir = takeDir(takeId).apply { mkdirs() }
        val keyFile = File(dir, "datakey.enc")
        return if (keyFile.exists()) {
            TinkProtoKeysetFormat.parseEncryptedKeyset(keyFile.readBytes(), master, keyAd(takeId))
        } else {
            KeysetHandle.generateNew(KeyTemplates.get("AES256_GCM_HKDF_4KB")).also {
                val tmp = File(dir, "datakey.enc.tmp")
                tmp.writeBytes(TinkProtoKeysetFormat.serializeEncryptedKeyset(it, master, keyAd(takeId)))
                if (!tmp.renameTo(keyFile)) throw IllegalStateException("could not store data key")
            }
        }
    }

    /** Opens `<name>.enc` for writing; the caller writes plaintext into the returned stream. */
    fun openEncrypting(takeId: String, name: String): OutputStream {
        val out = FileOutputStream(File(takeDir(takeId).apply { mkdirs() }, "$name.enc"))
        return dataKey(takeId).newEncryptingStream(out, fileAd(takeId, name))
    }

    fun openDecrypting(takeId: String, name: String): InputStream =
        dataKey(takeId).newDecryptingStream(FileInputStream(File(takeDir(takeId), "$name.enc")), fileAd(takeId, name))

    /** Encrypts [plain] into `<name>.enc` in the take directory, then deletes [plain]. */
    fun encryptFile(takeId: String, plain: File, name: String): File {
        FileInputStream(plain).use { input -> openEncrypting(takeId, name).use { input.copyTo(it, 64 * 1024) } }
        val enc = File(takeDir(takeId), "$name.enc")
        if (!plain.delete() && plain.exists()) throw IllegalStateException("could not delete plaintext ${plain.name}")
        return enc
    }

    fun writeText(takeId: String, name: String, text: String) {
        openEncrypting(takeId, name).use { it.write(text.toByteArray(Charsets.UTF_8)) }
    }

    fun readText(takeId: String, name: String): String = openDecrypting(takeId, name).use { it.readBytes().toString(Charsets.UTF_8) }

    fun decryptTo(takeId: String, name: String, dest: File) {
        dest.parentFile?.mkdirs()
        openDecrypting(takeId, name).use { input -> FileOutputStream(dest).use { input.copyTo(it, 64 * 1024) } }
    }

    fun delete(takeId: String): Boolean = takeDir(takeId).deleteRecursively()

    /**
     * After a crash or process kill: encrypt any plaintext left in take directories and mark the take
     * RetainedForRecovery. Returns the affected take IDs. Never leaves plaintext behind.
     */
    fun recover(): List<String> {
        val recovered = ArrayList<String>()
        root.listFiles()?.filter { it.isDirectory && TAKE_ID.matches(it.name) }?.forEach { dir ->
            var touched = false
            dir.listFiles()?.forEach { f ->
                when {
                    f.name in PLAINTEXT_NAMES -> {
                        try {
                            encryptFile(dir.name, f, f.name)
                            File(dir, ENCRYPT_PENDING).delete()
                        } catch (_: Exception) {
                            // §15 EncryptionFailure: keep the plaintext in app-private storage and retry
                            // at the next start. Uploads only ever read `.enc` files.
                            File(dir, "${f.name}.enc").delete() // drop a half-written ciphertext
                            File(dir, ENCRYPT_PENDING).writeText("EncryptionPending\n")
                        }
                        touched = true
                    }
                    f.name.endsWith(".tmp") -> { f.delete(); touched = true }
                }
            }
            if (touched) {
                File(dir, RECOVERY_MARKER).writeText("RetainedForRecovery\n")
                recovered.add(dir.name)
            }
        }
        return recovered
    }

    companion object {
        val TAKE_ID = Regex("^[A-Za-z0-9_-]{1,64}$")
        val PLAINTEXT_NAMES = setOf("video.mp4", "frames.bin", "sensors.bin", "landmarks.bin", "quality.json", "meta.json", "capture.json")
        const val RECOVERY_MARKER = "RECOVERED"
        const val ENCRYPT_PENDING = "ENCRYPT_PENDING"
    }
}

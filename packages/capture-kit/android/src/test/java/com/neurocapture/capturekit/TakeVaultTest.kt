package com.neurocapture.capturekit

import com.google.crypto.tink.Aead
import com.google.crypto.tink.KeyTemplates
import com.google.crypto.tink.KeysetHandle
import com.google.crypto.tink.RegistryConfiguration
import com.google.crypto.tink.aead.AeadConfig
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import java.io.File
import java.nio.file.Files

/** On a device the master AEAD lives in the Android Keystore; here a software AES-GCM key stands in. */
class TakeVaultTest {
    private lateinit var root: File
    private lateinit var master: Aead

    private fun newMaster(): Aead {
        AeadConfig.register()
        return KeysetHandle.generateNew(KeyTemplates.get("AES256_GCM")).getPrimitive(RegistryConfiguration.get(), Aead::class.java)
    }

    @Before fun setUp() {
        root = Files.createTempDirectory("vault").toFile()
        master = newMaster()
    }

    @Test fun encryptsFilesDeletesPlaintextAndRoundTrips() {
        val vault = TakeVault(root, master)
        val dir = vault.takeDir("t1").apply { mkdirs() }
        val payload = ByteArray(300_000) { (it % 251).toByte() }
        val plain = File(dir, "video.mp4").apply { writeBytes(payload) }
        val enc = vault.encryptFile("t1", plain, "video.mp4")
        assertFalse("plaintext must be gone", plain.exists())
        assertTrue(enc.exists())
        assertFalse("ciphertext must differ", enc.readBytes().copyOfRange(0, 64).contentEquals(payload.copyOfRange(0, 64)))
        val out = File(root, "out.mp4")
        vault.decryptTo("t1", "video.mp4", out)
        assertArrayEquals(payload, out.readBytes())
        vault.writeText("t1", "quality.json", "{\"a\":1}")
        assertEquals("{\"a\":1}", vault.readText("t1", "quality.json"))
        assertTrue(File(dir, "datakey.enc").exists())
    }

    @Test fun anotherMasterKeyOrRenamedFileCannotDecrypt() {
        TakeVault(root, master).writeText("t2", "meta.json", "{}")
        try {
            TakeVault(root, newMaster()).readText("t2", "meta.json")
            fail("decrypted with the wrong master key")
        } catch (_: Exception) {
        }
        val dir = File(root, "t2")
        File(dir, "meta.json.enc").renameTo(File(dir, "quality.json.enc"))
        try {
            TakeVault(root, master).readText("t2", "quality.json")
            fail("associated data must bind the file name")
        } catch (_: Exception) {
        }
    }

    @Test fun recoverEncryptsLeftoverPlaintextAndMarksTheTake() {
        val vault = TakeVault(root, master)
        val dir = File(root, "crashed").apply { mkdirs() }
        File(dir, "video.mp4").writeBytes(ByteArray(1000) { 7 })
        File(dir, "frames.bin").writeBytes(ByteArray(48))
        File(dir, "datakey.enc.tmp").writeBytes(ByteArray(3))
        File(root, "clean").mkdirs()
        assertEquals(listOf("crashed"), vault.recover())
        assertFalse(File(dir, "video.mp4").exists())
        assertFalse(File(dir, "frames.bin").exists())
        assertFalse(File(dir, "datakey.enc.tmp").exists())
        assertTrue(File(dir, "video.mp4.enc").exists())
        assertTrue(File(dir, TakeVault.RECOVERY_MARKER).exists())
        assertEquals(emptyList<String>(), vault.recover())
        assertTrue(vault.delete("crashed"))
        assertFalse(dir.exists())
    }

    @Test fun rejectsUnsafeTakeIds() {
        try {
            TakeVault(root, master).takeDir("../x")
            fail("path traversal accepted")
        } catch (_: IllegalArgumentException) {
        }
    }
}

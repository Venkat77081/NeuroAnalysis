package com.neurocapture.capturekit

import com.google.crypto.tink.Aead
import com.google.crypto.tink.KeyTemplates
import com.google.crypto.tink.KeysetHandle
import com.google.crypto.tink.RegistryConfiguration
import com.google.crypto.tink.aead.AeadConfig
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.File
import java.nio.file.Files

class SecureStoreTest {
    private fun master(): Aead {
        AeadConfig.register()
        return KeysetHandle.generateNew(KeyTemplates.get("AES256_GCM")).getPrimitive(RegistryConfiguration.get(), Aead::class.java)
    }

    @Test fun putGetDeleteAndList() {
        val dir = Files.createTempDirectory("store").toFile()
        val store = SecureStore(dir, master())
        assertNull(store.get("patient.p1"))
        store.put("patient.p1", "{\"ref\":\"A0142\"}")
        store.put("patient.p2", "{}")
        store.put("session.current", "{}")
        assertEquals("{\"ref\":\"A0142\"}", store.get("patient.p1"))
        assertFalse("must be encrypted at rest", File(dir, "patient.p1.enc").readText(Charsets.ISO_8859_1).contains("A0142"))
        assertEquals(listOf("patient.p1", "patient.p2"), store.keys("patient."))
        assertTrue(store.delete("patient.p2"))
        assertEquals(listOf("patient.p1"), store.keys("patient."))
    }

    @Test fun bindsTheKeyAndRejectsBadKeys() {
        val dir = Files.createTempDirectory("store").toFile()
        val store = SecureStore(dir, master())
        store.put("a", "{\"x\":1}")
        File(dir, "a.enc").copyTo(File(dir, "b.enc"))
        try {
            store.get("b")
            fail("a value moved to another key must not decrypt")
        } catch (_: Exception) {
        }
        for (bad in listOf("../x", "A", "", "x/y")) {
            try {
                store.put(bad, "{}")
                fail("accepted bad key $bad")
            } catch (_: IllegalArgumentException) {
            }
        }
    }
}

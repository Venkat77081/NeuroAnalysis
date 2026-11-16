package com.neurocapture.capturekit

import java.security.KeyFactory
import java.security.PublicKey
import java.security.spec.MGF1ParameterSpec
import java.security.spec.X509EncodedKeySpec
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.spec.OAEPParameterSpec
import javax.crypto.spec.PSource

/**
 * Wraps a take's data key for the server (DEV_PLAN §14): RSA-OAEP with SHA-256 and MGF1-SHA-256
 * (both set explicitly; Android's provider would otherwise use MGF1-SHA-1). The wrapped value is the
 * Tink keyset (binary proto) of the take's StreamingAead key, base64. Decision 020.
 */
object KeyWrap {
    private val OAEP = OAEPParameterSpec("SHA-256", "MGF1", MGF1ParameterSpec.SHA256, PSource.PSpecified.DEFAULT)

    fun publicKey(pem: String): PublicKey {
        val b64 = pem.lineSequence().filterNot { it.startsWith("-----") }.joinToString("").trim()
        return KeyFactory.getInstance("RSA").generatePublic(X509EncodedKeySpec(Base64.getDecoder().decode(b64)))
    }

    fun wrap(plainKey: ByteArray, pem: String): String {
        val c = Cipher.getInstance("RSA/ECB/OAEPPadding")
        c.init(Cipher.ENCRYPT_MODE, publicKey(pem), OAEP)
        return Base64.getEncoder().encodeToString(c.doFinal(plainKey))
    }
}

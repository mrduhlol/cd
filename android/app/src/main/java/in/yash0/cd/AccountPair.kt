package `in`.yash0.cd

import org.json.JSONObject
import java.security.KeyFactory
import java.security.spec.PKCS8EncodedKeySpec
import java.security.spec.X509EncodedKeySpec
import java.util.Base64
import javax.crypto.KeyAgreement

fun openAccountPair(encoded: String, privateKey: String, pairId: String, target: String): String {
    require(encoded.length <= 16384)
    val envelope = JSONObject(String(Base64.getUrlDecoder().decode(encoded)))
    val factory = KeyFactory.getInstance("EC")
    val local = factory.generatePrivate(PKCS8EncodedKeySpec(Base64.getUrlDecoder().decode(privateKey)))
    val remote = factory.generatePublic(X509EncodedKeySpec(Base64.getUrlDecoder().decode(envelope.getString("ephemeral"))))
    val shared = KeyAgreement.getInstance("ECDH").run { init(local); doPhase(remote, true); generateSecret() }
    val key = Crypto.derive(shared, pairId.toByteArray(), "cd-account-pair-v1")
    return String(Crypto.cipher(false, key, Crypto.decode(envelope.getString("nonce"), 12), target.toByteArray(), Base64.getUrlDecoder().decode(envelope.getString("ciphertext"))))
}

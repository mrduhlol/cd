package `in`.yash0.cd

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class AccountPairTest {
    private fun fixture() = JSONObject(javaClass.classLoader!!.getResource("account-pair-v1.json")!!.readText())
    @Test fun androidOpensActualGoInvitation() {
        val f = fixture()
        assertEquals(f.getString("link"), openAccountPair(f.getString("envelope"), f.getString("privateKey"), f.getString("pairId"), f.getString("target")))
    }
    @Test fun invitationCannotMoveToAnotherPhoneOrPair() {
        val f = fixture()
        assertThrows(Exception::class.java) { openAccountPair(f.getString("envelope"), f.getString("privateKey"), f.getString("pairId"), "different-phone") }
        assertThrows(Exception::class.java) { openAccountPair(f.getString("envelope"), f.getString("privateKey"), "different-pair", f.getString("target")) }
        val envelope = JSONObject(String(java.util.Base64.getUrlDecoder().decode(f.getString("envelope"))))
        val cipher = java.util.Base64.getUrlDecoder().decode(envelope.getString("ciphertext")); cipher[0] = (cipher[0].toInt() xor 1).toByte()
        envelope.put("ciphertext", Crypto.encode(cipher))
        assertThrows(Exception::class.java) { openAccountPair(Crypto.encode(envelope.toString().toByteArray()), f.getString("privateKey"), f.getString("pairId"), f.getString("target")) }
    }
}

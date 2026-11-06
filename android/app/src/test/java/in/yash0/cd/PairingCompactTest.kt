package `in`.yash0.cd

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class PairingCompactTest {
    // Identical to Go internal/devices sharedCompactFixture.
    private val fixture = "cdpair:372891146591999016240575961825396718207721315285425029054652779914196563316171128074557605223042228008454896009873051304954916030861304164"
    private val now = 1792330100000L

    @Test fun parsesGoCompactFixture() {
        val pair = Pairing.parse(fixture, now)
        val secret = ByteArray(32) { (it * 7 + 1).toByte() }
        assertEquals("41obY4mM92R44ohiMi3nJQ", pair.id)
        assertEquals(Crypto.encode(secret), pair.json.getString("secret"))
        assertEquals("yash-thinkpad", pair.name)
        assertEquals("wss://cd.yash0.in/ws/devices/v1/41obY4mM92R44ohiMi3nJQ", pair.json.getString("relayUrl"))
        assertEquals("ws://192.168.1.20:53318/ws/devices/v1/41obY4mM92R44ohiMi3nJQ", pair.json.getJSONArray("localUrls").getString(0))
        assertEquals(1792330300000L, pair.json.getLong("expiresAt"))
        assertEquals(pair.id, Pairing.pairIdFromSecret(secret))
    }

    @Test fun acceptsUppercaseScheme() { assertEquals("41obY4mM92R44ohiMi3nJQ", Pairing.parse("CDPAIR:" + fixture.substring(7), now).id) }

    @Test fun rejectsExpiredAndMalformedCodes() {
        assertThrows(IllegalArgumentException::class.java) { Pairing.parse(fixture, 1792330300000L) }
        for (bad in listOf("cdpair:", "cdpair:0" + fixture.substring(7), "cdpair:12a4", "cdpair:" + "9".repeat(1100), fixture.dropLast(30))) {
            assertTrue(bad, runCatching { Pairing.parse(bad, now) }.isFailure)
        }
    }

    @Test fun legacyCodesStillParse() {
        val secret = ByteArray(32) { 3 }
        val id = Crypto.encode(ByteArray(16) { 5 })
        val json = org.json.JSONObject().put("version", 1).put("pairId", id).put("secret", Crypto.encode(secret)).put("name", "laptop")
            .put("relayUrl", "wss://cd.yash0.in/ws/devices/v1/$id").put("localUrls", org.json.JSONArray()).put("expiresAt", now + 200000)
        val raw = "cdpair://v1#" + java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(json.toString().toByteArray())
        assertEquals(id, Pairing.parse(raw, now).id)
    }

    @Test fun shareMessageCarriesOnlyLinkMetadata() {
        val id = Crypto.encode(ByteArray(16) { 1 })
        val link = "https://cd.yash0.in/s/$id#v2." + Crypto.encode(ByteArray(32) { 2 })
        val share = TrustedSend.shareMessage(link, "photo.jpg", 42)
        assertEquals("share", share.getString("type"))
        assertEquals(id, share.getString("transferId"))
        assertEquals("42", share.getString("size"))
        assertEquals("photo.jpg", TrustedSend.shareMessage(link, "dir/photo.jpg", 42).getString("filename"))
        assertThrows(IllegalArgumentException::class.java) { TrustedSend.shareMessage("https://cd.yash0.in/s/$id#" + Crypto.encode(ByteArray(32)), "a", 1) }
        assertThrows(IllegalArgumentException::class.java) { TrustedSend.shareMessage(link, "..", 1) }
    }

    @Test fun phoneOpensComputerRepliesButNotForgedRoles() {
        val pair = Pairing.parse(fixture, now)
        val transferId = Crypto.encode(ByteArray(16) { 9 })
        fun computer(type: String): ByteArray {
            val nonce = Crypto.random(12)
            val msg = org.json.JSONObject().put("version", 1).put("type", type).put("messageId", Crypto.encode(Crypto.random(16))).put("expiresAt", System.currentTimeMillis() + 60000).put("transferId", transferId)
            return nonce + Crypto.cipher(true, pair.key("sender messages"), nonce, "cd-device-v1 sender ${pair.id}".toByteArray(), msg.toString().toByteArray())
        }
        for (type in listOf("receiving", "received", "paused")) assertEquals(type, pair.open(computer(type)).getString("type"))
        assertTrue(runCatching { pair.open(computer("share")) }.isFailure)
        // A phone-sealed share cannot be replayed back to the phone as a computer message.
        assertTrue(runCatching { pair.open(TrustedSend.seal(pair, TrustedSend.shareMessage("https://cd.yash0.in/s/$transferId#v2." + Crypto.encode(ByteArray(32)), "a", 1))) }.isFailure)
    }
}

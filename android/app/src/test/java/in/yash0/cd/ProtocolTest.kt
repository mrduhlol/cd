package `in`.yash0.cd

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class ProtocolTest {
    private fun fixture(): JSONObject = JSONObject(javaClass.classLoader!!.getResource("resume-v2.json")!!.readText())
    private fun invite(f: JSONObject): Invitation { val i = f.getJSONObject("invitation"); return Invitation(i.getString("rootId"), Crypto.decode(i.getString("masterKey"), 32), "wss://cd.yash0.in/ws/v2/${i.getString("rootId")}") }
    @Test fun goFixtureMatchesAdmissionNonceBothRecordsAndCheckpoint() {
        val f = fixture(); val i = invite(f); val s = Crypto.decode(f.getString("sessionNonce"), 32); val r = Crypto.decode(f.getString("receiverNonce"), 32)
        assertEquals(f.getString("receiverToken"), Crypto.encode(i.token()))
        assertEquals(f.getString("receiverTokenHash"), Crypto.encode(Crypto.sha(i.token())))
        assertEquals(f.getString("senderNonceProof"), Crypto.encode(i.proof("sender", s)))
        val expected = java.util.Base64.getUrlDecoder().decode(f.getString("record"))
        assertArrayEquals(expected, Records(i, s, r, true).seal(1, f.getString("plaintext").toByteArray()))
        assertArrayEquals(java.util.Base64.getUrlDecoder().decode(f.getString("receiverRecord")), Records(i, s, r, false).seal(4, f.getString("plaintext").toByteArray()))
        val opened = Records(i, s, r, true).open(expected)
        assertEquals(1, opened.first); assertEquals(f.getString("plaintext"), String(opened.second))
        assertEquals(f.getJSONObject("checkpoint").getString("mac"), checkpointMac(f.getJSONObject("checkpoint"), i))
    }
    @Test fun recordsRejectTamperingReplayWrongDirectionAndFreshSession() {
        val f = fixture(); val i = invite(f); val s = Crypto.decode(f.getString("sessionNonce"), 32); val r = Crypto.decode(f.getString("receiverNonce"), 32)
        val record = Records(i, s, r, true).seal(1, "hello".toByteArray())
        val opener = Records(i, s, r, true); opener.open(record)
        assertThrows(Exception::class.java) { opener.open(record) }
        assertThrows(Exception::class.java) { Records(i, s, Crypto.random(32), true).open(record) }
        assertThrows(Exception::class.java) { Records(i, s, r, false).open(record) }
        val tampered = record.clone().also { it[it.lastIndex] = (it.last().toInt() xor 1).toByte() }
        assertThrows(Exception::class.java) { Records(i, s, r, true).open(tampered) }
    }
    private fun pairing(now: Long): JSONObject {
        val id = Crypto.encode(ByteArray(16) { it.toByte() })
        return JSONObject().put("version", 1).put("pairId", id).put("secret", Crypto.encode(ByteArray(32) { (it + 16).toByte() })).put("name", "Laptop").put("relayUrl", "wss://cd.yash0.in/ws/devices/v1/$id").put("localUrls", org.json.JSONArray().put("ws://192.168.1.2:8787/ws/devices/v1/$id")).put("expiresAt", now + 60000)
    }
    @Test fun pairingRequiresFreshCredentialAndSafeEndpoints() {
        val now = 1700000000000L; val j = pairing(now)
        val uri = "cdpair://v1#${Crypto.encode(j.toString().toByteArray())}"
        assertEquals("Laptop", Pairing.parse(uri, now).name)
        assertThrows(Exception::class.java) { Pairing.parse(uri, now + 60001) }
        j.put("relayUrl", "ws://public.example.com/ws/devices/v1/id")
        assertThrows(Exception::class.java) { Pairing.parse("cdpair://v1#${Crypto.encode(j.toString().toByteArray())}", now) }
        assertTrue(localEndpoint("ws://192.168.1.2:1234/ws/v2/id"))
        assertFalse(localEndpoint("ws://8.8.8.8/ws/v2/id"))
        assertFalse(localEndpoint("ws://192.168.1.2.evil.example/ws/v2/id"))
        assertFalse(validEndpoint("ws://public.example.com/ws/v2/id"))
        assertFalse(validEndpoint("wss://user:password@example.com/path"))
    }
    @Test fun pairedControlAuthenticatesDirectionAndExpiry() {
        val now = 1700000000000L; val pair = Pairing(pairing(now))
        val msg = JSONObject().put("version", 1).put("type", "offer").put("messageId", Crypto.encode(Crypto.random(16))).put("expiresAt", now + 60000)
        val nonce = ByteArray(12) { it.toByte() }
        val frame = nonce + Crypto.cipher(true, pair.key("sender messages"), nonce, "cd-device-v1 sender ${pair.id}".toByteArray(), msg.toString().toByteArray())
        assertEquals("offer", pair.open(frame, now).getString("type"))
        assertThrows(Exception::class.java) { pair.open(frame, now + 60001) }
        assertThrows(Exception::class.java) { pair.open(pair.seal(msg), now) }
        assertThrows(Exception::class.java) { pair.open(frame.copyOf(frame.size - 1), now) }
    }
    @Test fun goPairedFixtureMatchesAllKeysAndOpensOffer() {
        val f = JSONObject(javaClass.classLoader!!.getResource("device-v1.json")!!.readText())
        val pair = Pairing(f.getJSONObject("pair"))
        assertEquals(f.getString("senderToken"), Crypto.encode(pair.key("sender join")))
        assertEquals(f.getString("receiverToken"), pair.token())
        assertEquals(f.getString("senderKey"), Crypto.encode(pair.key("sender messages")))
        assertEquals(f.getString("receiverKey"), Crypto.encode(pair.key("receiver messages")))
        val frame = java.util.Base64.getUrlDecoder().decode(f.getString("frame"))
        val offer = pair.open(frame, f.getLong("now"))
        val expected = f.getJSONObject("offer")
        assertEquals(expected.keys().asSequence().toSet(), offer.keys().asSequence().toSet())
        expected.keys().forEach { key -> assertEquals("field $key", expected.get(key), offer.get(key)) }
    }
    @Test fun pairingAndControlAllowBoundedClockSkew() {
        val f = JSONObject(javaClass.classLoader!!.getResource("device-v1.json")!!.readText())
        val now = f.getLong("now")
        val rawPair = "cdpair://v1#${Crypto.encode(f.getJSONObject("pair").toString().toByteArray())}"
        val pair = Pairing.parse(rawPair, now - 1000)
        val frame = java.util.Base64.getUrlDecoder().decode(f.getString("frame"))
        assertEquals("offer", pair.open(frame, now - 1000).getString("type"))
        assertThrows(Exception::class.java) { Pairing.parse(rawPair, now - 30001) }
        assertThrows(Exception::class.java) { pair.open(frame, now - 30001) }
    }
    @Test fun invitationRequiresResumablePrivateLink() {
        val f = fixture().getJSONObject("invitation"); val url = "https://cd.yash0.in/s/${f.getString("rootId")}#v2.${f.getString("masterKey")}"
        assertEquals("wss://cd.yash0.in/ws/v2/${f.getString("rootId")}", Invitation.parse(url).relay)
        assertEquals(1, Invitation.parse(url.replace("v2.", "v1.")).version)
        assertThrows(Exception::class.java) { Invitation.parse(url.replace("https://", "http://")) }
    }
}

package `in`.yash0.cd

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class ControlJoinTest {
    private fun pair(): Pairing = Pairing(JSONObject(javaClass.classLoader!!.getResource("device-v1.json")!!.readText()).getJSONObject("pair"))
    private fun challenge(nonce: String) = JSONObject().put("type", "challenge").put("protocol", "cd-device-v1").put("nonce", nonce)
    @Test fun localJoinOmitsBearerAndAnswersOneCanonicalChallenge() {
        val pair = pair()
        val join = ControlJoin(pair, localTransport = true)
        assertNull(join.initial())
        val nonce = Crypto.encode(ByteArray(32) { it.toByte() })
        val answer = join.event(challenge(nonce))!!
        assertEquals(setOf("type", "protocol", "role", "localProof"), answer.keys().asSequence().toSet())
        assertEquals("receiver", answer.getString("role"))
        assertEquals(pair.localProof(nonce), answer.getString("localProof"))
        assertFalse(join.admitted)
        join.event(JSONObject().put("type", "accepted").put("protocol", "cd-device-v1"))
        assertTrue(join.admitted)
        join.event(JSONObject().put("type", "pong").put("protocol", "cd-device-v1"))
        assertThrows(IllegalArgumentException::class.java) { join.event(challenge(nonce)) }
        assertThrows(IllegalArgumentException::class.java) { ControlJoin(pair, true).event(challenge("invalid")) }
        assertThrows(IllegalArgumentException::class.java) { ControlJoin(pair, true).event(JSONObject().put("type", "accepted").put("protocol", "cd-device-v1")) }
    }
    @Test fun localProofCannotBeReplayedForAnotherNonceRoleOrRelayAdmission() {
        val pair = pair()
        val first = Crypto.encode(ByteArray(32) { it.toByte() })
        val second = Crypto.encode(ByteArray(32) { (it + 1).toByte() })
        assertNotEquals(pair.localProof(first), pair.localProof(second))
        assertNotEquals(pair.localProof(first), pair.localProof(first, "sender"))
        assertNotEquals(Crypto.encode(pair.key("receiver join")), Crypto.encode(pair.key("receiver local join")))
        val relay = ControlJoin(pair, false)
        assertEquals(pair.token(), relay.initial()!!.getString("token"))
        assertFalse(relay.initial()!!.has("localProof"))
        assertThrows(IllegalArgumentException::class.java) { relay.event(challenge(first)) }
    }
    @Test fun localChallengeMatchesSharedCrossLanguageFixture() {
        val fixture = JSONObject(javaClass.classLoader!!.getResource("device-v1.json")!!.readText())
        val pair = Pairing(fixture.getJSONObject("pair"))
        val nonce = fixture.getString("localChallenge")
        val answer = ControlJoin(pair, true).event(challenge(nonce))!!
        assertEquals(fixture.getString("receiverLocalProof"), answer.getString("localProof"))
        assertEquals(fixture.getString("senderLocalProof"), pair.localProof(nonce, "sender"))
        assertFalse(answer.has("token"))
        assertFalse(answer.has("senderTokenHash"))
        assertFalse(answer.has("receiverTokenHash"))
    }
    @Test fun exhaustedRootIsPermanentAndDistinctFromNetworkLoss() {
        val event = JSONObject().put("type", "exhausted").put("protocol", "cd-transfer-v2").put("reason", "session_limit")
        val error = assertThrows(ExhaustedTransferException::class.java) { ReceiveGate.event(event) }
        assertEquals("Transfer reached its reconnect limit. Start a new transfer from the sender.", error.message)
        assertThrows(IllegalArgumentException::class.java) { ReceiveGate.event(JSONObject(event.toString()).put("protocol", "cd-device-v1")) }
        assertThrows(IllegalArgumentException::class.java) { ReceiveGate.event(JSONObject(event.toString()).put("reason", "other")) }
        assertTrue(WireFailure.closed(4410, "transfer session limit reached").exhausted)
        assertFalse(WireFailure.closed(1000, "transfer session limit reached").exhausted)
        assertFalse(WireFailure.closed(4410, "unrelated").exhausted)
        assertTrue(WireFailure.closed(4408, "transfer expired").expired)
        assertFalse(WireFailure.closed(4410, "transfer session limit reached").expired)
    }
    @Test fun networkLossRemainsTransientAndUserPauseIsDistinct() {
        assertThrows(TransientNetworkException::class.java) { ReceiveGate.check(true, "receiving", false) }
        assertThrows(UserPausedException::class.java) { ReceiveGate.check(true, "paused", true) }
        assertThrows(UserPausedException::class.java) { ReceiveGate.check(true, "cancelled", false) }
        assertThrows(UserPausedException::class.java) { ReceiveGate.check(false, "receiving", true) }
        ReceiveGate.check(true, "retrying", true)
        assertThrows(ExpiredTransferException::class.java) { ReceiveGate.expiry(1000, 1000) }
        ReceiveGate.expiry(1001, 1000)
        ReceiveGate.expiry(0, 1000)
    }
}

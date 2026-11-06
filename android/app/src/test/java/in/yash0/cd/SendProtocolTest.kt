package `in`.yash0.cd

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.security.MessageDigest

class SendProtocolTest {
    private fun fixture() = JSONObject(javaClass.classLoader!!.getResource("resume-v2.json")!!.readText())
    @Test fun senderRecordMatchesGoFixture() {
        val f = fixture(); val i = f.getJSONObject("invitation")
        val invitation = Invitation(i.getString("rootId"), Crypto.decode(i.getString("masterKey"), 32), "wss://example.com")
        val sender = Crypto.decode(f.getString("sessionNonce"), 32); val receiver = Crypto.decode(f.getString("receiverNonce"), 32)
        val sealed = SendRecords(invitation, sender, receiver).seal(1, f.getString("plaintext").toByteArray())
        assertArrayEquals(java.util.Base64.getUrlDecoder().decode(f.getString("record")), sealed)
    }
    @Test fun reusedCipherAndPartialChunksOpenWithReceiver() {
        val invitation = Invitation(Crypto.encode(ByteArray(16)), ByteArray(32) { it.toByte() }, "wss://example.com")
        val sender = ByteArray(32) { (it + 1).toByte() }; val receiver = ByteArray(32) { (it + 2).toByte() }
        val sealer = SendRecords(invitation, sender, receiver); val opener = Records(invitation, sender, receiver, true)
        val source = ByteArray(262144) { (it % 251).toByte() }
        assertEquals("offer", String(opener.open(sealer.seal(1, "offer".toByteArray())).second))
        repeat(32) { assertArrayEquals(source, opener.open(sealer.seal(2, source)).second) }
        assertArrayEquals(source.copyOf(731), opener.open(sealer.seal(2, source, 731)).second)
        val digest = Crypto.hex(MessageDigest.getInstance("SHA-256").digest(source))
        val end = SendProtocol.end(source.size.toLong(), digest)
        assertEquals(44, end.size)
        assertArrayEquals(counts(262144), end.copyOfRange(0, 12))
        assertArrayEquals(end, opener.open(sealer.seal(3, end)).second)
    }
    @Test fun cumulativeAcksRejectReplaysOvershootAndMisalignment() {
        assertEquals(524288L, SendProtocol.ack(counts(524288), 0, 1048576, 1048576))
        assertEquals(800000L, SendProtocol.ack(counts(800000), 524288, 800000, 800000))
        listOf(counts(0), counts(262145), counts(1048576), ByteArray(11)).forEach { bad ->
            assertThrows(IllegalArgumentException::class.java) { SendProtocol.ack(bad, 262144, 524288, 1048576) }
        }
        assertThrows(IllegalArgumentException::class.java) { SendProtocol.ack(counts(524288).also { it[0] = 1 }, 0, 524288, 1048576) }
        assertThrows(IllegalArgumentException::class.java) { SendProtocol.offset("-1", 100) }
        assertThrows(IllegalArgumentException::class.java) { SendProtocol.offset("01", 100) }
        assertThrows(IllegalArgumentException::class.java) { SendProtocol.offset("1", 100) }
        assertEquals(0L, SendProtocol.offset("0", 0))
        assertEquals(100L, SendProtocol.offset("100", 100))
    }
}

package `in`.yash0.cd

import org.junit.Assert.*
import org.junit.Test

class SendProtocolTest {
    @Test fun restartingUsesFreshRelayAndEncryptionCredentials() {
        val first = SendProtocol.invitation("https://cd.yash0.in")
        val second = SendProtocol.invitation("https://cd.yash0.in")
        assertEquals(1, first.version)
        assertNotEquals(first.id, second.id)
        assertFalse(first.key.contentEquals(second.key))
        assertFalse(first.token().contentEquals(second.token()))
    }
    @Test fun cumulativeAcksRejectReplaysOvershootAndMisalignment() {
        assertEquals(524288L, SendProtocol.ack(counts(524288), 0, 1048576, 1048576))
        assertEquals(800000L, SendProtocol.ack(counts(800000), 524288, 800000, 800000))
        listOf(counts(0), counts(262145), counts(1048576), ByteArray(11)).forEach { bad ->
            assertThrows(IllegalArgumentException::class.java) { SendProtocol.ack(bad, 262144, 524288, 1048576) }
        }
        assertThrows(IllegalArgumentException::class.java) { SendProtocol.ack(counts(524288).also { it[0] = 1 }, 0, 524288, 1048576) }
    }
    @Test fun partialFinalWindowKeepsSendingUntilEveryByteIsAcknowledged() {
        val size = 43L * SendProtocol.CHUNK + 731
        var sent = 0L
        var ack = 0L
        var iterations = 0
        while (ack < size) {
            while (SendProtocol.canSend(sent, ack, size)) sent += minOf(SendProtocol.CHUNK.toLong(), size - sent)
            assertTrue("Sender must not wait with no unacknowledged data", sent > ack)
            ack = SendProtocol.ack(counts(minOf(ack + SendProtocol.CHUNK, size)), ack, sent, size)
            assertTrue(++iterations < 100)
        }
        assertEquals(size, sent)
        assertFalse(SendProtocol.canSend(sent, ack, size))
    }
}

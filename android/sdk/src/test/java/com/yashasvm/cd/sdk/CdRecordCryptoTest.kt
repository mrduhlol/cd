package com.yashasvm.cd.sdk

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class CdRecordCryptoTest {
    @Test fun matchesBrowserV1WireVectors() {
        // Generated independently with src/agent-protocol.js and Web Crypto.
        val invite = CdInvitation.create("https://cd.yash0.in", ByteArray(48) { it.toByte() })
        fun hex(value: ByteArray) = value.joinToString("") { "%02x".format(it) }
        assertEquals("cddad6b523a50226b81f70185e4fb104410345bf414b40ead814be727006396d", hex(receiverToken(invite)))
        assertEquals("43440101000000000000000e7a326b0e30dce237b73160f0caeaf7c6334c8a22df5a838be4733cf54846", hex(CdRecordSealer(invite, true).seal(KIND_OFFER, "pack.stikrpack".toByteArray())))
        assertEquals("4344010400000000000000001b11455e6c5f72373f5fec03d379ec2d", hex(CdRecordSealer(invite, false).seal(KIND_ACCEPT)))
    }

    @Test fun peersDeriveMatchingKeysAndAuthenticateOrderedRecords() {
        val invite = CdInvitation.create("https://cd.yash0.in", ByteArray(48) { (it + 1).toByte() })
        val sender = CdRecordSealer(invite, sender = true)
        val senderReader = CdRecordOpener(invite, sender = true)
        val receiver = CdRecordSealer(invite, sender = false)
        val receiverReader = CdRecordOpener(invite, sender = false)

        val offer = "{\"name\":\"pack.zip\"}".toByteArray()
        val (offerKind, decodedOffer) = senderReader.open(sender.seal(KIND_OFFER, offer))
        assertEquals(KIND_OFFER, offerKind)
        assertArrayEquals(offer, decodedOffer)
        val (acceptKind, accept) = receiverReader.open(receiver.seal(KIND_ACCEPT))
        assertEquals(KIND_ACCEPT, acceptKind)
        assertArrayEquals(ByteArray(0), accept)
    }

    @Test fun tamperedAndOutOfOrderRecordsFailAuthentication() {
        val invite = CdInvitation.create("https://cd.yash0.in", ByteArray(48) { it.toByte() })
        val first = CdRecordSealer(invite, sender = true).seal(KIND_OFFER, byteArrayOf(1))
        val altered = first.copyOf().also { it[it.lastIndex] = (it.last().toInt() xor 1).toByte() }
        assertThrows(Exception::class.java) { CdRecordOpener(invite, sender = true).open(altered) }

        val sender = CdRecordSealer(invite, sender = true)
        sender.seal(KIND_OFFER)
        val second = sender.seal(KIND_CHUNK, byteArrayOf(2))
        assertThrows(IllegalArgumentException::class.java) { CdRecordOpener(invite, sender = true).open(second) }
    }

    @Test fun transferCountersUseUnsignedChunkCountsAndValidatePayloadLength() {
        val encoded = encodeCounts(0xffffffffL, 0x1_0000_0000L)
        assertEquals(TransferCounts(0xffffffffL, 0x1_0000_0000L), decodeCounts(encoded))
        assertThrows(IllegalArgumentException::class.java) { decodeCounts(byteArrayOf(1)) }
    }
}

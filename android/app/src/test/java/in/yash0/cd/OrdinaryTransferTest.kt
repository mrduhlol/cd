package `in`.yash0.cd

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class OrdinaryTransferTest {
    private val invitation = Invitation.parse("https://cd.yash0.in/s/AAECAwQFBgcICQoLDA0ODw#v1.ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8")
    @Test fun browserV1AdmissionAndRecordsMatchBothDirections() {
        assertEquals("AgMgWYyVOVPhMzLd4NwL8Mcl9GbvPg5SiBuEZF82VoE", Crypto.encode(invitation.token()))
        val senderRecord = "Q0QBAQAAAAAAAAALbKw_oFNfoBOQc4_5qSQ9Bi2UxzdrY0nNdPXp"
        val receiverRecord = "Q0QBBAAAAAAAAAAC03Hy3jxLk82vW49Sie0QRT13"
        val sender = Records(invitation, byteArrayOf(), byteArrayOf(), true)
        assertEquals(senderRecord, Crypto.encode(sender.seal(1, "exact bytes".toByteArray())))
        val receiver = Records(invitation, byteArrayOf(), byteArrayOf(), false)
        assertEquals(receiverRecord, Crypto.encode(receiver.seal(4, "{}".toByteArray())))
        val opener = Records(invitation, byteArrayOf(), byteArrayOf(), true)
        val record = java.util.Base64.getUrlDecoder().decode(senderRecord)
        assertEquals("exact bytes", String(opener.open(record).second))
        assertThrows(Exception::class.java) { opener.open(record) }
        val tampered = record.clone().also { it[it.lastIndex] = (it.last().toInt() xor 1).toByte() }
        assertThrows(Exception::class.java) { Records(invitation, byteArrayOf(), byteArrayOf(), true).open(tampered) }
        assertThrows(Exception::class.java) { Records(invitation.copy(version = 2), ByteArray(32), ByteArray(32), true).open(record) }
    }
    @Test fun offerSupportsLegacyAndCurrentChunksAndRejectsUnsafeMetadata() {
        for (chunkSize in listOf(65536, 262144, 786432)) {
            val json = JSONObject().put("name", "report.zip").put("size", "1000000").put("chunkSize", chunkSize).put("bundle", true)
            assertEquals(OrdinaryOffer("report.zip", 1000000, chunkSize), OrdinaryOffer.parse(json))
            for (name in listOf("..", "../escape", "a\\b", "bad\nname", "é".repeat(128))) {
                assertThrows(IllegalArgumentException::class.java) { OrdinaryOffer.parse(JSONObject(json.toString()).put("name", name)) }
            }
            for (size in listOf("-1", "01", "9007199254740992")) {
                assertThrows(IllegalArgumentException::class.java) { OrdinaryOffer.parse(JSONObject(json.toString()).put("size", size)) }
            }
            assertThrows(IllegalArgumentException::class.java) { OrdinaryOffer.parse(JSONObject(json.toString()).put("chunkSize", 1048576)) }
        }
    }
    @Test fun acceptsFinalPartialChunkButRejectsOvershootAndEarlyPartialChunks() {
        val offer = OrdinaryOffer("file.bin", 262145, 262144)
        offer.checkChunk(0, 262144)
        offer.checkChunk(262144, 1)
        assertThrows(IllegalArgumentException::class.java) { offer.checkChunk(0, 1) }
        assertThrows(IllegalArgumentException::class.java) { offer.checkChunk(262144, 2) }
        assertThrows(IllegalArgumentException::class.java) { offer.checkChunk(0, 0) }
        assertThrows(IllegalArgumentException::class.java) { offer.checkChunk(0, 262145) }
    }
}

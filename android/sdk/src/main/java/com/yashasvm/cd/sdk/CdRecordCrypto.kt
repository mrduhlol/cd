package com.yashasvm.cd.sdk

import java.nio.ByteBuffer
import java.nio.ByteOrder
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

internal const val KIND_OFFER = 1
internal const val KIND_CHUNK = 2
internal const val KIND_END = 3
internal const val KIND_ACCEPT = 4
internal const val KIND_ACK = 5
internal const val KIND_COMPLETE = 6
internal const val SDK_CHUNK_SIZE = 256 * 1024
internal const val ACK_INTERVAL_BYTES = 1024 * 1024L
internal const val MAX_SAFE_SIZE = 9007199254740991L

internal class CdRecordSealer(private val invite: CdInvitation, private val sender: Boolean) {
    private val key = recordKey(invite, sender)
    private var sequence = 0L

    fun seal(kind: Int, plaintext: ByteArray = ByteArray(0)): ByteArray {
        require(if (sender) kind in KIND_OFFER..KIND_END else kind in KIND_ACCEPT..KIND_COMPLETE)
        require(sequence <= 0xffffffffL && plaintext.size <= 1_048_548)
        val header = ByteBuffer.allocate(12).order(ByteOrder.BIG_ENDIAN)
            .put(byteArrayOf(0x43, 0x44, 1, kind.toByte()))
            .putInt(sequence.toInt()).putInt(plaintext.size).array()
        val aad = header + invite.transferId
        val nonce = ByteBuffer.allocate(12).put(if (sender) "CDS1".toByteArray() else "CDR1".toByteArray()).putLong(sequence).array()
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, nonce))
        cipher.updateAAD(aad)
        sequence++
        return header + cipher.doFinal(plaintext)
    }
}

internal class CdRecordOpener(private val invite: CdInvitation, private val sender: Boolean) {
    private val key = recordKey(invite, sender)
    private var expectedSequence = 0L

    fun open(record: ByteArray): Pair<Int, ByteArray> {
        require(record.size in 28..1_048_576) { "Invalid CD record length" }
        val header = record.copyOfRange(0, 12)
        val view = ByteBuffer.wrap(header).order(ByteOrder.BIG_ENDIAN)
        require(view.get() == 0x43.toByte() && view.get() == 0x44.toByte() && view.get().toInt() == 1) { "Unsupported CD record" }
        val kind = view.get().toInt() and 0xff
        require(if (sender) kind in KIND_OFFER..KIND_END else kind in KIND_ACCEPT..KIND_COMPLETE) { "Invalid CD record kind" }
        val sequence = view.int.toLong() and 0xffffffffL
        val length = view.int
        require(sequence == expectedSequence && length >= 0 && record.size == 12 + length + 16) { "Invalid CD record sequence or length" }
        val aad = header + invite.transferId
        val nonce = ByteBuffer.allocate(12).put(if (sender) "CDS1".toByteArray() else "CDR1".toByteArray()).putLong(sequence).array()
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, nonce))
        cipher.updateAAD(aad)
        val plain = cipher.doFinal(record, 12, record.size - 12)
        expectedSequence++
        return kind to plain
    }
}

private fun recordKey(invite: CdInvitation, sender: Boolean): ByteArray = hkdf(
    input = invite.key,
    salt = invite.transferId,
    info = if (sender) "cd-transfer-v1 sender frames" else "cd-transfer-v1 receiver frames",
)

internal fun receiverToken(invite: CdInvitation): ByteArray = hkdf(invite.key, invite.transferId, "cd-transfer-v1 receiver join")

private fun hkdf(input: ByteArray, salt: ByteArray, info: String): ByteArray {
    val extract = Mac.getInstance("HmacSHA256").apply { init(SecretKeySpec(salt, "HmacSHA256")) }.doFinal(input)
    val expand = Mac.getInstance("HmacSHA256").apply { init(SecretKeySpec(extract, "HmacSHA256")) }
    expand.update(info.toByteArray(Charsets.UTF_8))
    expand.update(1)
    return expand.doFinal().copyOf(32)
}

internal data class TransferCounts(val chunks: Long, val bytes: Long)
internal fun encodeCounts(chunks: Long, bytes: Long): ByteArray {
    require(chunks in 0..0xffffffffL && bytes >= 0)
    return ByteBuffer.allocate(12).order(ByteOrder.BIG_ENDIAN).putInt(chunks.toInt()).putLong(bytes).array()
}
internal fun decodeCounts(value: ByteArray): TransferCounts {
    require(value.size == 12) { "Invalid CD counter payload" }
    val input = ByteBuffer.wrap(value).order(ByteOrder.BIG_ENDIAN)
    val chunks = input.int.toLong() and 0xffffffffL
    val bytes = input.long
    require(bytes >= 0) { "Invalid CD byte count" }
    return TransferCounts(chunks, bytes)
}

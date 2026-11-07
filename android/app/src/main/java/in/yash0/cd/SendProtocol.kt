package `in`.yash0.cd

import java.nio.ByteBuffer
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/** Sender records share the receiver's key schedule, with reusable cipher/header storage. */
internal class SendRecords(invitation: Invitation, sender: ByteArray, receiver: ByteArray) {
    private var sequence = 0L
    private val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    private val key = SecretKeySpec(Crypto.derive(invitation.key, invitation.rawId + sender + receiver, "cd-transfer-v2 sender frames"), "AES")
    private val nonce = ByteBuffer.allocate(12).put("CDS2".toByteArray())
    private val aad = ByteBuffer.allocate(92).apply { position(12); put(invitation.rawId); put(sender); put(receiver) }
    fun seal(kind: Int, plaintext: ByteArray, length: Int = plaintext.size): ByteArray {
        require(kind in 1..3 && sequence <= 0xffffffffL && length in 0..minOf(1048548, plaintext.size))
        aad.position(0)
        aad.put('C'.code.toByte()).put('D'.code.toByte()).put(2).put(kind.toByte()).putInt(sequence.toInt()).putInt(length)
        nonce.putLong(4, sequence)
        cipher.init(Cipher.ENCRYPT_MODE, key, GCMParameterSpec(128, nonce.array()))
        cipher.updateAAD(aad.array())
        val record = ByteArray(length + 28)
        aad.array().copyInto(record, endIndex = 12)
        cipher.doFinal(plaintext, 0, length, record, 12)
        sequence++
        return record
    }
}

internal object SendProtocol {
    const val CHUNK = 262144
    const val WINDOW = 4L * 1024 * 1024
    fun offset(raw: String, size: Long): Long {
        require(raw.matches(Regex("0|[1-9][0-9]*"))) { "Invalid retained offset" }
        return raw.toLong().also { require(it in 0..size && (it % CHUNK == 0L || it == size)) { "Invalid retained offset" } }
    }
    fun ack(payload: ByteArray, acknowledged: Long, sent: Long, size: Long): Long {
        require(payload.size == 12) { "Invalid acknowledgement length" }
        val b = ByteBuffer.wrap(payload)
        val chunks = b.int.toLong() and 0xffffffffL
        val next = b.long
        require(next > acknowledged && next <= sent && next <= size && (next % CHUNK == 0L || next == size) && chunks == (next + CHUNK - 1) / CHUNK) { "Invalid cumulative acknowledgement" }
        return next
    }
    fun end(size: Long, digest: String): ByteArray {
        require(size >= 0 && digest.matches(Regex("[a-f0-9]{64}")))
        return counts(size) + ByteArray(32) { digest.substring(it * 2, it * 2 + 2).toInt(16).toByte() }
    }
}

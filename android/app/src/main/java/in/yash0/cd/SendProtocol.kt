package `in`.yash0.cd

import java.nio.ByteBuffer

internal object SendProtocol {
    // Each restart needs fresh relay admission and fresh record encryption nonces.
    fun invitation(base: String): Invitation = Invitation.parse("${base.trimEnd('/')}/s/${Crypto.encode(Crypto.random(16))}#v1.${Crypto.encode(Crypto.random(32))}")
    const val CHUNK = 262144
    const val WINDOW = 4L * 1024 * 1024
    fun canSend(sent: Long, acknowledged: Long, size: Long): Boolean = sent < size && sent - acknowledged < WINDOW
    fun ack(payload: ByteArray, acknowledged: Long, sent: Long, size: Long): Long {
        require(payload.size == 12) { "Invalid acknowledgement length" }
        val b = ByteBuffer.wrap(payload)
        val chunks = b.int.toLong() and 0xffffffffL
        val next = b.long
        require(next > acknowledged && next <= sent && next <= size && (next % CHUNK == 0L || next == size) && chunks == (next + CHUNK - 1) / CHUNK) { "Invalid cumulative acknowledgement" }
        return next
    }
}

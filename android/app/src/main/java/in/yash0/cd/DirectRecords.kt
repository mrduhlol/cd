package `in`.yash0.cd

import java.nio.ByteBuffer

class DirectRecords {
    private val header = ByteArray(12)
    private var headerSize = 0
    private var record: ByteArray? = null
    private var size = 0
    @Synchronized fun push(piece: ByteArray, emit: (ByteArray) -> Unit) {
        require(piece.isNotEmpty() && piece.size <= 65536) { "Invalid direct fragment length" }
        var offset = 0
        while (offset < piece.size) {
            if (record == null) {
                val n = minOf(12 - headerSize, piece.size - offset)
                piece.copyInto(header, headerSize, offset, offset + n)
                headerSize += n; offset += n
                if (headerSize < 12) continue
                require(header[0] == 'C'.code.toByte() && header[1] == 'D'.code.toByte() && header[2].toInt() == 2 && header[3].toInt() == 2) { "Invalid direct record header" }
                val payload = ByteBuffer.wrap(header, 8, 4).int.toLong().and(0xffffffffL)
                require(payload <= 1048548L) { "Direct record exceeds limit" }
                record = ByteArray(28 + payload.toInt()).also { header.copyInto(it) }
                size = 12
            }
            val current = record!!
            val n = minOf(current.size - size, piece.size - offset)
            piece.copyInto(current, size, offset, offset + n)
            size += n; offset += n
            if (size == current.size) {
                record = null; headerSize = 0; size = 0
                emit(current)
            }
        }
    }
}

class RecordWriter(private val sealer: Records, private val send: (ByteArray) -> Unit) {
    private var signals = true
    @Synchronized fun send(kind: Int, payload: ByteArray) { if (kind != 9 || signals) send(sealer.seal(kind, payload)) }
    @Synchronized fun stopSignals() { signals = false }
}

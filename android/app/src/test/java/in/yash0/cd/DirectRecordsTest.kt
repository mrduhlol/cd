package `in`.yash0.cd

import org.junit.Assert.*
import org.junit.Test
import java.nio.ByteBuffer
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

class DirectRecordsTest {
    private val invitation = Invitation(Crypto.encode(ByteArray(16)), ByteArray(32), "wss://example.com/ws/v2/test")
    private val sender = ByteArray(32) { 1 }
    private val receiver = ByteArray(32) { 2 }
    @Test fun fragmentedAndConcatenatedRecordsReassembleWithoutChangingAuthenticatedOrder() {
        val seal = Records(invitation, sender, receiver, true)
        val expected = listOf(seal.seal(2, ByteArray(262144) { 42 }), seal.seal(2, byteArrayOf(7, 8, 9)))
        val input = expected.reduce { a, b -> a + b }
        val assembler = DirectRecords()
        val received = ArrayList<ByteArray>()
        val pieces = listOf(1, 10, 3, 65536, 17, 60000)
        var offset = 0
        var piece = 0
        while (offset < input.size) {
            val end = minOf(input.size, offset + pieces[piece++ % pieces.size])
            assembler.push(input.copyOfRange(offset, end)) { received.add(it) }
            offset = end
        }
        assertEquals(2, received.size)
        expected.indices.forEach { assertArrayEquals(expected[it], received[it]) }
        val open = Records(invitation, sender, receiver, true)
        assertArrayEquals(ByteArray(262144) { 42 }, open.open(received[0]).second)
        assertArrayEquals(byteArrayOf(7, 8, 9), open.open(received[1]).second)
    }
    @Test fun directAssemblerRejectsOversizeFragmentsHeadersAndNonChunkRecordsBeforeAllocation() {
        assertThrows(IllegalArgumentException::class.java) { DirectRecords().push(ByteArray(65537)) {} }
        val oversized = ByteBuffer.allocate(12).put('C'.code.toByte()).put('D'.code.toByte()).put(2).put(2).putInt(0).putInt(1048549).array()
        assertThrows(IllegalArgumentException::class.java) { DirectRecords().push(oversized) {} }
        val end = Records(invitation, sender, receiver, true).seal(3, byteArrayOf())
        assertThrows(IllegalArgumentException::class.java) { DirectRecords().push(end) {} }
        assertThrows(IllegalArgumentException::class.java) { DirectRecords().push(ByteArray(12)) {} }
    }
    @Test fun concurrentSignalsAndAcksShareOneSequenceAndTerminalFreezesSignals() {
        val records = ArrayList<ByteArray>()
        val writer = RecordWriter(Records(invitation, sender, receiver, false)) { records.add(it) }
        val workers = Executors.newFixedThreadPool(4)
        repeat(64) { n -> workers.submit { writer.send(if (n % 2 == 0) 9 else 5, byteArrayOf(n.toByte())) } }
        workers.shutdown()
        assertTrue(workers.awaitTermination(3, TimeUnit.SECONDS))
        writer.stopSignals()
        writer.send(9, "late-candidate".toByteArray())
        writer.send(6, "done".toByteArray())
        assertEquals(65, records.size)
        val open = Records(invitation, sender, receiver, false)
        val opened = records.map(open::open)
        assertEquals((0..63).toSet(), opened.dropLast(1).map { it.second.single().toInt() and 255 }.toSet())
        assertEquals(6, opened.last().first)
        assertEquals("done", String(opened.last().second))
    }
}

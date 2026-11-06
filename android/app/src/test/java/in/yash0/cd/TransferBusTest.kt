package `in`.yash0.cd

import org.junit.Assert.*
import org.junit.Test

class TransferBusTest {
    @Test fun refreshingFinishedHistoryPreservesEveryUnfinishedTransfer() {
        val prefix = "unit-history-retention-"
        val terminal = listOf(TransferPhase.COMPLETE, TransferPhase.CANCELLED, TransferPhase.FAILED)
        val unfinished = TransferPhase.entries.filterNot { it in terminal }
        try {
            unfinished.forEachIndexed { index, phase ->
                TransferBus.publish(TransferView("${prefix}send-$index", Direction.SEND, "file", 1, 0, 0, phase, updatedAt = index.toLong()))
            }
            // ReceiveViews.load republishes retained receives with fresh timestamps on recreation.
            repeat(60) { index ->
                TransferBus.publish(TransferView("${prefix}receive-$index", Direction.RECEIVE, "old file", 1, 1, 0, terminal[index % terminal.size], updatedAt = 1000L + index))
            }
            unfinished.forEachIndexed { index, phase ->
                assertEquals("Hydrated history evicted $phase", phase, TransferBus.find("${prefix}send-$index", Direction.SEND)?.phase)
            }
            val history = TransferBus.transfers.value.filter { it.id.startsWith("${prefix}receive-") }
            assertEquals(50, history.size)
            assertEquals((59 downTo 10).map { "${prefix}receive-$it" }, history.map { it.id })
        } finally {
            TransferBus.transfers.value.filter { it.id.startsWith(prefix) }.forEach { TransferBus.remove(it.id, it.direction) }
        }
    }

    @Test fun finishedSendEntersHistoryWithoutLeavingAnUnfinishedDuplicate() {
        val id = "unit-history-transition"
        try {
            TransferBus.publish(TransferView(id, Direction.SEND, "file", 1, 0, 0, TransferPhase.PAUSED))
            TransferBus.publish(TransferView(id, Direction.SEND, "file", 1, 1, 0, TransferPhase.COMPLETE))
            val matching = TransferBus.transfers.value.filter { it.id == id && it.direction == Direction.SEND }
            assertEquals(1, matching.size)
            assertEquals(TransferPhase.COMPLETE, matching.single().phase)
        } finally { TransferBus.remove(id, Direction.SEND) }
    }
}

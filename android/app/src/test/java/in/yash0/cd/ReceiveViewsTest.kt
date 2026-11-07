package `in`.yash0.cd

import org.junit.Assert.*
import org.junit.Test

class ReceiveViewsTest {
    @Test fun ratesIgnoreTheRetainedPrefixAndResetOnPauseOrRewind() {
        val rate = ReceiveRate()
        assertEquals(0L, rate.update(1000000, 0, true))
        assertEquals(0L, rate.update(1100000, 100, true))
        assertEquals(400000L, rate.update(1100000, 250, true))
        assertEquals(400000L, rate.update(1200000, 500, true))
        assertEquals(0L, rate.update(1200000, 750, false))
        assertEquals(0L, rate.update(1200000, 1000, true))
        assertEquals(0L, rate.update(1000000, 1500, true))
    }
    @Test fun phasesIncludeInterruptedAndPublishedTasks() {
        assertEquals(TransferPhase.WAITING, ReceiveViews.phase("queued"))
        assertEquals(TransferPhase.CONNECTING, ReceiveViews.phase("connecting"))
        assertEquals(TransferPhase.TRANSFERRING, ReceiveViews.phase("receiving"))
        assertEquals(TransferPhase.VERIFYING, ReceiveViews.phase("verifying"))
        assertEquals(TransferPhase.PAUSED, ReceiveViews.phase("paused"))
        assertEquals(TransferPhase.RETRYING, ReceiveViews.phase("retrying"))
        assertEquals(TransferPhase.COMPLETE, ReceiveViews.phase("complete"))
        assertEquals(TransferPhase.CANCELLED, ReceiveViews.phase("cancelled"))
        assertEquals(TransferPhase.FAILED, ReceiveViews.phase("failed"))
    }
}

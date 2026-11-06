package `in`.yash0.cd

import org.junit.Assert.*
import org.junit.Test

class ReceiveSchedulerTest {
    @Test fun unreachableRootYieldsToNewOffersAndRetainsRetryRouteSequence() {
        val scheduler = ReceiveScheduler()
        assertEquals("old", scheduler.next(listOf("old"), 0))
        assertEquals(0, scheduler.attempt("old"))
        scheduler.failed("old", 0)
        assertEquals("new", scheduler.next(listOf("old", "new"), 100))
        scheduler.finished("new")
        assertNull(scheduler.next(listOf("old"), 1999))
        assertEquals("old", scheduler.next(listOf("old"), 2000))
        assertEquals(1, scheduler.attempt("old"))
        scheduler.failed("old", 2000)
        assertEquals("third", scheduler.next(listOf("old", "third"), 2100))
        scheduler.failed("third", 2100)
        scheduler.wake("old")
        assertEquals("old", scheduler.next(listOf("old", "third"), 2200))
        assertEquals(2, scheduler.attempt("old"))
    }
    @Test fun readyRootsRotateAndPausedRootsCannotRunUntilExplicitlyQueued() {
        val scheduler = ReceiveScheduler()
        assertEquals(listOf("a", "b", "c", "a"), List(4) { scheduler.next(listOf("a", "b", "c"), 0) })
        assertEquals("c", scheduler.next(listOf("c"), 0))
        assertNull(scheduler.next(emptyList(), 0))
        assertEquals("a", scheduler.next(listOf("a"), 0))
    }
}

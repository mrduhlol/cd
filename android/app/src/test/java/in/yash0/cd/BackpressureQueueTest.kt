package `in`.yash0.cd

import org.junit.Assert.*
import org.junit.Test
import java.io.IOException
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

class BackpressureQueueTest {
    @Test fun fullInboxWaitsForConsumerThenDeliversAllRecordsInOrder() {
        val inbox = BackpressureQueue<Int>(8)
        val full = CountDownLatch(1)
        val extraDelivered = CountDownLatch(1)
        val worker = Executors.newSingleThreadExecutor()
        try {
            val producer = worker.submit {
                repeat(8) { inbox.put(it) }
                full.countDown()
                inbox.put(8)
                extraDelivered.countDown()
                for (i in 9..31) inbox.put(i)
            }
            assertTrue(full.await(2, TimeUnit.SECONDS))
            assertFalse("Producer must wait while the bounded inbox is full", extraDelivered.await(100, TimeUnit.MILLISECONDS))
            assertEquals(0, inbox.take(2000))
            assertTrue(extraDelivered.await(2, TimeUnit.SECONDS))
            for (i in 1..31) assertEquals(i, inbox.take(2000))
            producer.get(2, TimeUnit.SECONDS)
        } finally { inbox.close(); worker.shutdownNow() }
    }
    @Test fun closingFullInboxUnblocksProducerAndConsumerWithFailure() {
        val inbox = BackpressureQueue<Int>(1)
        inbox.put(1)
        val entered = CountDownLatch(1)
        val worker = Executors.newSingleThreadExecutor()
        try {
            val producer = worker.submit<Boolean> {
                entered.countDown()
                try { inbox.put(2); false } catch (_: IOException) { true }
            }
            assertTrue(entered.await(2, TimeUnit.SECONDS))
            inbox.close()
            assertTrue(producer.get(2, TimeUnit.SECONDS))
            assertThrows(IOException::class.java) { inbox.take(10000) }
        } finally { inbox.close(); worker.shutdownNow() }
    }
}

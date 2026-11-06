package `in`.yash0.cd

import java.io.IOException
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.TimeUnit

/** A bounded socket inbox. Producers wait for the disk writer, and close wakes both sides. */
class BackpressureQueue<T : Any>(capacity: Int) {
    private val queue = ArrayBlockingQueue<T>(capacity)
    @Volatile private var failure: IOException? = null
    fun put(value: T, timeoutMillis: Long = 90000) {
        val deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(timeoutMillis)
        while (true) {
            failure?.let { throw it }
            val left = deadline - System.nanoTime()
            if (left <= 0) throw IOException("Receiver could not drain its inbox")
            if (queue.offer(value, minOf(left, TimeUnit.MILLISECONDS.toNanos(100)), TimeUnit.NANOSECONDS)) {
                failure?.let { throw it }
                return
            }
        }
    }
    fun take(timeoutMillis: Long): T {
        val deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(timeoutMillis)
        while (true) {
            failure?.let { throw it }
            val left = deadline - System.nanoTime()
            if (left <= 0) throw IOException("Peer timed out")
            val value = queue.poll(minOf(left, TimeUnit.MILLISECONDS.toNanos(100)), TimeUnit.NANOSECONDS)
            if (value != null) { failure?.let { throw it }; return value }
        }
    }
    @Synchronized fun close(error: IOException = IOException("Connection closed")) { if (failure == null) failure = error; queue.clear() }
}

package `in`.yash0.cd

import java.util.ArrayDeque

class ReceiveScheduler {
    private val queue = ArrayDeque<String>()
    private val attempts = HashMap<String, Int>()
    private val retryAt = HashMap<String, Long>()
    @Synchronized fun next(pending: List<String>, now: Long): String? {
        val present = pending.toHashSet()
        queue.removeIf { it !in present }
        pending.forEach { if (!queue.contains(it)) queue.addLast(it) }
        repeat(queue.size) {
            val id = queue.removeFirst()
            queue.addLast(id)
            if (now >= (retryAt[id] ?: 0)) return id
        }
        return null
    }
    @Synchronized fun attempt(id: String): Int = attempts[id] ?: 0
    @Synchronized fun failed(id: String, now: Long) {
        val attempt = (attempts[id] ?: 0) + 1
        attempts[id] = attempt
        retryAt[id] = now + minOf(10000L, 2000L * attempt)
    }
    @Synchronized fun wake(id: String) { retryAt.remove(id) }
    @Synchronized fun finished(id: String) { queue.remove(id); attempts.remove(id); retryAt.remove(id) }
}

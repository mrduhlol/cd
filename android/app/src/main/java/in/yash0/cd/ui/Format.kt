package `in`.yash0.cd.ui

import `in`.yash0.cd.Direction
import `in`.yash0.cd.Route
import `in`.yash0.cd.TransferPhase
import `in`.yash0.cd.TransferView
import java.util.Locale
import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.roundToLong

/** Formatting shared with the website (`formatSize` / `formatEta` in src/main.js). Pure, unit tested. */
object Format {
    private const val KB = 1024.0
    private const val MB = KB * 1024
    private const val GB = MB * 1024

    fun size(bytes: Long): String = when {
        bytes < 0 -> "–"
        bytes < 1024 -> "$bytes B"
        bytes < MB -> String.format(Locale.US, "%.1f KB", bytes / KB)
        bytes < GB -> String.format(Locale.US, "%.1f MB", bytes / MB)
        else -> String.format(Locale.US, "%.2f GB", bytes / GB)
    }

    fun eta(seconds: Double): String {
        if (!seconds.isFinite() || seconds < 0) return "–"
        if (seconds < 1) return "<1s"
        if (seconds < 60) return "${ceil(seconds).toLong()}s"
        val minutes = floor(seconds / 60).toLong()
        if (minutes < 60) return "${minutes}m ${(seconds % 60).roundToLong()}s"
        return "${minutes / 60}h ${minutes % 60}m"
    }

    fun eta(view: TransferView): String =
        if (view.size <= 0 || view.bytesPerSecond <= 0 || view.done >= view.size) "–"
        else eta((view.size - view.done).toDouble() / view.bytesPerSecond)

    /** Speed split into number and unit so the number can be drawn large. */
    fun speedParts(bytesPerSecond: Double): Pair<String, String> = when {
        bytesPerSecond <= 0 -> "0" to "MB/s"
        bytesPerSecond < MB -> String.format(Locale.US, "%.0f", bytesPerSecond / KB) to "KB/s"
        bytesPerSecond < 10 * MB -> String.format(Locale.US, "%.2f", bytesPerSecond / MB) to "MB/s"
        bytesPerSecond < 100 * MB -> String.format(Locale.US, "%.1f", bytesPerSecond / MB) to "MB/s"
        bytesPerSecond < GB -> String.format(Locale.US, "%.0f", bytesPerSecond / MB) to "MB/s"
        else -> String.format(Locale.US, "%.2f", bytesPerSecond / GB) to "GB/s"
    }

    fun speed(bytesPerSecond: Long): String = if (bytesPerSecond <= 0) "–" else speedParts(bytesPerSecond.toDouble()).let { "${it.first} ${it.second}" }

    /** Gauge full-scale in MB/s: the smallest step that keeps the needle under ~85%. */
    fun gaugeScale(bytesPerSecond: Double): Double {
        val mbps = bytesPerSecond / MB
        return listOf(5.0, 10.0, 25.0, 50.0, 100.0, 250.0, 500.0, 1000.0, 2500.0).firstOrNull { mbps <= it * 0.85 } ?: 5000.0
    }

    fun fraction(view: TransferView): Float = when {
        view.phase == TransferPhase.COMPLETE -> 1f
        view.size <= 0 -> 0f
        else -> (view.done.toDouble() / view.size).coerceIn(0.0, 1.0).toFloat()
    }

    fun percent(fraction: Float): String = if (fraction >= 1f) "100%" else String.format(Locale.US, "%.1f%%", fraction * 100)

    fun route(route: Route): String = when (route) {
        Route.NONE -> "–"
        Route.RELAY -> "Relay"
        Route.LAN -> "LAN"
        Route.DIRECT -> "Direct"
    }

    /**
     * Short lowercase state, the website's state-board vocabulary. Direction-correct: only a SEND in
     * WAITING is "waiting for receiver"; a send that once had a link and lost the relay is "reconnecting".
     */
    fun phase(view: TransferView): String {
        val send = view.direction == Direction.SEND
        return when (view.phase) {
            TransferPhase.PREPARING -> if (!send) "preparing" else if (view.link == null) "creating private link" else "reconnecting"
            TransferPhase.WAITING -> if (send) "waiting for receiver" else "queued"
            TransferPhase.CONNECTING -> if (!send) "connecting to sender" else if (view.link == null) "connecting" else "reconnecting"
            TransferPhase.TRANSFERRING -> if (send) "sending" else "receiving"
            TransferPhase.VERIFYING -> "verifying"
            TransferPhase.PAUSED -> "paused"
            TransferPhase.RETRYING -> "retrying"
            TransferPhase.COMPLETE -> if (send) "sent" else "saved"
            TransferPhase.FAILED -> "failed"
            TransferPhase.CANCELLED -> "cancelled"
        }
    }

    /** Supporting line of a transfer row. Errors and pause reasons are shown, never swallowed. */
    fun rowDetail(view: TransferView, fraction: Float = fraction(view), now: Long = System.currentTimeMillis()): String {
        val label = phase(view).replaceFirstChar { it.uppercase() }
        val message = view.message?.trim()?.takeIf { it.isNotEmpty() }
        return when {
            view.phase == TransferPhase.TRANSFERRING -> "${percent(fraction)} · ${speed(view.bytesPerSecond)}"
            message != null && view.phase in setOf(TransferPhase.FAILED, TransferPhase.PAUSED, TransferPhase.RETRYING) -> "$label · $message"
            view.finished -> "$label · ${size(view.size)} · ${ago(view.updatedAt, now)}"
            else -> "$label · ${size(view.size)}"
        }
    }

    /** Keeps both ends of a long filename, where the extension and distinguishing suffix usually are. */
    fun shortenMiddle(text: String, max: Int = 32): String {
        if (text.length <= max) return text
        val keep = max - 1
        return text.take((keep + 1) / 2) + "…" + text.takeLast(keep / 2)
    }

    fun ago(updatedAt: Long, now: Long = System.currentTimeMillis()): String {
        val s = ((now - updatedAt) / 1000).coerceAtLeast(0)
        return when {
            s < 45 -> "just now"
            s < 3600 -> "${(s + 30) / 60}m ago"
            s < 86400 -> "${s / 3600}h ago"
            else -> "${s / 86400}d ago"
        }
    }
}

val TransferView.active: Boolean get() = phase in setOf(TransferPhase.PREPARING, TransferPhase.WAITING, TransferPhase.CONNECTING, TransferPhase.TRANSFERRING, TransferPhase.VERIFYING, TransferPhase.RETRYING)
val TransferView.finished: Boolean get() = phase in setOf(TransferPhase.COMPLETE, TransferPhase.FAILED, TransferPhase.CANCELLED)

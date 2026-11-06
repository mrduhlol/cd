package `in`.yash0.cd

import android.content.Context
import android.content.Intent
import androidx.core.content.ContextCompat

/**
 * Starts the authenticated control links to paired computers. They carry pairing confirmation
 * ("paired", which `cdx pair` waits for) and computer-to-phone offers, so they must run whenever
 * CD is open with at least one pairing, not only after a pasted link queues a transfer.
 *
 * Integration (MainActivity / ReceiveMode): call [connect] from onForeground, after saving a new
 * pairing, and when receiving is resumed, each only when not paused. Call [idle] from onBackground.
 */
object ReceiveControl {
    /** The user's "Pause receiving" choice, persisted by ui.ReceiveMode. */
    fun paused(context: Context): Boolean = context.getSharedPreferences("cd-ui", Context.MODE_PRIVATE).getBoolean("receivePaused", false)

    fun connect(context: Context) {
        val store = StoreRegistry.get(context)
        if ((store.pairs().isEmpty()) || paused(context)) return
        store.enabled(true)
        runCatching { ContextCompat.startForegroundService(context, Intent(context, ReceiverService::class.java)) }
    }

    /**
     * CD went to the background: stop the control service now if idle, otherwise as soon as its queued
     * or running transfers finish. Never pauses a transfer. [connect] before then cancels the stop.
     * Leaves Store.enabled as is: it means "receiving allowed" (cleared only by pause), not "running".
     */
    fun disconnectIdle(context: Context) {
        // Never start the service just to stop it.
        if (!ReceiverService.alive) return
        runCatching { context.startService(Intent(context, ReceiverService::class.java).setAction("idle")) }
    }
}

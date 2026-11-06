package `in`.yash0.cd.ui

import android.content.Context
import android.content.Intent
import androidx.core.content.ContextCompat
import `in`.yash0.cd.PushBridge
import `in`.yash0.cd.ReceiveControl
import `in`.yash0.cd.ReceiverService
import `in`.yash0.cd.StoreRegistry
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/*
 * Receive mode as the UI sees it. While CD is open (and receiving isn't paused) the authenticated
 * control links to paired computers run in ReceiverService via [ReceiveControl]: that is what lets
 * `cdx pair` finish and computers send to this phone without a code. When CD goes to the background
 * the control service stops once it is idle; running or queued transfers finish first. Trusted
 * computers can still wake CD with a push hint where this build supports it ([wakeAvailable]).
 *   wakeAvailable: StateFlow<Boolean>   push wake-up is configured
 *   paused: StateFlow<Boolean>          user chose "Pause receiving" (reject wake-ups and trusted sends)
 *   load / setPaused                    persisted pause flag
 *   startTransfer(context)              a real transfer was queued (pasted link / Resume): run it now
 *   onForeground / onBackground         start control links / stop them once idle
 *   paired(context)                     a new pairing was saved: connect it now, not at the next onStart
 */
object ReceiveMode {
    private val _wake = MutableStateFlow(PushBridge.available)
    val wakeAvailable: StateFlow<Boolean> = _wake.asStateFlow()
    private val _paused = MutableStateFlow(false)
    val paused: StateFlow<Boolean> = _paused.asStateFlow()

    fun load(context: Context) {
        _paused.value = context.getSharedPreferences("cd-ui", Context.MODE_PRIVATE).getBoolean("receivePaused", false)
    }

    @Volatile private var foreground = false

    fun setPaused(context: Context, paused: Boolean) {
        context.getSharedPreferences("cd-ui", Context.MODE_PRIVATE).edit().putBoolean("receivePaused", paused).apply()
        _paused.value = paused
        // Stop a running receiver so paused transfers keep their progress; reconnect controls on un-pause while open.
        if (paused && StoreRegistry.get(context).enabled()) context.startService(Intent(context, ReceiverService::class.java).setAction("pause"))
        else if (!paused && foreground) ReceiveControl.connect(context)
    }

    /** Legacy backend: the receiver service runs the queued task (its notification shows only while it works). */
    fun startTransfer(context: Context) {
        if (_paused.value) return
        StoreRegistry.get(context).enabled(true)
        ContextCompat.startForegroundService(context, Intent(context, ReceiverService::class.java))
    }

    fun onForeground(context: Context) { foreground = true; if (!_paused.value) ReceiveControl.connect(context) }
    fun onBackground(context: Context) { foreground = false; ReceiveControl.disconnectIdle(context) }

    /** Called right after a pairing is saved, so `cdx pair` gets its confirmation without reopening CD. */
    fun paired(context: Context) { if (!_paused.value) ReceiveControl.connect(context) }
}

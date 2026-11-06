package `in`.yash0.cd

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.content.ContextCompat

class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action !in listOf(Intent.ACTION_BOOT_COMPLETED, Intent.ACTION_MY_PACKAGE_REPLACED)) return
        if (!StoreRegistry.get(context).enabled()) return
        try {
            ContextCompat.startForegroundService(context, Intent(context, ReceiverService::class.java))
        } catch (_: RuntimeException) { PushBridge.fallback(context) }
    }
}

package `in`.yash0.cd

import android.content.Context

object PushBridge {
    const val available = false
    const val status = "Wake-up notifications need a Firebase-configured build"
    fun canWake(context: Context, pairId: String) = false
    fun start(context: Context) {}
    fun setEnabled(context: Context, enabled: Boolean) {}
    fun admitted(context: Context, pair: Pairing) {}
    fun disconnected(pairId: String) {}
    fun maintenance(context: Context) {}
    fun revoke(context: Context, pair: Pairing) {}
    fun fallback(context: Context) {}
}

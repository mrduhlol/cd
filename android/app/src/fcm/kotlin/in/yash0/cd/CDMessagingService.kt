package `in`.yash0.cd

import android.content.Intent
import android.annotation.SuppressLint
import androidx.core.content.ContextCompat
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

// FID registration uses onRegistered; the legacy onNewToken API is deprecated.
@SuppressLint("MissingFirebaseInstanceTokenRefresh")
class CDMessagingService: FirebaseMessagingService() {
    override fun onRegistered(installationId: String) { PushBridge.registered(this, installationId) }
    override fun onMessageReceived(message: RemoteMessage) {
        val store = StoreRegistry.get(this)
        val action = PushPolicy.decide(message.data, System.currentTimeMillis(), store.pairs().map { it.id }.toSet(), store.pushEnabled(), store.enabled(), PushBridge.notifications(this), message.priority == RemoteMessage.PRIORITY_HIGH)
        if (action == PushPolicy.Action.IGNORE) return
        val pairId = message.data.getValue("pairId")
        if (!PushBridge.canWake(this, pairId) || !store.acceptPushWake(pairId, message.data.getValue("issuedAt").toLong(), System.currentTimeMillis())) return
        when (action) {
            PushPolicy.Action.IGNORE -> Unit
            PushPolicy.Action.SHOW_NOTIFICATION -> PushBridge.fallback(this)
            PushPolicy.Action.START_RECEIVER -> {
                try {
                    ContextCompat.startForegroundService(this, Intent(this, ReceiverService::class.java).setAction("push-wake").putExtra("pairId", message.data.getValue("pairId")))
                } catch (_: RuntimeException) { PushBridge.fallback(this) }
            }
        }
    }
}

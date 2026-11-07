package `in`.yash0.cd

import java.io.IOException
import org.json.JSONObject

class UserPausedException: IOException("Receiving was paused")
class TransientNetworkException: IOException("Waiting for an allowed network")
class ExhaustedTransferException: IOException("Transfer reached its reconnect limit. Start a new transfer from the sender.")
class ExpiredTransferException: IOException("This transfer expired or is no longer available. Start a new transfer on your computer.")

object ReceiveGate {
    fun event(event: JSONObject) {
        require(event.getString("protocol") == "cd-transfer-v2")
        when (event.getString("type")) {
            "exhausted" -> { require(event.getString("reason") == "session_limit"); throw ExhaustedTransferException() }
            "interrupted", "peer-left" -> throw IOException("Peer interrupted")
        }
    }
    fun check(running: Boolean, state: String?, networkAllowed: Boolean) {
        if (!running || state !in listOf("queued", "connecting", "receiving", "verifying", "retrying")) throw UserPausedException()
        if (!networkAllowed) throw TransientNetworkException()
    }
    fun expiry(expiresAt: Long, now: Long = System.currentTimeMillis()) {
        if (expiresAt > 0 && expiresAt <= now) throw ExpiredTransferException()
    }
}

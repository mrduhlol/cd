package `in`.yash0.cd

import java.net.URI

object PushPolicy {
    enum class Action { IGNORE, START_RECEIVER, SHOW_NOTIFICATION }
    fun canReceive(optIn: Boolean, receiving: Boolean, trusted: Boolean, notifications: Boolean) = optIn && receiving && trusted && notifications
    fun acceptWake(previousIssuedAt: Long, previousReceivedAt: Long, issuedAt: Long, now: Long): Boolean = issuedAt > previousIssuedAt && (previousReceivedAt == 0L || now - previousReceivedAt >= 20000L)
    fun decide(data: Map<String, String>, now: Long, trusted: Set<String>, optIn: Boolean, receiving: Boolean, notifications: Boolean, highPriority: Boolean): Action {
        if (!canReceive(optIn, receiving, data["pairId"] in trusted, notifications) || data.keys != setOf("v", "type", "pairId", "issuedAt")) return Action.IGNORE
        if (data["v"] != "1" || data["type"] != "wake" || data["pairId"] !in trusted) return Action.IGNORE
        val issued = data["issuedAt"]?.takeIf { it.matches(Regex("[0-9]{1,16}")) }?.toLongOrNull() ?: return Action.IGNORE
        if (issued > now + 30000 || issued < now - 300000) return Action.IGNORE
        return if (highPriority) Action.START_RECEIVER else Action.SHOW_NOTIFICATION
    }
    fun targetUrl(relay: String, pairId: String): String {
        require(pairId.matches(Regex("[A-Za-z0-9_-]{22}")))
        val uri = URI(relay)
        require(uri.rawUserInfo == null && uri.rawQuery == null && uri.rawFragment == null)
        val scheme = when (uri.scheme) {
            "wss" -> "https"
            "ws" -> { require(uri.host in setOf("127.0.0.1", "[::1]", "::1", "localhost")); "http" }
            else -> throw IllegalArgumentException("Push registration requires a TLS relay")
        }
        require(!uri.host.isNullOrBlank())
        return URI(scheme, null, uri.host, uri.port, "/api/devices/v1/$pairId/push-target", null, null).toASCIIString()
    }
}

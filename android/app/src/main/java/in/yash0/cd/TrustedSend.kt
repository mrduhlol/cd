package `in`.yash0.cd

import android.content.Context
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import org.json.JSONObject
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

/**
 * Authenticated control links to paired computers, shared by [ReceiverService] (long-lived) and
 * [TrustedSend] (short-lived). The relay admits one phone socket per pairing, so a send reuses the
 * service's socket when it has one rather than being refused as a duplicate.
 */
object ControlHub {
    sealed interface Signal {
        /** A socket is admitted and the computer is connected on its other end. */
        data class Ready(val socket: WebSocket) : Signal
        /** [url] is set when the socket closed (not just the computer leaving), so a send can replace it. */
        data class Gone(val socket: WebSocket, val url: String? = null) : Signal
        data class Reply(val message: JSONObject) : Signal
    }
    private class Link(val socket: WebSocket, val url: String) { @Volatile var peer = false }
    private val links = ConcurrentHashMap<String, CopyOnWriteArrayList<Link>>()
    private val watchers = ConcurrentHashMap<String, CopyOnWriteArrayList<LinkedBlockingQueue<Signal>>>()

    private fun emit(pairId: String, signal: Signal) { watchers[pairId]?.forEach { it.offer(signal) } }
    private fun link(pairId: String, socket: WebSocket) = links[pairId]?.firstOrNull { it.socket === socket }

    fun admitted(pairId: String, url: String, socket: WebSocket) {
        if (link(pairId, socket) == null) links.getOrPut(pairId) { CopyOnWriteArrayList() }.add(Link(socket, url))
    }
    fun peer(pairId: String, socket: WebSocket, present: Boolean) {
        val link = link(pairId, socket) ?: return
        link.peer = present
        emit(pairId, if (present) Signal.Ready(socket) else Signal.Gone(socket))
    }
    fun removed(pairId: String, socket: WebSocket) {
        val url = link(pairId, socket)?.url
        links[pairId]?.removeAll { it.socket === socket }
        emit(pairId, Signal.Gone(socket, url))
    }
    /** A computer-sent reply ("receiving", "received" or "paused"); offers go to the receiver path. */
    fun message(pairId: String, message: JSONObject) = emit(pairId, Signal.Reply(message))
    fun hasLink(pairId: String, url: String) = links[pairId]?.any { it.url == url } == true

    fun watch(pairId: String): LinkedBlockingQueue<Signal> {
        // Bounded: a watcher lives for one offer; a flood of computer replies is dropped, not buffered.
        val queue = LinkedBlockingQueue<Signal>(256)
        watchers.getOrPut(pairId) { CopyOnWriteArrayList() }.add(queue)
        links[pairId]?.filter { it.peer }?.forEach { queue.offer(Signal.Ready(it.socket)) }
        return queue
    }
    fun unwatch(pairId: String, queue: LinkedBlockingQueue<Signal>) { watchers[pairId]?.remove(queue) }

    private val holds = AtomicInteger()
    /** Keeps [ReceiverService] from its background idle stop while an offer is pending or in flight. */
    fun hold(): AutoCloseable {
        holds.incrementAndGet()
        val closed = AtomicBoolean(false)
        return AutoCloseable { if (closed.compareAndSet(false, true)) holds.decrementAndGet() }
    }
    val busy: Boolean get() = holds.get() > 0
}

/** Computer-to-phone offers, from the service's links or a [TrustedSend] socket. */
object OfferIntake {
    /**
     * Queues the offer. Returns the reply for the computer when the transfer is already known
     * ("received" or "paused"), else null.
     */
    fun accept(store: Store, pair: Pairing, controlUrl: String, localTransport: Boolean, msg: JSONObject): String? {
        if (localTransport && localEndpoint(msg.optString("localUrl"))) {
            // Data goes to the host this control link reached, never one named by the message.
            val control = java.net.URI(controlUrl)
            val data = java.net.URI(msg.getString("localUrl"))
            val endpoint = java.net.URI("ws", null, control.host, data.port, data.path, null, null).toString()
            require(localEndpoint(endpoint)); msg.put("localUrl", endpoint)
        }
        if (store.addOffer(pair, msg, localTransport)) return null
        return when (store.task(msg.getString("transferId"))?.getString("state")) { "complete" -> "received"; "paused", "cancelled" -> "paused"; else -> null }
    }
}

/** Phone to trusted computer: offers an accepted private v2 send to a computer running `cdx receive --paired`. */
object TrustedSend {
    const val LISTEN_COMMAND = "cdx receive --paired"
    private const val CONNECT_TIMEOUT_MS = 8_000L
    /** Unanswered on one link this long, try the next ready one (a stalled LAN link fails over to the relay). */
    private const val LINK_ANSWER_MS = 4_000L
    private const val TOTAL_TIMEOUT_MS = 20_000L
    private val client by lazy { OkHttpClient.Builder().connectTimeout(4, TimeUnit.SECONDS).readTimeout(0, TimeUnit.SECONDS).pingInterval(15, TimeUnit.SECONDS).build() }

    /** Every pairing can receive; computers just need a cdx with `receive --paired` running. */
    fun canReceive(pair: Pairing): Boolean = true

    /** Validates and builds the authenticated share message. Pure, so it is unit tested. */
    internal fun shareMessage(privateLink: String, name: String, size: Long): JSONObject {
        val invitation = Invitation.parse(privateLink)
        require(invitation.version == 2) { "Only private links can be sent to a computer" }
        require(size >= 0 && size <= (1L shl 53) - 1) { "Invalid file size" }
        val filename = name.substringAfterLast('/').substringAfterLast('\\')
        require(filename.isNotEmpty() && filename != "." && filename != ".." && filename.length <= 1024 && '\u0000' !in filename) { "Invalid filename" }
        return JSONObject().put("type", "share").put("transferId", invitation.id).put("url", privateLink.trim()).put("filename", filename).put("size", size.toString())
    }

    internal fun seal(pair: Pairing, message: JSONObject, now: Long = System.currentTimeMillis()): ByteArray =
        pair.seal(JSONObject(message.toString()).put("version", 1).put("messageId", Crypto.encode(Crypto.random(16))).put("expiresAt", now + 300_000))

    /**
     * Blocking: delivers the share over a LAN or relay control link and waits until the computer
     * queues it. Throws IllegalStateException with a user-safe message (no keys or links).
     */
    fun offer(context: Context, pair: Pairing, privateLink: String, name: String, size: Long) {
        val share = shareMessage(privateLink, name, size)
        val transferId = share.getString("transferId")
        val hold = ControlHub.hold()
        val signals = ControlHub.watch(pair.id)
        val own = mutableListOf<WebSocket>()
        val ownUrls = HashSet<String>()
        val relayUrl = pair.json.getString("relayUrl")
        try {
            val endpoints = buildList {
                pair.json.optJSONArray("localUrls")?.let { urls -> repeat(urls.length()) { add(urls.getString(it) to true) } }
                add(pair.json.getString("relayUrl") to false)
            }
            endpoints.filter { (url, local) -> validEndpoint(url) && (!local || localEndpoint(url)) && !ControlHub.hasLink(pair.id, url) }
                .forEach { (url, local) -> own += open(context, pair, url, local); ownUrls += url }
            val start = System.currentTimeMillis()
            val ready = LinkedHashSet<WebSocket>()
            val tried = HashSet<WebSocket>()
            var sentOn: WebSocket? = null
            var sentAt = 0L
            fun sendNext() {
                // Prefer links not tried yet; once all were tried, retry the oldest. The computer dedupes by transfer.
                val next = ready.firstOrNull { it !in tried && it !== sentOn } ?: ready.firstOrNull { it !== sentOn } ?: return
                tried += next
                if (next.send(ByteString.of(*seal(pair, share)))) { sentOn = next; sentAt = System.currentTimeMillis() }
                else { ready -= next; sendNext() }
            }
            while (true) {
                val now = System.currentTimeMillis()
                val deadline = when {
                    sentOn == null && tried.isEmpty() -> start + CONNECT_TIMEOUT_MS
                    sentOn != null && ready.size > 1 -> minOf(sentAt + LINK_ANSWER_MS, start + TOTAL_TIMEOUT_MS)
                    else -> start + TOTAL_TIMEOUT_MS
                }
                val signal = if (deadline > now) signals.poll(deadline - now, TimeUnit.MILLISECONDS) else null
                if (signal == null) {
                    if (System.currentTimeMillis() < start + TOTAL_TIMEOUT_MS && sentOn != null && ready.size > 1) { sendNext(); continue }
                    throw IllegalStateException(if (tried.isEmpty()) "${pair.name} isn't listening. Run $LISTEN_COMMAND on it." else "${pair.name} didn't answer. Check $LISTEN_COMMAND on it.")
                }
                when (signal) {
                    is ControlHub.Signal.Ready -> { ready += signal.socket; if (sentOn == null) sendNext() }
                    is ControlHub.Signal.Gone -> {
                        ready -= signal.socket
                        // The service closed a link this send relied on (stopped, or its network dropped): open our own.
                        val url = signal.url
                        if (url != null && signal.socket !in own && url !in ownUrls && !ControlHub.hasLink(pair.id, url)) {
                            own += open(context, pair, url, url != relayUrl); ownUrls += url
                        }
                        if (signal.socket === sentOn) { sentOn = null; sendNext() }
                    }
                    is ControlHub.Signal.Reply -> if (signal.message.optString("transferId") == transferId) when (signal.message.getString("type")) {
                        "receiving", "received" -> return
                        "paused" -> throw IllegalStateException("${pair.name} declined the file. Check $LISTEN_COMMAND on it.")
                    }
                }
            }
        } finally {
            hold.close()
            ControlHub.unwatch(pair.id, signals)
            own.forEach { it.close(1000, "Offer delivered") }
        }
    }

    private fun reply(webSocket: WebSocket, pair: Pairing, type: String, transferId: String) {
        webSocket.send(ByteString.of(*seal(pair, JSONObject().put("type", type).put("transferId", transferId))))
    }

    private fun open(context: Context, pair: Pairing, url: String, local: Boolean): WebSocket {
        val join = ControlJoin(pair, local)
        return client.newWebSocket(Request.Builder().url(url).build(), object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) { join.initial()?.let { webSocket.send(it.toString()) } }
            override fun onMessage(webSocket: WebSocket, text: String) {
                runCatching {
                    require(text.length <= 16384)
                    val event = JSONObject(text)
                    join.event(event)?.let { webSocket.send(it.toString()) }
                    when (event.getString("type")) {
                        "accepted" -> ControlHub.admitted(pair.id, url, webSocket)
                        "peer-joined" -> ControlHub.peer(pair.id, webSocket, true)
                        "peer-left" -> ControlHub.peer(pair.id, webSocket, false)
                    }
                }.onFailure { webSocket.cancel(); ControlHub.removed(pair.id, webSocket) }
            }
            override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
                runCatching {
                    require(join.admitted)
                    val msg = pair.open(bytes.toByteArray())
                    if (msg.getString("type") != "offer") { ControlHub.message(pair.id, msg); return@runCatching }
                    // The computer offered a file while this short-lived socket held the phone's slot.
                    // Queue it like the service would and start the service to receive it.
                    val transferId = msg.getString("transferId")
                    if (ReceiveControl.paused(context)) { reply(webSocket, pair, "paused", transferId); return@runCatching }
                    OfferIntake.accept(StoreRegistry.get(context), pair, url, local, msg)?.let { reply(webSocket, pair, it, transferId) }
                    ReceiveControl.connect(context)
                }.onFailure { webSocket.cancel(); ControlHub.removed(pair.id, webSocket) }
            }
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) = ControlHub.removed(pair.id, webSocket)
            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = ControlHub.removed(pair.id, webSocket)
        })
    }
}

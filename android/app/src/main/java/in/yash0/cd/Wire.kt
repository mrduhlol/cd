package `in`.yash0.cd

import okhttp3.*
import okio.ByteString
import okio.ByteString.Companion.toByteString
import org.json.JSONObject
import java.io.Closeable
import java.io.IOException
import java.util.concurrent.TimeUnit

/** phase "failed": [status] is the HTTP status of a refused upgrade (null for network errors, see cause). phase "closed": [status] is the close code. */
class WireFailure(val phase: String, val status: Int? = null, cause: Throwable? = null, val expired: Boolean = false, val exhausted: Boolean = false, val reason: String? = null): IOException("WebSocket $phase", cause) {
    companion object {
        fun closed(code: Int, reason: String) = WireFailure("closed", code, expired = code == 4408 && reason == "transfer expired", exhausted = code == 4410 && reason == "transfer session limit reached", reason = reason.take(123))
    }
}

/** No frame arrived in time while the socket itself was still healthy. Message kept for existing receiver diagnostics. */
class WireTimeout: IOException("Peer timed out")

sealed interface Frame {
    data class Text(val text: String): Frame
    data class Binary(val bytes: ByteArray): Frame
    data class Failed(val error: Exception): Frame
}
class Wire(client: OkHttpClient, url: String, private val onSocket: (WebSocket) -> Unit): Closeable {
    private val closed = java.util.concurrent.CountDownLatch(1)
    private val frames = BackpressureQueue<Frame>(8)
    @Volatile private var failed = false
    private fun fail(error: IOException = IOException("Connection closed")) { failed = true; frames.close(error) }
    val socket: WebSocket
    init {
        require(validEndpoint(url))
        socket = client.newWebSocket(Request.Builder().url(url).build(), object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) { onSocket(webSocket) }
            private fun offer(ws: WebSocket, frame: Frame) { try { frames.put(frame) } catch (e: Exception) { fail(IOException("Socket inbox stopped", e)); ws.cancel() } }
            override fun onMessage(webSocket: WebSocket, text: String) { if (text.length > 16384) { fail(IOException("Control frame too large")); webSocket.cancel(); return }; offer(webSocket, Frame.Text(text)) }
            override fun onMessage(webSocket: WebSocket, bytes: ByteString) { if (bytes.size > 1048576) { fail(IOException("Data frame too large")); webSocket.cancel(); return }; offer(webSocket, Frame.Binary(bytes.toByteArray())) }
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) { closed.countDown(); fail(WireFailure("failed", response?.code, t, expired = response?.code == 410)) }
            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) { fail(WireFailure.closed(code, reason)); webSocket.close(code, "") }
            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) { closed.countDown(); fail(WireFailure.closed(code, reason)) }
        })
    }
    fun next(seconds: Long = 90): Frame {
        val f = try { frames.take(TimeUnit.SECONDS.toMillis(seconds)) } catch (e: IOException) { if (failed) throw e else throw WireTimeout() }
        return when (f) { is Frame.Failed -> throw f.error; else -> f }
    }
    fun json(seconds: Long = 90): JSONObject { val frame = next(seconds); require(frame is Frame.Text); return JSONObject(frame.text).also(ReceiveGate::event) }
    fun send(json: JSONObject) { if (!socket.send(json.toString())) throw IOException("Socket closed") }
    fun send(bytes: ByteArray) { if (!socket.send(bytes.toByteString())) throw IOException("Socket closed") }
    fun direct(record: ByteArray) { frames.put(Frame.Binary(record)) }
    fun abort(error: IOException) { fail(error); socket.cancel() }
    fun finish() { socket.close(1000, "complete"); closed.await(3, TimeUnit.SECONDS) }
    override fun close() { fail(); socket.cancel() }
}

package `in`.yash0.cd

import okhttp3.*
import okio.ByteString
import org.json.JSONObject
import java.io.Closeable
import java.io.IOException
import java.util.concurrent.TimeUnit

class WireFailure(val phase: String, val status: Int? = null, cause: Throwable? = null, val expired: Boolean = false, val exhausted: Boolean = false): IOException("WebSocket $phase", cause) {
    companion object {
        fun closed(code: Int, reason: String) = WireFailure("closed", code, expired = code == 4408 && reason == "transfer expired", exhausted = code == 4410 && reason == "transfer session limit reached")
    }
}

sealed interface Frame {
    data class Text(val text: String): Frame
    data class Binary(val bytes: ByteArray): Frame
    data class Failed(val error: Exception): Frame
}
class Wire(client: OkHttpClient, url: String, private val onSocket: (WebSocket) -> Unit): Closeable {
    private val frames = BackpressureQueue<Frame>(8)
    val socket: WebSocket
    init {
        require(validEndpoint(url))
        socket = client.newWebSocket(Request.Builder().url(url).build(), object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) { onSocket(webSocket) }
            private fun offer(ws: WebSocket, frame: Frame) { try { frames.put(frame) } catch (e: Exception) { frames.close(IOException("Socket inbox stopped", e)); ws.cancel() } }
            override fun onMessage(webSocket: WebSocket, text: String) { if (text.length > 16384) { frames.close(IOException("Control frame too large")); webSocket.cancel(); return }; offer(webSocket, Frame.Text(text)) }
            override fun onMessage(webSocket: WebSocket, bytes: ByteString) { if (bytes.size > 1048576) { frames.close(IOException("Data frame too large")); webSocket.cancel(); return }; offer(webSocket, Frame.Binary(bytes.toByteArray())) }
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) { frames.close(WireFailure("failed", response?.code, t, expired = response?.code == 410)) }
            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) { frames.close(WireFailure.closed(code, reason)); webSocket.close(code, "") }
            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) { frames.close(WireFailure.closed(code, reason)) }
        })
    }
    fun next(seconds: Long = 90): Frame = when (val f = frames.take(TimeUnit.SECONDS.toMillis(seconds))) { is Frame.Failed -> throw f.error; else -> f }
    fun json(seconds: Long = 90): JSONObject { val frame = next(seconds); require(frame is Frame.Text); return JSONObject(frame.text).also(ReceiveGate::event) }
    fun send(json: JSONObject) { if (!socket.send(json.toString())) throw IOException("Socket closed") }
    fun send(bytes: ByteArray) { if (!socket.send(ByteString.of(*bytes))) throw IOException("Socket closed") }
    fun direct(record: ByteArray) { frames.put(Frame.Binary(record)) }
    fun abort(error: IOException) { frames.close(error); socket.cancel() }
    fun finish() {
        socket.close(1000, "done")
        runCatching { next(3) }
    }
    override fun close() { frames.close(); socket.cancel() }
}

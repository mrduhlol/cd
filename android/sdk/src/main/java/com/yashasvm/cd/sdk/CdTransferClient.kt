package com.yashasvm.cd.sdk

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import org.json.JSONObject
import java.io.Closeable
import java.io.InputStream
import java.io.OutputStream
import java.net.URI
import java.util.Collections
import java.util.concurrent.TimeUnit

/** File metadata and a repeatable byte source supplied by the host app. */
data class CdFileSource(
    val name: String,
    val mediaType: String,
    val sizeBytes: Long,
    val open: () -> InputStream,
)

data class CdFileOffer internal constructor(val name: String, val mediaType: String, val sizeBytes: Long, internal val chunkSize: Int)

enum class CdTransferPhase { CONNECTING, WAITING_FOR_RECIPIENT, WAITING_FOR_ACCEPTANCE, TRANSFERRING, VERIFYING, COMPLETE }
data class CdTransferProgress(val phase: CdTransferPhase, val transferredBytes: Long, val totalBytes: Long)

class CdTransferRejectedException : IllegalStateException("The recipient rejected the transfer")

/**
 * Client for CD's live, one-sender/one-recipient encrypted relay protocol.
 * [applicationId] is public attribution metadata and is never used as a secret or authorization token.
 */
class CdTransferClient(
    applicationId: String,
    private val serviceOrigin: String = "https://cd.yash0.in",
    private val client: OkHttpClient = OkHttpClient.Builder()
        .pingInterval(20, TimeUnit.SECONDS)
        .build(),
) : Closeable {
    private val sockets = Collections.newSetFromMap(java.util.concurrent.ConcurrentHashMap<RelaySocket, Boolean>())
    @Volatile private var closed = false
    private val appId = applicationId.also {
        require(it.matches(Regex("[A-Za-z0-9][A-Za-z0-9._:-]{2,159}"))) { "Use a public reverse-domain app ID" }
    }
    private val origin: String = serviceOrigin.trimEnd('/').also { raw ->
        val uri = URI(raw)
        require(uri.host != null && uri.userInfo == null && uri.query == null && uri.fragment == null && uri.path.isNullOrEmpty())
        require(uri.scheme == "https" || (uri.scheme == "http" && (uri.host == "localhost" || uri.host == "127.0.0.1")))
    }

    /** Sends one file and returns only after CD confirms the recipient verified the full byte count. */
    suspend fun send(
        source: CdFileSource,
        onInvitation: (String) -> Unit,
        onProgress: (CdTransferProgress) -> Unit = {},
    ) {
        validateSource(source)
        val invite = CdInvitation.create(origin)
        val sender = CdRecordSealer(invite, sender = true)
        val receiver = CdRecordOpener(invite, sender = false)
        val socket = connect(invite)
        try {
            emit(onProgress, CdTransferPhase.CONNECTING, 0, source.sizeBytes)
            socket.send(JSONObject().put("type", "join").put("protocol", "cd-transfer-v1")
                .put("role", "sender").put("receiverTokenHash", CdInvitation.encode(sha256(receiverToken(invite)))).toString())
            awaitRelayEvent(socket, "accepted", 10_000)
            onInvitation(invite.url)
            emit(onProgress, CdTransferPhase.WAITING_FOR_RECIPIENT, 0, source.sizeBytes)
            awaitRelayEvent(socket, "peer-joined", 10 * 60_000L)
            val offerBytes = JSONObject().put("name", source.name).put("mediaType", source.mediaType)
                .put("size", source.sizeBytes.toString()).put("chunkSize", SDK_CHUNK_SIZE).toString().toByteArray()
            socket.send(sender.seal(KIND_OFFER, offerBytes))
            emit(onProgress, CdTransferPhase.WAITING_FOR_ACCEPTANCE, 0, source.sizeBytes)
            val selectedChunk = withTimeout(10 * 60_000L) {
                while (true) {
                    when (val frame = socket.receive()) {
                        is Frame.Text -> when (relayEvent(frame.value)) {
                            "peer-left" -> throw IllegalStateException("The recipient disconnected")
                            "accepted", "peer-joined" -> Unit
                            else -> Unit
                        }
                        is Frame.Binary -> {
                            val (kind, payload) = receiver.open(frame.value)
                            require(kind == KIND_ACCEPT) { "Expected recipient acceptance" }
                            if (payload.isEmpty()) return@withTimeout SDK_CHUNK_SIZE
                            val selection = JSONObject(payload.toString(Charsets.UTF_8))
                            require(selection.length() == 1 && selection.getInt("chunkSize") == SDK_CHUNK_SIZE)
                            return@withTimeout SDK_CHUNK_SIZE
                        }
                        else -> Unit
                    }
                }
                error("unreachable")
            }
            emit(onProgress, CdTransferPhase.TRANSFERRING, 0, source.sizeBytes)
            var sentBytes = 0L
            var ackedBytes = 0L
            var sentChunks = 0L
            var ackedChunks = 0L
            withContext(Dispatchers.IO) { source.open().use { input ->
                val buffer = ByteArray(selectedChunk)
                while (sentBytes < source.sizeBytes) {
                    val wanted = minOf(buffer.size.toLong(), source.sizeBytes - sentBytes).toInt()
                    readFully(input, buffer, wanted)
                    socket.send(sender.seal(KIND_CHUNK, if (wanted == buffer.size) buffer else buffer.copyOf(wanted)))
                    sentBytes += wanted
                    sentChunks++
                    emit(onProgress, CdTransferPhase.TRANSFERRING, ackedBytes, source.sizeBytes)
                    if (sentBytes - ackedBytes >= 4 * ACK_INTERVAL_BYTES || sentBytes == source.sizeBytes) {
                        while (ackedBytes < sentBytes) {
                            val (kind, payload) = withTimeout(90_000L) { nextRecord(socket, receiver) }
                            if (kind != KIND_ACK) throw IllegalStateException("Expected recipient acknowledgement")
                            val counts = decodeCounts(payload)
                            require(counts.bytes in (ackedBytes + 1)..sentBytes && counts.chunks in (ackedChunks + 1)..sentChunks)
                            ackedBytes = counts.bytes
                            ackedChunks = counts.chunks
                            emit(onProgress, CdTransferPhase.TRANSFERRING, ackedBytes, source.sizeBytes)
                        }
                    }
                }
                require(input.read() == -1) { "File source contains more bytes than declared" }
            } }
            socket.send(sender.seal(KIND_END, encodeCounts(sentChunks, sentBytes)))
            emit(onProgress, CdTransferPhase.VERIFYING, sentBytes, source.sizeBytes)
            withTimeout(90_000L) {
                while (true) {
                    val (kind, payload) = nextRecord(socket, receiver)
                    if (kind == KIND_ACK) continue
                    require(kind == KIND_COMPLETE) { "Expected recipient completion" }
                    val complete = decodeCounts(payload)
                    require(complete.bytes == source.sizeBytes && complete.chunks == sentChunks) { "Recipient verified different transfer totals" }
                    break
                }
            }
            emit(onProgress, CdTransferPhase.COMPLETE, source.sizeBytes, source.sizeBytes)
        } catch (cancelled: CancellationException) {
            throw cancelled
        } finally {
            release(socket)
        }
    }

    /** Receives a transfer after [acceptOffer] explicitly approves the encrypted offer. */
    suspend fun receive(
        invitation: String,
        acceptOffer: suspend (CdFileOffer) -> Boolean,
        openDestination: suspend (CdFileOffer) -> OutputStream,
        onProgress: (CdTransferProgress) -> Unit = {},
    ) {
        val invite = CdInvitation.parse(invitation, origin)
        val sender = CdRecordOpener(invite, sender = true)
        val receiver = CdRecordSealer(invite, sender = false)
        val socket = connect(invite)
        var destination: OutputStream? = null
        try {
            emit(onProgress, CdTransferPhase.CONNECTING, 0, 0)
            socket.send(JSONObject().put("type", "join").put("protocol", "cd-transfer-v1")
                .put("role", "receiver").put("receiverToken", CdInvitation.encode(receiverToken(invite))).toString())
            awaitRelayEvent(socket, "accepted", 15_000L)
            emit(onProgress, CdTransferPhase.WAITING_FOR_ACCEPTANCE, 0, 0)
            val (kind, offerData) = withTimeout(15 * 60_000L) { nextRecord(socket, sender) }
            require(kind == KIND_OFFER) { "Sender did not offer a file" }
            val offer = parseOffer(offerData)
            if (!acceptOffer(offer)) {
                socket.close(1000, "rejected")
                throw CdTransferRejectedException()
            }
            destination = openDestination(offer)
            socket.send(receiver.seal(KIND_ACCEPT))
            emit(onProgress, CdTransferPhase.TRANSFERRING, 0, offer.sizeBytes)
            var bytes = 0L
            var chunks = 0L
            var acknowledged = 0L
            while (true) {
                val (messageKind, payload) = withTimeout(90_000L) { nextRecord(socket, sender) }
                when (messageKind) {
                    KIND_CHUNK -> {
                        require(payload.isNotEmpty() && payload.size <= offer.chunkSize && bytes + payload.size <= offer.sizeBytes)
                        withContext(Dispatchers.IO) { requireNotNull(destination).write(payload) }
                        bytes += payload.size
                        chunks++
                        emit(onProgress, CdTransferPhase.TRANSFERRING, bytes, offer.sizeBytes)
                        if (bytes - acknowledged >= ACK_INTERVAL_BYTES || bytes == offer.sizeBytes) {
                            socket.send(receiver.seal(KIND_ACK, encodeCounts(chunks, bytes)))
                            acknowledged = bytes
                        }
                    }
                    KIND_END -> {
                        val ending = decodeCounts(payload)
                        require(ending.bytes == offer.sizeBytes && ending.bytes == bytes && ending.chunks == chunks)
                        withContext(Dispatchers.IO) { requireNotNull(destination).flush(); requireNotNull(destination).close() }
                        destination = null
                        emit(onProgress, CdTransferPhase.VERIFYING, bytes, offer.sizeBytes)
                        socket.send(receiver.seal(KIND_COMPLETE, encodeCounts(chunks, bytes)))
                        emit(onProgress, CdTransferPhase.COMPLETE, bytes, offer.sizeBytes)
                        return
                    }
                    else -> error("Unexpected sender record")
                }
            }
        } catch (cancelled: CancellationException) {
            throw cancelled
        } finally {
            withContext(NonCancellable + Dispatchers.IO) { runCatching { destination?.close() } }
            release(socket)
        }
    }

    private suspend fun connect(invite: CdInvitation): RelaySocket {
        val endpoint = origin.replaceFirst("https://", "wss://").replaceFirst("http://", "ws://") + "/ws/v1/${CdInvitation.encode(invite.transferId)}"
        val request = Request.Builder().url(endpoint).header("X-CD-App-ID", appId).build()
        check(!closed) { "CD transfer client is closed" }
        val socket = RelaySocket()
        sockets.add(socket)
        try {
            socket.attach(client.newWebSocket(request, socket.listener))
            withTimeout(15_000L) {
                while (true) when (socket.receive()) {
                    Frame.Open -> return@withTimeout
                    is Frame.Failure -> error("Could not connect to the CD relay")
                    is Frame.Closed -> error("CD relay closed the connection")
                    else -> Unit
                }
            }
            return socket
        } catch (failure: Throwable) {
            release(socket)
            throw failure
        }
    }

    override fun close() {
        closed = true
        sockets.toList().forEach(::release)
    }

    private fun release(socket: RelaySocket) {
        sockets.remove(socket)
        socket.close()
    }

    private fun validateSource(source: CdFileSource) {
        require(source.name.toByteArray(Charsets.UTF_8).size in 1..255)
        require(source.name !in setOf(".", "..") && source.name.none { it == '/' || it == '\\' || it.code < 32 })
        require(source.mediaType.matches(Regex("[A-Za-z0-9!#$&^_.+-]+/[A-Za-z0-9!#$&^_.+-]+")) && source.mediaType.length <= 127)
        require(source.sizeBytes in 0..MAX_SAFE_SIZE)
    }

    private fun parseOffer(bytes: ByteArray): CdFileOffer {
        val json = JSONObject(bytes.toString(Charsets.UTF_8))
        val name = json.getString("name")
        val mediaType = json.getString("mediaType")
        val sizeText = json.getString("size")
        val size = sizeText.toLongOrNull() ?: error("Invalid file size")
        val chunk = json.getInt("chunkSize")
        require(name.toByteArray(Charsets.UTF_8).size in 1..255 && name !in setOf(".", "..") && name.none { it == '/' || it == '\\' || it.code < 32 })
        require(mediaType.length in 1..127 && mediaType.matches(Regex("[A-Za-z0-9!#$&^_.+-]+/[A-Za-z0-9!#$&^_.+-]+")))
        require(sizeText == size.toString() && size in 0..MAX_SAFE_SIZE && chunk in setOf(64 * 1024, SDK_CHUNK_SIZE, 768 * 1024))
        return CdFileOffer(name, mediaType, size, chunk)
    }

    private fun emit(callback: (CdTransferProgress) -> Unit, phase: CdTransferPhase, bytes: Long, total: Long) {
        callback(CdTransferProgress(phase, bytes, total))
    }

    private suspend fun awaitRelayEvent(socket: RelaySocket, expected: String, timeout: Long) = withTimeout(timeout) {
        while (true) {
            when (val frame = socket.receive()) {
                is Frame.Text -> {
                    val event = relayEvent(frame.value)
                    if (event == expected) return@withTimeout
                    if (event == "peer-left") error("The other participant disconnected")
                }
                is Frame.Failure -> throw frame.error
                is Frame.Closed -> error("CD relay closed the connection")
                else -> Unit
            }
        }
        error("unreachable")
    }

    private suspend fun nextRecord(socket: RelaySocket, opener: CdRecordOpener): Pair<Int, ByteArray> {
        while (true) when (val frame = socket.receive()) {
            is Frame.Binary -> return opener.open(frame.value)
            is Frame.Text -> if (relayEvent(frame.value) == "peer-left") error("The other participant disconnected")
            is Frame.Failure -> throw frame.error
            is Frame.Closed -> error("CD relay closed the connection")
            else -> Unit
        }
    }

    private fun relayEvent(text: String): String = JSONObject(text).let {
        require(it.optString("protocol") == "cd-transfer-v1")
        it.optString("type")
    }

    private fun readFully(input: InputStream, bytes: ByteArray, length: Int) {
        var offset = 0
        while (offset < length) {
            val read = input.read(bytes, offset, length - offset)
            if (read < 0) throw IllegalStateException("File source ended before its declared size")
            if (read == 0) {
                val one = input.read()
                if (one < 0) throw IllegalStateException("File source ended before its declared size")
                bytes[offset++] = one.toByte()
            } else offset += read
        }
    }

    private fun sha256(bytes: ByteArray): ByteArray = java.security.MessageDigest.getInstance("SHA-256").digest(bytes)
}

private sealed interface Frame {
    data object Open : Frame
    data class Text(val value: String) : Frame
    data class Binary(val value: ByteArray) : Frame
    data class Failure(val error: Throwable) : Frame
    data object Closed : Frame
}

private class RelaySocket {
    private val frames = Channel<Frame>(64)
    private lateinit var socket: WebSocket
    val listener = object : WebSocketListener() {
        private fun offer(frame: Frame) {
            if (frames.trySend(frame).isFailure) {
                frames.close(IllegalStateException("CD relay receive queue overflowed"))
                if (::socket.isInitialized) socket.cancel()
            }
        }
        override fun onOpen(webSocket: WebSocket, response: Response) {
            socket = webSocket
            offer(Frame.Open)
        }
        override fun onMessage(webSocket: WebSocket, text: String) {
            if (text.toByteArray(Charsets.UTF_8).size > 65_536) { webSocket.close(1009, "control too large"); return }
            offer(Frame.Text(text))
        }
        override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
            if (bytes.size > 1_048_576) { webSocket.close(1009, "record too large"); return }
            offer(Frame.Binary(bytes.toByteArray()))
        }
        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) { offer(Frame.Failure(t)) }
        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) { offer(Frame.Closed) }
    }
    fun attach(value: WebSocket) { socket = value }
    suspend fun receive(): Frame = frames.receive()
    fun send(text: String) { check(socket.send(text)) { "CD relay send queue is closed" } }
    fun send(bytes: ByteArray) { check(socket.send(ByteString.of(*bytes))) { "CD relay send queue is closed" } }
    fun close(code: Int = 1000, reason: String = "complete") {
        if (::socket.isInitialized) socket.close(code, reason)
        frames.close()
    }
}

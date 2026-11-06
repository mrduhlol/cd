package `in`.yash0.cd

import android.content.Context
import okhttp3.OkHttpClient
import okhttp3.WebSocket
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.nio.ByteBuffer
import java.security.MessageDigest

internal class OrdinaryReceiver(private val context: Context, private val store: Store, private val client: OkHttpClient, private val activeSocket: (WebSocket?) -> Unit, private val progress: (String, Long, Long) -> Unit, private val shouldContinue: () -> Boolean, private val diagnostic: (String) -> Unit) {
    private fun active() { if (!shouldContinue()) throw UserPausedException() }
    fun receive(task: JSONObject, endpoint: String) {
        val invitation = Invitation.parse(task.getString("url"))
        require(invitation.version == 1)
        var direct: DirectReceiver? = null
        try { Wire(client, endpoint) { socket ->
            activeSocket(socket)
            socket.send(JSONObject().put("type", "join").put("protocol", "cd-transfer-v1").put("role", "receiver").put("receiverToken", Crypto.encode(invitation.token())).toString())
            diagnostic("join-sent")
        }.use { wire ->
            val opener = Records(invitation, byteArrayOf(), byteArrayOf(), true)
            val writer = RecordWriter(Records(invitation, byteArrayOf(), byteArrayOf(), false), wire::send)
            fun nextRecord(): Pair<Int, ByteArray> {
                while (true) {
                    active()
                    when (val frame = wire.next()) {
                        is Frame.Binary -> return opener.open(frame.bytes)
                        is Frame.Text -> {
                            val event = JSONObject(frame.text)
                            require(event.getString("protocol") == "cd-transfer-v1")
                            if (event.getString("type") == "peer-left") throw java.io.IOException("Sender disconnected")
                        }
                        else -> error("Disconnected")
                    }
                }
            }
            val (kind, bytes) = nextRecord()
            require(kind == 1) { "Expected a file offer" }
            val json = JSONObject(String(bytes))
            val offer = OrdinaryOffer.parse(json)
            StorageBudget.check(context, offer.size, 0)
            val stage = File(context.filesDir, "resume-${invitation.id}.part")
            val whole = MessageDigest.getInstance("SHA-256")
            var written = 0L
            var chunks = 0
            fun receivedCounts(): ByteArray = ByteBuffer.allocate(12).putInt(chunks).putLong(written).array()
            writer.send(4, "{}".toByteArray())
            json.optJSONObject("direct")?.optString("sdp")?.takeIf { it.isNotEmpty() }?.let { sdp ->
                direct = DirectReceiver(context, store.allowedMobile(), { signal -> writer.send(9, signal.toString().toByteArray()) }, wire::direct, wire::abort, diagnostic).also { it.start(sdp) }
            }
            diagnostic("file-accepted")
            FileOutputStream(stage).use { output ->
                while (true) {
                    val (recordKind, data) = nextRecord()
                    active()
                    if (recordKind == 2) {
                        offer.checkChunk(written, data.size)
                        output.write(data); whole.update(data); written += data.size; chunks++
                        writer.send(5, receivedCounts())
                        progress(offer.name, written, offer.size)
                    } else {
                        require(recordKind == 3 && written == offer.size && MessageDigest.isEqual(data, receivedCounts())) { "Final size or chunk count failed verification" }
                        writer.stopSignals()
                        output.fd.sync()
                        val digest = Crypto.hex(whole.digest())
                        store.offered(task.getString("id"), offer.name, offer.size, digest, 0)
                        task.put("wholeSha256", digest)
                        publishDownload(context, store, task, stage, offer.name, offer.size, ::active)
                        diagnostic("published")
                        writer.send(6, receivedCounts())
                        wire.finish()
                        stage.delete()
                        return
                    }
                }
            }
        } } finally { direct?.close() }
    }
}

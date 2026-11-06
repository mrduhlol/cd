package `in`.yash0.cd

import android.content.Context
import okhttp3.OkHttpClient
import okhttp3.WebSocket
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.nio.ByteBuffer
import java.security.MessageDigest

class LegacyReceiver(
    private val context: Context,
    private val store: Store,
    private val client: OkHttpClient,
    private val activeSocket: (WebSocket?) -> Unit,
    private val progress: (String, Long, Long) -> Unit,
    private val active: () -> Boolean,
) {
    fun receive(task: JSONObject, endpoint: String) {
        val invitation = Invitation.parse(task.getString("url"))
        require(invitation.version == 1)
        val id = invitation.id
        val stage = File(context.filesDir, "legacy-$id.part")
        try {
            Wire(client, endpoint) { activeSocket(it) }.use { wire ->
                wire.send(JSONObject().put("type", "join").put("protocol", "cd-transfer-v1").put("role", "receiver").put("receiverToken", Crypto.encode(invitation.token())))
                val opener = Records(invitation, byteArrayOf(), byteArrayOf(), true)
                val sealer = Records(invitation, byteArrayOf(), byteArrayOf(), false)
                fun next(): Pair<Int, ByteArray> {
                    while (true) {
                        check(active())
                        when (val frame = wire.next()) {
                            is Frame.Binary -> return opener.open(frame.bytes)
                            is Frame.Text -> {
                                val event = JSONObject(frame.text)
                                require(event.getString("protocol") == "cd-transfer-v1")
                                require(event.getString("type") in listOf("accepted", "peer-joined")) { "Sender disconnected. Ask for a new code or link." }
                            }
                            is Frame.Failed -> throw frame.error
                        }
                    }
                }
                val offered = next()
                require(offered.first == 1) { "Missing file offer" }
                val offer = JSONObject(String(offered.second))
                val validated = OrdinaryOffer.parse(offer)
                val name = validated.name
                val size = validated.size
                // Bundles retain their ZIP filename so every entry remains available.
                store.putTask(task.put("resumable", false))
                store.offered(id, name, size, "", 0)
                store.state(id, "receiving")
                StorageBudget.check(context, size, 0, false)
                var received = 0L
                var chunks = 0
                val digest = MessageDigest.getInstance("SHA-256")
                fun counts() = ByteBuffer.allocate(12).putInt(chunks).putLong(received).array()
                FileOutputStream(stage).use { output ->
                    wire.send(sealer.seal(4, byteArrayOf()))
                    while (true) {
                        val (kind, bytes) = next()
                        when (kind) {
                            2 -> {
                                validated.checkChunk(received, bytes.size)
                                output.write(bytes); digest.update(bytes)
                                received += bytes.size; chunks++
                                progress(name, received, size)
                                wire.send(sealer.seal(5, counts()))
                            }
                            3 -> {
                                require(received == size && bytes.contentEquals(counts())) { "Transfer ended before the complete file arrived" }
                                output.fd.sync()
                                check(active())
                                store.state(id, "verifying")
                                publishDownload(context, store, task.put("wholeSha256", Crypto.hex(digest.digest())), stage, name, size) { check(active()) }
                                wire.send(sealer.seal(6, counts()))
                                wire.finish()
                                return
                            }
                            else -> error("Unexpected transfer record")
                        }
                    }
                }
            }
        } finally { stage.delete(); activeSocket(null) }
    }
}

package `in`.yash0.cd

import android.content.ContentValues
import android.content.Context
import android.os.Environment
import android.provider.MediaStore
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
                val name = offer.getString("name")
                require(name.length in 1..255 && name !in listOf(".", "..") && name.none { it == '/' || it == '\\' || it.code < 32 }) { "Unsafe filename" }
                val size = offer.getString("size").toLong()
                require(size in 0..9007199254740991L && offer.getInt("chunkSize") in listOf(65536, 262144)) { "Invalid file offer" }
                // Bundles retain their ZIP filename so every entry remains available.
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
                                require(bytes.isNotEmpty() && bytes.size <= offer.getInt("chunkSize") && received + bytes.size <= size) { "File exceeds its promised size" }
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
                                publish(id, stage, name, size, Crypto.hex(digest.digest()))
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

    private fun publish(id: String, stage: File, name: String, size: Long, digest: String) {
        val resolver = context.contentResolver
        val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, ContentValues().apply {
            put(MediaStore.MediaColumns.DISPLAY_NAME, name)
            put(MediaStore.MediaColumns.MIME_TYPE, "application/octet-stream")
            put(MediaStore.MediaColumns.RELATIVE_PATH, "${Environment.DIRECTORY_DOWNLOADS}/CD")
            put(MediaStore.MediaColumns.IS_PENDING, 1)
        }) ?: error("Could not create Downloads file")
        var published = false
        try {
            resolver.openFileDescriptor(uri, "w")!!.use { descriptor ->
                FileOutputStream(descriptor.fileDescriptor).use { output ->
                    stage.inputStream().use { input ->
                        val buffer = ByteArray(262144)
                        while (true) { check(active()); val n = input.read(buffer); if (n < 0) break; output.write(buffer, 0, n) }
                    }
                    output.fd.sync()
                }
            }
            check(active())
            store.publication(id, uri.toString(), digest)
            check(resolver.update(uri, ContentValues().apply { put(MediaStore.MediaColumns.IS_PENDING, 0) }, null, null) == 1)
            published = true
            store.completed(id, uri.toString(), name, size)
        } finally { if (!published) resolver.delete(uri, null, null) }
    }
}

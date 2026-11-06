package `in`.yash0.cd

import android.content.ContentValues
import android.content.Context
import android.net.Uri
import android.os.Environment
import android.provider.MediaStore
import android.util.AtomicFile
import okhttp3.OkHttpClient
import okhttp3.WebSocket
import org.json.JSONObject
import java.io.File
import java.io.FileInputStream
import java.io.RandomAccessFile
import java.security.MessageDigest

class ResumeReceiver(private val context: Context, private val store: Store, private val client: OkHttpClient, private val activeSocket: (WebSocket?) -> Unit, private val progress: (String, Long, Long) -> Unit, private val shouldContinue: () -> Boolean, private val diagnostic: (String) -> Unit = {}) {
    private fun active() { if (!shouldContinue()) throw UserPausedException() }
    fun receive(task: JSONObject, endpoint: String, localRoute: Boolean = localEndpoint(endpoint)) {
        val invitation = Invitation.parse(task.getString("url"))
        val nonce = Crypto.random(32)
        val join = JSONObject().put("type", "join").put("protocol", "cd-transfer-v2").put("role", "receiver").put("receiverNonce", Crypto.encode(nonce)).put("receiverToken", Crypto.encode(invitation.token())).put("nonceProof", Crypto.encode(invitation.proof("receiver", nonce)))
        var direct: DirectReceiver? = null
        try { Wire(client, endpoint) { ws -> activeSocket(ws); diagnostic("socket-open"); ws.send(join.toString()); diagnostic("join-sent") }.use { wire ->
            var expiry = 0L
            var paired: JSONObject
            val admissionSeconds = if (localRoute) 8L else 20L
            val admissionDeadline = System.nanoTime() + java.util.concurrent.TimeUnit.SECONDS.toNanos(admissionSeconds)
            while (true) {
                val secondsLeft = java.util.concurrent.TimeUnit.NANOSECONDS.toSeconds(admissionDeadline - System.nanoTime())
                if (secondsLeft <= 0) throw java.io.IOException("Admission timed out")
                val event = wire.json(secondsLeft)
                if (event.getString("type") == "accepted") { expiry = event.getLong("expiresAt"); ReceiveGate.expiry(expiry); diagnostic("admitted") }
                if (event.optString("sessionNonce").isNotEmpty() && event.optString("receiverNonce").isNotEmpty()) { paired = event; break }
            }
            val senderNonce = Crypto.decode(paired.getString("sessionNonce"), 32)
            val receiverNonce = Crypto.decode(paired.getString("receiverNonce"), 32)
            require(MessageDigest.isEqual(receiverNonce, nonce)) { "Receiver nonce changed" }
            val proof = Crypto.decode(paired.optString("senderNonceProof").ifEmpty { paired.getString("nonceProof") }, 32)
            require(MessageDigest.isEqual(proof, invitation.proof("sender", senderNonce))) { "Sender authentication failed" }
            diagnostic("peer-authenticated")
            val opener = Records(invitation, senderNonce, receiverNonce, true)
            val sealer = Records(invitation, senderNonce, receiverNonce, false)
            val writer = RecordWriter(sealer) { wire.send(it) }
            fun nextRecord(): Pair<Int, ByteArray> {
                while (true) {
                    active()
                    when (val frame = wire.next()) {
                        is Frame.Binary -> { active(); return opener.open(frame.bytes) }
                        is Frame.Text -> { ReceiveGate.event(JSONObject(frame.text)) }
                        else -> error("Disconnected")
                    }
                }
            }
            val offered = nextRecord()
            require(offered.first == 1)
            diagnostic("file-offer")
            val offer = JSONObject(String(offered.second))
            ReceiveGate.expiry(expiry)
            val filename = offer.getString("name")
            require(filename.length in 1..255 && filename !in listOf(".", "..") && !filename.contains('/') && !filename.contains('\\') && filename.none { it.code < 32 }) { "Unsafe filename" }
            val size = offer.getString("size").toLong()
            val digest = offer.getString("wholeSha256")
            require(size in 0..9007199254740991L && offer.getLong("chunkSize") == 262144L && digest.matches(Regex("[0-9a-f]{64}")))
            require(expiry == offer.getLong("expiresAt") && expiry > System.currentTimeMillis() && expiry <= System.currentTimeMillis() + 86430000L) { "Invalid transfer expiry" }
            if (task.optString("pairId").isNotEmpty()) require(task.getString("wholeSha256") == digest && task.getString("size").toLong() == size && task.getString("filename") == filename) { "Offer differs from trusted message" }
            store.offered(task.getString("id"), filename, size, digest, expiry)
            val stage = File(context.filesDir, "resume-${invitation.id}.part")
            val cpFile = AtomicFile(File(context.filesDir, "resume-${invitation.id}.json"))
            val existingCheckpoint = cpFile.baseFile.exists()
            val cp = if (existingCheckpoint) JSONObject(String(cpFile.readFully())) else JSONObject().put("version", 2).put("role", "receiver").put("rootId", invitation.id).put("filename", filename).put("size", size).put("chunkSize", 262144).put("wholeSha256", digest).put("offset", 0).put("prefixSha256", Crypto.hex(Crypto.sha(byteArrayOf()))).put("stagingId", stage.name).put("destination", "Downloads/CD/$filename").put("expiresAt", expiry).put("priorSessionNonce", Crypto.encode(senderNonce))
            if (existingCheckpoint) require(cp.has("mac") && MessageDigest.isEqual(cp.getString("mac").toByteArray(), checkpointMac(cp, invitation).toByteArray())) { "Checkpoint authentication failed" }
            require(cp.getString("rootId") == invitation.id && cp.getString("role") == "receiver" && cp.getInt("version") == 2 && cp.getString("stagingId") == stage.name && cp.getString("destination") == "Downloads/CD/$filename")
            require(cp.getString("filename") == filename && cp.getLong("size") == size && cp.getLong("chunkSize") == 262144L && cp.getString("wholeSha256") == digest && cp.getLong("expiresAt") == expiry) { "File changed since checkpoint" }
            var writtenOffset = cp.getLong("offset")
            var committedOffset = writtenOffset
            val ackPolicy = DurableAckPolicy(offer.optLong("windowBytes", 0))
            require(writtenOffset in 0..size && (writtenOffset % 262144L == 0L || writtenOffset == size))
            val published = task.optString("publishedUri").takeIf { it.isNotEmpty() }?.let { uri -> context.contentResolver.query(Uri.parse(uri), arrayOf(MediaStore.MediaColumns.IS_PENDING), null, null, null)?.use { it.moveToFirst() && it.getInt(0) == 0 } } ?: false
            StorageBudget.check(context, size, writtenOffset, published)
            require((writtenOffset == 0L && !stage.exists()) || stage.length() >= writtenOffset) { "Retained file is truncated" }
            val whole = MessageDigest.getInstance("SHA-256")
            if (stage.exists()) FileInputStream(stage).use { input -> var left = writtenOffset; val b = ByteArray(262144); while (left > 0) { val n = input.read(b, 0, minOf(left, b.size.toLong()).toInt()); check(n > 0); whole.update(b, 0, n); left -= n } }
            fun prefix(): String = if (writtenOffset == 0L) Crypto.hex(Crypto.sha(byteArrayOf())) else try { Crypto.hex((whole.clone() as MessageDigest).digest()) } catch (_: CloneNotSupportedException) {
                val d = MessageDigest.getInstance("SHA-256"); FileInputStream(stage).use { input -> var left = writtenOffset; val b = ByteArray(262144); while (left > 0) { val n = input.read(b, 0, minOf(left, b.size.toLong()).toInt()); check(n > 0); d.update(b, 0, n); left -= n } }; Crypto.hex(d.digest())
            }
            require(prefix() == cp.getString("prefixSha256")) { "Retained prefix failed verification" }
            diagnostic("checkpoint-verified-offset=$writtenOffset")
            RandomAccessFile(stage, "rw").use { output ->
                output.setLength(writtenOffset); output.seek(writtenOffset)
                fun persist() {
                    output.fd.sync()
                    cp.put("offset", writtenOffset).put("prefixSha256", prefix()).put("priorSessionNonce", Crypto.encode(senderNonce))
                    cp.put("mac", checkpointMac(cp, invitation))
                    val out = cpFile.startWrite()
                    try { out.write(cp.toString().toByteArray()); cpFile.finishWrite(out); DurableFiles.directory(context.filesDir); committedOffset = writtenOffset } catch (e: Exception) { cpFile.failWrite(out); throw e }
                }
                persist()
                writer.send(4, JSONObject().put("offset", writtenOffset.toString()).put("prefixSha256", cp.getString("prefixSha256")).put("ackEveryBytes", ackPolicy.interval).toString().toByteArray())
                diagnostic("resume-accepted")
                if (!localRoute) offer.optJSONObject("direct")?.optString("sdp")?.takeIf { it.isNotEmpty() }?.let { sdp ->
                    direct = DirectReceiver(context, store.allowedMobile(), { signal -> writer.send(9, signal.toString().toByteArray()) }, wire::direct, wire::abort, diagnostic).also { it.start(sdp) }
                }
                store.state(task.getString("id"), "receiving") ?: throw UserPausedException()
                progress(filename, committedOffset, size)
                while (true) {
                    val (kind, data) = nextRecord()
                    if (kind == 2) {
                        require(data.isNotEmpty() && data.size <= 262144 && writtenOffset + data.size <= size && (data.size == 262144 || writtenOffset + data.size == size)) { "Invalid chunk bounds" }
                        output.write(data); whole.update(data); writtenOffset += data.size
                        if (ackPolicy.commit(writtenOffset, committedOffset, size)) {
                            persist()
                            writer.send(5, counts(committedOffset))
                        }
                        progress(filename, committedOffset, size)
                    } else {
                        store.state(task.getString("id"), "verifying") ?: throw UserPausedException()
                        val expectedEnd = counts(size) + digest.chunked(2).map { it.toInt(16).toByte() }.toByteArray()
                        require(kind == 3 && writtenOffset == size && prefix() == digest && MessageDigest.isEqual(data, expectedEnd)) { "Final digest or size failed verification" }
                        writer.stopSignals()
                        if (committedOffset != writtenOffset) persist()
                        output.fd.sync()
                        active()
                        task.put("wholeSha256", digest)
                        publish(task, stage, filename, size)
                        diagnostic("published")
                        writer.send(6, expectedEnd)
                        wire.send(JSONObject().put("type", "complete").put("protocol", "cd-transfer-v2").put("sessionNonce", paired.getString("sessionNonce")).put("receiverNonce", paired.getString("receiverNonce")))
                        runCatching { while (wire.json().getString("type") != "completed") { } }
                        cpFile.delete(); stage.delete()
                        return
                    }
                }
            }
        } } finally { direct?.close() }
    }
    private fun publish(task: JSONObject, stage: File, filename: String, size: Long) {
        val resolver = context.contentResolver
        val existing = task.optString("publishedUri")
        var uri = existing.takeIf { it.isNotEmpty() }?.let(Uri::parse)
        if (uri == null) {
            uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, ContentValues().apply {
                put(MediaStore.MediaColumns.DISPLAY_NAME, filename); put(MediaStore.MediaColumns.MIME_TYPE, "application/octet-stream"); put(MediaStore.MediaColumns.RELATIVE_PATH, "${Environment.DIRECTORY_DOWNLOADS}/CD"); put(MediaStore.MediaColumns.IS_PENDING, 1)
            }) ?: error("Could not create Downloads file")
            try { store.publication(task.getString("id"), uri.toString(), task.getString("wholeSha256")); task.put("publishedUri", uri.toString()) } catch (e: Exception) { resolver.delete(uri, null, null); throw e }
        }
        val alreadyPublished = resolver.query(uri, arrayOf(MediaStore.MediaColumns.IS_PENDING), null, null, null)?.use { cursor -> cursor.moveToFirst() && cursor.getInt(0) == 0 } ?: false
        if (!alreadyPublished) resolver.openFileDescriptor(uri, "rwt")!!.use { pfd -> java.io.FileOutputStream(pfd.fileDescriptor).use { out -> FileInputStream(stage).use { input ->
            val buffer = ByteArray(262144)
            while (true) { active(); val n = input.read(buffer); if (n < 0) break; out.write(buffer, 0, n) }
        }; out.fd.sync() } }
        else {
            val actual = MessageDigest.getInstance("SHA-256")
            var count = 0L
            resolver.openInputStream(uri)!!.use { input -> val b = ByteArray(262144); while (true) { active(); val n = input.read(b); if (n < 0) break; actual.update(b, 0, n); count += n } }
            require(count == size && Crypto.hex(actual.digest()) == task.getString("wholeSha256")) { "Published file changed before completion recovery" }
        }
        active()
        check(stage.length() == size)
        check(resolver.update(uri, ContentValues().apply { put(MediaStore.MediaColumns.IS_PENDING, 0) }, null, null) == 1)
        store.completed(task.getString("id"), uri.toString(), filename, size); task.put("state", "complete")
    }
}

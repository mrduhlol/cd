package `in`.yash0.cd

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.OpenableColumns
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream

/** Foreground sends use the ordinary numeric-code protocol; retries restart at zero. */
class SendEngineImpl(private val context: Context, private val publicBase: String = "https://cd.yash0.in") : SendEngine {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val store = SenderStore(context)
    private val client = OkHttpClient.Builder().pingInterval(20, TimeUnit.SECONDS).build()
    private class Running(val scope: CoroutineScope) {
        @Volatile var wire: Wire? = null
        var job: Job? = null
        fun active() = scope.coroutineContext.ensureActive()
        fun stop() { scope.cancel(); wire?.close() }
    }
    private val running = ConcurrentHashMap<String, Running>()
    init {
        // Parsing validates the origin before any credentials are sent.
        Invitation.parse("${publicBase.trimEnd('/')}/s/${Crypto.encode(ByteArray(16))}#v2.${Crypto.encode(ByteArray(32))}")
        store.all().forEach { state ->
            val phase = runCatching { TransferPhase.valueOf(state.optString("phase")) }.getOrDefault(TransferPhase.PAUSED)
            publish(state, if (phase in setOf(TransferPhase.COMPLETE, TransferPhase.CANCELLED, TransferPhase.FAILED)) phase else TransferPhase.PAUSED)
        }
    }
    override fun start(context: Context, uris: List<Uri>): String {
        require(uris.isNotEmpty()) { "Choose at least one file" }
        val id = Crypto.encode(Crypto.random(16))
        val state = JSONObject().put("id", id)
            .put("publicBase", publicBase.trimEnd('/')).put("uris", JSONArray(uris.map(Uri::toString)))
            .put("name", if (uris.size == 1) name(uris.first()) else "files.zip").put("size", if (uris.size == 1) size(uris.first()) else -1L).put("done", 0L)
            .put("phase", TransferPhase.PREPARING.name)
        uris.forEach { uri -> runCatching { this.context.contentResolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION) } }
        store.save(state)
        publish(state, TransferPhase.PREPARING)
        launch(id) { run ->
            prepare(state, run)
            transfer(state, run)
        }
        return id
    }
    override fun pause(context: Context, id: String) = stop(id, TransferPhase.PAUSED)
    override fun cancel(context: Context, id: String) = stop(id, TransferPhase.CANCELLED)
    private fun stop(id: String, phase: TransferPhase) {
        synchronized(this) {
            running[id]?.stop()
            val state = store.load(id)
            state.put("phase", phase.name)
            store.save(state)
            if (phase == TransferPhase.CANCELLED) { store.source(id).delete(); File(store.directory, "$id.pending").delete() }
            publish(state, phase)
        }
    }
    override fun resume(context: Context, id: String) {
        synchronized(this) {
            if (running[id]?.scope?.coroutineContext?.get(Job)?.isActive == true) return
            val state = store.load(id)
            require(state.optString("phase") !in listOf(TransferPhase.COMPLETE.name, TransferPhase.CANCELLED.name)) { "Transfer already finished" }
            val phase = if (state.optBoolean("prepared")) TransferPhase.CONNECTING else TransferPhase.PREPARING
            state.put("phase", phase.name)
            store.save(state)
            publish(state, phase)
            launch(id) { run ->
                if (!state.optBoolean("prepared")) prepare(state, run)
                transfer(state, run)
            }
        }
    }
    private fun launch(id: String, block: (Running) -> Unit) {
        synchronized(this) {
            if (running[id]?.scope?.coroutineContext?.get(Job)?.isActive == true) return
            val previous = running[id]
            val run = Running(CoroutineScope(scope.coroutineContext + SupervisorJob(scope.coroutineContext[Job])))
            running[id] = run
            run.job = run.scope.launch {
                try { previous?.job?.join(); run.active(); block(run) }
                catch (e: Exception) {
                    synchronized(this@SendEngineImpl) {
                        if (running[id] === run && run.scope.coroutineContext[Job]?.isActive == true) {
                            val state = store.load(id)
                            state.put("phase", TransferPhase.PAUSED.name)
                            store.save(state)
                            publish(state, TransferPhase.PAUSED, message = e.message ?: "Transfer interrupted. Resume to continue.")
                        }
                    }
                } finally { run.wire?.close(); running.remove(id, run); run.scope.cancel() }
            }
        }
    }
    private fun name(uri: Uri): String {
        var value: String? = null
        runCatching { context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { cursor ->
            if (cursor.moveToFirst()) value = cursor.getString(0)
        } }
        return (value ?: uri.lastPathSegment ?: "file").replace(Regex("[/\\\\\\p{Cntrl}]"), "_").take(60).takeUnless { it in listOf("", ".", "..") } ?: "file"
    }
    private fun size(uri: Uri): Long = runCatching {
        context.contentResolver.query(uri, arrayOf(OpenableColumns.SIZE), null, null, null)?.use { cursor ->
            if (cursor.moveToFirst() && !cursor.isNull(0)) cursor.getLong(0) else -1L
        } ?: -1L
    }.getOrDefault(-1L)
    private fun input(uri: Uri): InputStream = BufferedInputStream(context.contentResolver.openInputStream(uri) ?: throw IOException("Cannot open selected file"), 1024 * 1024)
    private fun prepare(state: JSONObject, run: Running) {
        val id = state.getString("id")
        val pending = File(store.directory, "$id.pending")
        val uris = state.getJSONArray("uris").let { array -> (0 until array.length()).map { Uri.parse(array.getString(it)) } }
        val buffer = ByteArray(1024 * 1024)
        fun copy(uri: Uri, output: java.io.OutputStream) {
            input(uri).use { source ->
                while (true) {
                    run.active()
                    val n = source.read(buffer)
                    if (n < 0) break
                    require(store.directory.usableSpace > n + 8L * 1024 * 1024) { "Not enough phone storage to retain this send" }
                    output.write(buffer, 0, n)
                }
            }
        }
        try {
            BufferedOutputStream(pending.outputStream(), 1024 * 1024).use { output ->
                if (uris.size == 1) copy(uris.single(), output)
                else ZipOutputStream(output).use { zip ->
                    // Level zero keeps bundles fast, and a saved archive makes resume byte-stable.
                    zip.setLevel(0)
                    val used = mutableSetOf<String>()
                    uris.forEachIndexed { index, uri ->
                        var entryName = name(uri)
                        if (!used.add(entryName)) { entryName = "${index + 1}-$entryName"; require(used.add(entryName)) }
                        zip.putNextEntry(ZipEntry(entryName))
                        copy(uri, zip)
                        zip.closeEntry()
                    }
                }
            }
            run.active()
            require(pending.length() <= 9007199254740991L) { "File is too large" }
            java.io.RandomAccessFile(pending, "rw").use { it.fd.sync() }
            synchronized(this) {
                run.active()
                check(pending.renameTo(store.source(id))) { "Could not retain send source" }
                state.put("size", store.source(id).length()).put("prepared", true).put("phase", TransferPhase.WAITING.name)
                store.save(state)
            }
        } finally { pending.delete() }
    }
    private fun publish(state: JSONObject, phase: TransferPhase, rate: Long = 0, route: Route = Route.NONE, message: String? = null) {
        TransferBus.publish(TransferView(state.getString("id"), Direction.SEND, state.getString("name"), state.getLong("size"), state.optLong("done"), rate, phase, route, code = state.optString("code").takeIf { it.isNotEmpty() && phase in listOf(TransferPhase.WAITING, TransferPhase.TRANSFERRING, TransferPhase.VERIFYING) }, message = message))
    }
    private fun transfer(state: JSONObject, run: Running) {
        val invitation = SendProtocol.invitation(state.getString("publicBase"))
        val join = JSONObject().put("type", "join").put("protocol", "cd-transfer-v1").put("role", "sender")
            .put("receiverTokenHash", Crypto.encode(Crypto.sha(invitation.token()))).put("shareKey", Crypto.encode(invitation.key))
        state.put("done", 0L).remove("code")
        publish(state, TransferPhase.CONNECTING)
        Wire(client, invitation.relay) { it.send(join.toString()) }.use { wire ->
            run.wire = wire
            val sealer = Records(invitation, byteArrayOf(), byteArrayOf(), true)
            val opener = Records(invitation, byteArrayOf(), byteArrayOf(), false)
            fun send(kind: Int, bytes: ByteArray) { run.active(); wire.send(sealer.seal(kind, bytes)) }
            fun next(): Pair<Int, ByteArray> {
                while (true) {
                    run.active()
                    when (val frame = wire.next()) {
                        is Frame.Binary -> return opener.open(frame.bytes)
                        is Frame.Failed -> throw frame.error
                        is Frame.Text -> {
                            val event = JSONObject(frame.text)
                            require(event.getString("protocol") == "cd-transfer-v1")
                            if (event.getString("type") == "peer-left") throw IOException("Receiver disconnected")
                        }
                    }
                }
            }
            while (true) {
                run.active()
                val frame = wire.next(15 * 60)
                require(frame is Frame.Text) { "Expected relay admission" }
                val event = JSONObject(frame.text)
                require(event.getString("protocol") == "cd-transfer-v1")
                when (event.getString("type")) {
                    "accepted" -> {
                        val code = event.getString("code")
                        require(code.matches(Regex("[0-9]{4,5}"))) { "Numeric share code unavailable" }
                        state.put("code", code)
                        publish(state, TransferPhase.WAITING)
                    }
                    "peer-joined" -> break
                    "error" -> throw IOException("Relay rejected send")
                }
            }
            val size = state.getLong("size")
            send(1, JSONObject().put("name", state.getString("name")).put("size", size.toString()).put("mediaType", "application/octet-stream").put("chunkSize", SendProtocol.CHUNK).toString().toByteArray())
            require(next().first == 4) { "Invalid receiver acceptance" }
            var sent = 0L
            var ack = 0L
            store.source(state.getString("id")).inputStream().buffered().use { source ->
                val buffer = ByteArray(SendProtocol.CHUNK)
                while (ack < size) {
                    while (SendProtocol.canSend(sent, ack, size)) {
                        val n = minOf(buffer.size.toLong(), size - sent).toInt()
                        var filled = 0
                        while (filled < n) { run.active(); val read = source.read(buffer, filled, n - filled); require(read > 0) { "Send source truncated" }; filled += read }
                        send(2, buffer.copyOf(n)); sent += n
                    }
                    val record = next()
                    require(record.first == 5) { "Expected acknowledgement" }
                    ack = SendProtocol.ack(record.second, ack, sent, size)
                    state.put("done", ack)
                    publish(state, TransferPhase.TRANSFERRING, route = Route.RELAY)
                }
            }
            publish(state, TransferPhase.VERIFYING, route = Route.RELAY)
            val end = counts(size)
            send(3, end)
            val complete = next()
            require(complete.first == 6 && complete.second.contentEquals(end)) { "Receiver did not confirm complete file" }
            state.put("phase", TransferPhase.COMPLETE.name)
            store.save(state)
            store.source(state.getString("id")).delete()
            publish(state, TransferPhase.COMPLETE, route = Route.RELAY)
        }
    }
}

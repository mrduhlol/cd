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
import okio.ByteString.Companion.toByteString
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.security.DigestOutputStream
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.security.MessageDigest
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream

/** Foreground process scope only. No service, alarm, worker or automatic restart. */
class SendEngineImpl(private val context: Context, private val publicBase: String = "https://cd.yash0.in", private val directEnabled: Boolean = true) : SendEngine {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val store = SenderStore(context)
    private val client = OkHttpClient.Builder().pingInterval(20, TimeUnit.SECONDS).build()
    private class Running(val scope: CoroutineScope) {
        @Volatile var wire: Wire? = null
        var job: Job? = null
        fun active() = scope.coroutineContext.ensureActive()
        fun live() = scope.coroutineContext[Job]?.isActive == true
        fun stop() { scope.cancel(); wire?.close() }
    }
    private val running = ConcurrentHashMap<String, Running>()
    /** Last published phase/expiry/progress per send; backs owns() without disk reads on the UI thread. */
    private class Known(val phase: TransferPhase, val expiresAt: Long, val done: Long)
    private val known = ConcurrentHashMap<String, Known>()
    private val expiryWatch = ConcurrentHashMap<String, Job>()
    init {
        // Parsing validates the origin before any credentials are sent.
        Invitation.parse("${publicBase.trimEnd('/')}/s/${Crypto.encode(ByteArray(16))}#v2.${Crypto.encode(ByteArray(32))}")
        store.all().forEach { state ->
            val phase = SendStatus.restored(state.optString("phase"))
            val expiresAt = state.optLong("expiresAt")
            if (phase == TransferPhase.PAUSED && expiresAt > 0 && System.currentTimeMillis() >= expiresAt) runCatching { synchronized(this) { halt(state.getString("id"), SendFailureKind.EXPIRED) } }
            else publish(state, phase, message = state.optString("message").ifEmpty { null })
        }
    }
    override fun owns(id: String): Boolean = known[id]?.let { SendStatus.owns(it.phase, it.expiresAt, System.currentTimeMillis()) } ?: false
    override fun start(context: Context, uris: List<Uri>, privateLink: Boolean): String {
        require(uris.isNotEmpty()) { "Choose at least one file" }
        val id = Crypto.encode(Crypto.random(16))
        val state = JSONObject().put("id", id).put("key", Crypto.encode(Crypto.random(32))).put("senderToken", Crypto.encode(Crypto.random(32)))
            .put("publicBase", publicBase.trimEnd('/')).put("uris", JSONArray(uris.map(Uri::toString)))
            .put("name", if (uris.size == 1) name(uris.first()) else "files.zip").put("size", if (uris.size == 1) size(uris.first()) else -1L).put("done", 0L)
            .put("phase", TransferPhase.PREPARING.name).put("expiresAt", 0L).put("private", privateLink)
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
            val state = store.load(id)
            // A pause/cancel that lost the race with completion or a terminal failure must not reopen it.
            if (!SendStatus.canStop(TransferPhase.entries.firstOrNull { it.name == state.optString("phase") }, phase)) return
            running[id]?.stop()
            state.put("phase", phase.name).put("done", maxOf(state.optLong("done"), known[id]?.done ?: 0L)).remove("message")
            store.save(state)
            if (phase == TransferPhase.CANCELLED) { store.source(id).delete(); File(store.directory, "$id.pending").delete() }
            publish(state, phase)
        }
    }
    override fun resume(context: Context, id: String) {
        synchronized(this) {
            if (running[id]?.live() == true) return
            val state = store.load(id)
            require(state.optString("phase") !in listOf(TransferPhase.COMPLETE.name, TransferPhase.CANCELLED.name)) { "Transfer already finished" }
            require(state.optString("phase") != TransferPhase.FAILED.name) { state.optString("message").ifEmpty { "This send can't be resumed. Start a new send." } }
            val expiresAt = state.optLong("expiresAt")
            if (expiresAt > 0 && System.currentTimeMillis() >= expiresAt) { halt(id, SendFailureKind.EXPIRED); return }
            val phase = if (state.has("digest")) TransferPhase.CONNECTING else TransferPhase.PREPARING
            state.put("phase", phase.name).remove("message")
            store.save(state)
            publish(state, phase)
            launch(id) { run ->
                if (!state.has("digest")) prepare(state, run)
                transfer(state, run)
            }
        }
    }
    private fun launch(id: String, block: (Running) -> Unit) {
        synchronized(this) {
            if (running[id]?.live() == true) return
            val previous = running[id]
            val run = Running(CoroutineScope(scope.coroutineContext + SupervisorJob(scope.coroutineContext[Job])))
            running[id] = run
            run.job = run.scope.launch {
                try { previous?.job?.join(); run.active(); block(run) }
                catch (e: Exception) {
                    synchronized(this@SendEngineImpl) {
                        if (running[id] === run && run.live()) {
                            val failure = SendFailures.classify(e, runCatching { store.load(id).optLong("expiresAt") }.getOrDefault(0L))
                            android.util.Log.w("CD-Send", "stopped id=$id kind=$failure exception=${e.javaClass.simpleName} cause=${e.cause?.javaClass?.simpleName ?: "none"} status=${(e as? WireFailure)?.status ?: 0}")
                            halt(id, failure)
                        }
                    }
                } finally { run.wire?.close(); running.remove(id, run); run.scope.cancel() }
            }
        }
    }
    /** Caller holds the engine lock. Terminal failures end the send and drop the retained copy; others pause it. */
    private fun halt(id: String, failure: SendFailureKind) {
        val state = store.load(id)
        val phase = if (failure.terminal) TransferPhase.FAILED else TransferPhase.PAUSED
        state.put("phase", phase.name).put("done", maxOf(state.optLong("done"), known[id]?.done ?: 0L))
        state.put("message", failure.message)
        store.save(state)
        if (failure.terminal) { store.source(id).delete(); File(store.directory, "$id.pending").delete() }
        publish(state, phase, message = failure.message)
    }
    /** Worker-side publish: dropped once this run was paused, cancelled or replaced, so it cannot overwrite that state. */
    private fun publish(run: Running, state: JSONObject, phase: TransferPhase, rate: Long = 0, route: Route = Route.NONE, message: String? = null) {
        synchronized(this) { if (running[state.getString("id")] === run && run.live()) publish(state, phase, rate, route, message) }
    }
    /** At the fixed expiry the link disappears and the send fails, even while paused with nothing running. */
    private fun watchExpiry(id: String, expiresAt: Long) {
        expiryWatch.computeIfAbsent(id) {
            scope.launch {
                kotlinx.coroutines.delay((expiresAt - System.currentTimeMillis()).coerceAtLeast(0))
                synchronized(this@SendEngineImpl) {
                    expiryWatch.remove(id)
                    val current = runCatching { store.load(id) }.getOrNull() ?: return@synchronized
                    if (current.optString("phase") in listOf(TransferPhase.COMPLETE.name, TransferPhase.CANCELLED.name, TransferPhase.FAILED.name)) return@synchronized
                    running[id]?.stop()
                    halt(id, SendFailureKind.EXPIRED)
                }
            }
        }
    }
    private fun name(uri: Uri): String {
        var value: String? = null
        runCatching { context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { cursor ->
            if (cursor.moveToFirst()) value = cursor.getString(0)
        } }
        return (value ?: uri.lastPathSegment ?: "file").replace(Regex("[/\\\\\\p{Cntrl}]"), "_").take(200).takeUnless { it in listOf("", ".", "..") } ?: "file"
    }
    private fun size(uri: Uri): Long = runCatching {
        context.contentResolver.query(uri, arrayOf(OpenableColumns.SIZE), null, null, null)?.use { cursor ->
            if (cursor.moveToFirst() && !cursor.isNull(0)) cursor.getLong(0) else -1L
        } ?: -1L
    }.getOrDefault(-1L)
    private fun input(uri: Uri): InputStream = try {
        BufferedInputStream(context.contentResolver.openInputStream(uri) ?: throw SendProblem(SendFailureKind.SOURCE_UNAVAILABLE), 1024 * 1024)
    } catch (e: SecurityException) { throw SendProblem(SendFailureKind.SOURCE_UNAVAILABLE, e) }
      catch (e: java.io.FileNotFoundException) { throw SendProblem(SendFailureKind.SOURCE_UNAVAILABLE, e) }
    private fun prepare(state: JSONObject, run: Running) {
        val id = state.getString("id")
        val pending = File(store.directory, "$id.pending")
        val digest = MessageDigest.getInstance("SHA-256")
        val uris = state.getJSONArray("uris").let { array -> (0 until array.length()).map { Uri.parse(array.getString(it)) } }
        val buffer = ByteArray(1024 * 1024)
        fun copy(uri: Uri, output: java.io.OutputStream) {
            input(uri).use { source ->
                while (true) {
                    run.active()
                    val n = source.read(buffer)
                    if (n < 0) break
                    if (store.directory.usableSpace <= n + 8L * 1024 * 1024) throw SendProblem(SendFailureKind.STORAGE)
                    output.write(buffer, 0, n)
                }
            }
        }
        try {
            BufferedOutputStream(DigestOutputStream(pending.outputStream(), digest), 1024 * 1024).use { output ->
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
            if (pending.length() > 9007199254740991L) throw SendProblem(SendFailureKind.TOO_LARGE)
            java.io.RandomAccessFile(pending, "rw").use { it.fd.sync() }
            synchronized(this) {
                run.active()
                check(pending.renameTo(store.source(id))) { "Could not retain send source" }
                state.put("size", store.source(id).length()).put("digest", Crypto.hex(digest.digest())).put("phase", TransferPhase.CONNECTING.name)
                store.save(state)
            }
        } finally { pending.delete() }
    }
    @Synchronized private fun publish(state: JSONObject, phase: TransferPhase, rate: Long = 0, route: Route = Route.NONE, message: String? = null) {
        val id = state.getString("id")
        val expiry = state.optLong("expiresAt")
        val now = System.currentTimeMillis()
        known[id] = Known(phase, expiry, state.optLong("done"))
        val accepted = SendStatus.accepted(state.optBoolean("accepted"), expiry)
        val link = if (state.has("digest") && SendStatus.linkVisible(accepted, phase, expiry, now)) "${state.getString("publicBase")}/s/$id#v2.${state.getString("key")}" else null
        val code = state.optString("code").takeIf { it.isNotEmpty() && state.optLong("codeExpiresAt") > now && phase in listOf(TransferPhase.WAITING, TransferPhase.PAUSED, TransferPhase.CONNECTING) && !state.optBoolean("codeSpent") }
        val shareLink = code?.let { "${state.getString("publicBase")}/#$it" } ?: link.takeIf { state.optBoolean("private", true) }
        TransferBus.publish(TransferView(id, Direction.SEND, state.getString("name"), state.getLong("size"), state.optLong("done"), rate, phase, route, link = shareLink, code = code, privateLink = link, isPrivate = state.optBoolean("private", true), message = message, expiresAt = expiry, codeExpiresAt = state.optLong("codeExpiresAt"), codeSpent = state.optBoolean("codeSpent")))
        if (phase in listOf(TransferPhase.COMPLETE, TransferPhase.CANCELLED, TransferPhase.FAILED)) expiryWatch.remove(id)?.cancel()
        else if (accepted && expiry > now) watchExpiry(id, expiry)
    }
    private fun transfer(state: JSONObject, run: Running) {
        run.active()
        val id = state.getString("id")
        val invitation = Invitation.parse("${state.getString("publicBase")}/s/$id#v2.${state.getString("key")}")
        val retained = store.source(id)
        if (!retained.isFile || !retained.canRead() || retained.length() != state.getLong("size")) throw SendProblem(SendFailureKind.SOURCE_CHANGED)
        val senderToken = Crypto.decode(state.getString("senderToken"), 32)
        val nonce = Crypto.random(32)
        val join = JSONObject().put("type", "join").put("protocol", "cd-transfer-v2").put("role", "sender")
            .put("senderToken", Crypto.encode(senderToken)).put("senderTokenHash", Crypto.encode(Crypto.sha(senderToken)))
            .put("receiverTokenHash", Crypto.encode(Crypto.sha(invitation.token()))).put("sessionNonce", Crypto.encode(nonce)).put("nonceProof", Crypto.encode(invitation.proof("sender", nonce)))
        if (state.getLong("expiresAt") != 0L) {
            require(state.getLong("expiresAt") > System.currentTimeMillis()) { "This link expired. Start a new send." }
            join.put("expiresAt", state.getLong("expiresAt"))
        }
        publish(run, state, TransferPhase.CONNECTING)
        Wire(client, invitation.relay) { ws -> ws.send(join.toString()) }.use { wire ->
            run.wire = wire
            run.active()
            var expiry = 0L
            lateinit var paired: JSONObject
            while (true) {
                run.active()
                val remaining = if (!state.optBoolean("private", true) && !state.optBoolean("codeSpent") && state.optLong("codeExpiresAt") > 0)
                    ((state.optLong("codeExpiresAt") - System.currentTimeMillis() + 999) / 1000).coerceIn(1L, 900L) else 15L * 60
                val event = try { wire.json(if (expiry == 0L) 30 else remaining) } catch (e: WireTimeout) { throw SendProblem(if (expiry == 0L) SendFailureKind.TIMEOUT else SendFailureKind.NO_RECEIVER, e) }
                if (event.getString("type") == "accepted") {
                    expiry = event.getLong("expiresAt")
                    require(expiry > System.currentTimeMillis() && expiry <= System.currentTimeMillis() + 86430000L)
                    require(state.getLong("expiresAt") == 0L || state.getLong("expiresAt") == expiry) { "Transfer expiry changed" }
                    require(Crypto.decode(event.getString("sessionNonce"), 32).contentEquals(nonce))
                    require(MessageDigest.isEqual(Crypto.decode(event.getString("senderNonceProof"), 32), invitation.proof("sender", nonce)))
                    synchronized(this) { run.active(); state.put("expiresAt", expiry).put("accepted", true).put("phase", TransferPhase.WAITING.name); store.save(state) }
                    // The relay may have admitted a receiver just before this phone lost its socket.
                    // Carry that fact across reconnects even when peer-joined was never read locally.
                    if (event.optBoolean("codeSpent")) {
                        synchronized(this) { run.active(); state.put("codeSpent", true); state.remove("code"); store.save(state) }
                    }
                    if (!state.optBoolean("private", true) && !state.optBoolean("codeSpent")) {
                        val (code, codeExpiry) = ShareCodes.claim(client, state.getString("publicBase"), id, state.getString("key"), state.getString("senderToken"))
                        synchronized(this) { run.active(); state.put("code", code).put("codeExpiresAt", codeExpiry); store.save(state) }
                    }
                    publish(run, state, TransferPhase.WAITING, message = if (!state.optBoolean("private", true) && state.optBoolean("codeSpent")) "Waiting for the same receiver to resume. The code has already been used." else null)
                }
                if (event.optString("receiverNonce").isNotEmpty()) {
                    synchronized(this) { run.active(); state.put("codeSpent", true); state.remove("code"); store.save(state) }
                    paired = event; break
                }
            }
            require(paired.getLong("expiresAt") == expiry && Crypto.decode(paired.getString("sessionNonce"), 32).contentEquals(nonce)) { "Relay changed sender session" }
            val receiver = Crypto.decode(paired.getString("receiverNonce"), 32)
            require(MessageDigest.isEqual(Crypto.decode(paired.getString("receiverNonceProof"), 32), invitation.proof("receiver", receiver))) { "Receiver authentication failed" }
            val sealer = SendRecords(invitation, nonce, receiver)
            val opener = Records(invitation, nonce, receiver, false)
            fun relay(record: ByteArray) {
                run.active()
                // The ACK window is 4 MiB, below OkHttp's hard 16 MiB limit. Also bound non-data records.
                while (wire.socket.queueSize() + record.size > 8L * 1024 * 1024) { run.active(); Thread.sleep(2) }
                if (!wire.socket.send(record.toByteString())) throw IOException("Send connection closed")
            }
            val size = state.getLong("size")
            val digest = state.getString("digest")
            val direct = if (directEnabled && size >= 1024 * 1024) SenderDirect(context) { wire.abort(it) } else null
            try {
                val offer = JSONObject().put("name", state.getString("name")).put("size", size.toString()).put("chunkSize", SendProtocol.CHUNK)
                    .put("wholeSha256", digest).put("expiresAt", expiry).put("windowBytes", SendProtocol.WINDOW)
                direct?.offer()?.let { offer.put("direct", JSONObject().put("sdp", it)) }
                relay(sealer.seal(1, offer.toString().toByteArray()))
                fun next(): Pair<Int, ByteArray> {
                    while (true) {
                        run.active()
                        when (val frame = wire.next()) {
                            is Frame.Binary -> {
                                val record = opener.open(frame.bytes)
                                if (record.first == 9) { direct?.signal(JSONObject(String(record.second))); continue }
                                return record
                            }
                            is Frame.Text -> ReceiveGate.event(JSONObject(frame.text))
                            is Frame.Failed -> throw frame.error
                        }
                    }
                }
                val accepted = next()
                require(accepted.first == 4) { "Invalid receiver acceptance" }
                val accept = JSONObject(String(accepted.second))
                val offset = SendProtocol.offset(accept.getString("offset"), size)
                val ackEvery = accept.optLong("ackEveryBytes", SendProtocol.CHUNK.toLong())
                require(ackEvery in SendProtocol.CHUNK.toLong()..SendProtocol.WINDOW && ackEvery % SendProtocol.CHUNK == 0L) { "Invalid ACK interval" }
                store.source(id).inputStream().buffered(1024 * 1024).use { source ->
                    val whole = MessageDigest.getInstance("SHA-256")
                    val buffer = ByteArray(SendProtocol.CHUNK)
                    var prefix = offset
                    while (prefix > 0) {
                        run.active()
                        val n = source.read(buffer, 0, minOf(buffer.size.toLong(), prefix).toInt())
                        if (n <= 0) throw SendProblem(SendFailureKind.SOURCE_CHANGED)
                        whole.update(buffer, 0, n); prefix -= n
                    }
                    require(Crypto.hex((whole.clone() as MessageDigest).digest()) == accept.getString("prefixSha256")) { "Receiver checkpoint does not match this source" }
                    var sent = offset
                    var ack = offset
                    var usingDirect = false
                    var draining = false
                    val started = System.nanoTime()
                    var lastPublish = 0L
                    state.put("done", offset)
                    publish(run, state, TransferPhase.TRANSFERRING, route = Route.RELAY, message = if (offset > 0) "Resumed at $offset bytes" else null)
                    android.util.Log.i("CD-Send", "start id=$id offset=$offset size=$size")
                    while (ack < size) {
                        run.active()
                        if (!usingDirect) {
                            if (direct?.ready() != true) draining = false
                            else if ((sent - offset) % ackEvery == 0L || sent == size) draining = true
                            if (draining && sent == ack) { direct!!.markUsed(); usingDirect = true; draining = false }
                        }
                        while (sent < size && sent - ack < SendProtocol.WINDOW && !draining) {
                            run.active()
                            val n = minOf(buffer.size.toLong(), size - sent).toInt()
                            var filled = 0
                            while (filled < n) { val read = source.read(buffer, filled, n - filled); if (read <= 0) throw SendProblem(SendFailureKind.SOURCE_CHANGED); filled += read }
                            whole.update(buffer, 0, n)
                            val record = sealer.seal(2, buffer, n)
                            if (usingDirect) direct!!.send(record) { run.active() } else relay(record)
                            sent += n
                            if (!usingDirect && direct?.ready() == true && ((sent - offset) % ackEvery == 0L || sent == size)) draining = true
                        }
                        val record = next()
                        require(record.first == 5) { "Expected cumulative acknowledgement" }
                        ack = SendProtocol.ack(record.second, ack, sent, size)
                        state.put("done", ack)
                        val now = System.nanoTime()
                        if (now - lastPublish > 150000000L || ack == size) {
                            val rate = ((ack - offset) * 1e9 / (now - started).coerceAtLeast(1)).toLong()
                            publish(run, state, TransferPhase.TRANSFERRING, rate, if (usingDirect) Route.DIRECT else Route.RELAY)
                            lastPublish = now
                        }
                    }
                    if (source.read() != -1 || Crypto.hex(whole.digest()) != digest) throw SendProblem(SendFailureKind.SOURCE_CHANGED)
                    publish(run, state, TransferPhase.VERIFYING, route = if (usingDirect) Route.DIRECT else Route.RELAY)
                    val end = SendProtocol.end(size, digest)
                    relay(sealer.seal(3, end))
                    val complete = next()
                    require(complete.first == 6 && complete.second.contentEquals(end)) { "Receiver did not verify complete file" }
                    while (true) {
                        val event = wire.json(10)
                        if (event.getString("type") == "completed") break
                        require(event.getString("type") == "complete" && event.getString("sessionNonce") == Crypto.encode(nonce) && event.getString("receiverNonce") == Crypto.encode(receiver))
                    }
                    synchronized(this) {
                        run.active()
                        state.put("phase", TransferPhase.COMPLETE.name)
                        store.save(state)
                        store.source(id).delete()
                        val rate = ((size - offset) * 1e9 / (System.nanoTime() - started).coerceAtLeast(1)).toLong()
                        publish(run, state, TransferPhase.COMPLETE, rate, if (usingDirect) Route.DIRECT else Route.RELAY)
                        android.util.Log.i("CD-Send", "complete id=$id resumed=$offset bytesPerSecond=$rate route=${if (usingDirect) "direct" else "relay"}")
                    }
                }
            } finally { direct?.close() }
        }
    }
}

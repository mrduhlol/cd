package `in`.yash0.cd

import android.app.*
import android.content.*
import android.content.pm.ServiceInfo
import android.net.*
import android.net.nsd.*
import android.os.*
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import okhttp3.*
import okio.ByteString
import org.json.JSONObject
import java.util.concurrent.*
import java.util.concurrent.atomic.AtomicBoolean

class ReceiverService: Service() {
    private var foregroundReady = false
    private lateinit var store: Store
    private lateinit var network: ReceiverNetwork
    @Volatile private var activeEndpoint: String? = null
    private val pool = Executors.newCachedThreadPool()
    private val scheduler = ReceiveScheduler()
    private val running = AtomicBoolean(true)
    private val stopping = AtomicBoolean(false)
    private val admitted = ConcurrentHashMap<String, WebSocket>()
    private val lastPing = ConcurrentHashMap<String, Long>()
    @Volatile private var activeTaskId: String? = null
    private val sockets = ConcurrentHashMap<String, WebSocket>()
    @Volatile private var transferSocket: WebSocket? = null
    private var networkCallback: ConnectivityManager.NetworkCallback? = null
    private var discovery: NsdManager.DiscoveryListener? = null
    private lateinit var nsd: NsdManager
    private val client = OkHttpClient.Builder().pingInterval(25, TimeUnit.SECONDS).connectTimeout(4, TimeUnit.SECONDS).readTimeout(0, TimeUnit.SECONDS).build()
    @Volatile private var receiving = false
    @Volatile private var background = false
    @Volatile private var lastStartId = 0
    @Volatile private var transferActive = false
    private var lastProgressAt = 0L
    private var wake: PowerManager.WakeLock? = null
    private val handler = Handler(Looper.getMainLooper())
    private val renewWake = object: Runnable { override fun run() { if (running.get() && transferActive) { if (wake?.isHeld == true) wake?.release(); wake?.acquire(10 * 60 * 1000L); handler.postDelayed(this, 9 * 60 * 1000L) } } }
    override fun onBind(intent: Intent?) = null
    companion object { @Volatile var alive = false; private set }
    override fun onCreate() {
        super.onCreate(); store = StoreRegistry.get(this); network = ReceiverNetwork(this, store); ReceiveViews.load(this)
        getSystemService(NotificationManager::class.java).createNotificationChannel(NotificationChannel("receiving", "File receiving", NotificationManager.IMPORTANCE_LOW))
        try {
            ServiceCompat.startForeground(this, 1, notification("Ready to receive", null, null), ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE)
            foregroundReady = true; alive = true
        } catch (_: RuntimeException) { PushBridge.fallback(this); stopSelf(); return }
        PushBridge.start(this)
        wake = getSystemService(PowerManager::class.java).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "CD:receiver").apply { setReferenceCounted(false) }
        nsd = getSystemService(NsdManager::class.java)
        discover()
        val callback = object: ConnectivityManager.NetworkCallback() {
            override fun onCapabilitiesChanged(network: Network, capabilities: NetworkCapabilities) = enforceNetworkPolicy()
            override fun onLost(network: Network) = enforceNetworkPolicy()
        }
        networkCallback = callback
        getSystemService(ConnectivityManager::class.java).registerDefaultNetworkCallback(callback)
        pool.execute {
            while (running.get()) {
                PushBridge.maintenance(this)
                if (!receiving) store.tasks().filter { it.getString("state") == "cancelled" && !it.optBoolean("discarded") }.forEach { discard(it) }
                if (store.enabled()) {
                    store.pairs().forEach { pair ->
                        connect(pair, pair.json.getString("relayUrl"), localTransport = false)
                        pair.json.optJSONArray("localUrls")?.let { urls -> repeat(urls.length()) { connect(pair, urls.getString(it), localTransport = true) } }
                    }
                    heartbeat()
                    if (!receiving) {
                        val pending = store.tasks().filter { it.getString("state") in listOf("queued", "connecting", "receiving", "verifying", "retrying") }
                        val next = scheduler.next(pending.map { it.getString("id") }, SystemClock.elapsedRealtime())
                        pending.firstOrNull { it.getString("id") == next }?.let { task ->
                            receiving = true
                            pool.execute { if (TransferFiles.start(task)) { try { activeTaskId = task.getString("id"); runTask(task) } finally { activeTaskId = null; TransferFiles.finish(task); receiving = false } } else receiving = false }
                        }
                    }
                }
                if (background) stopIfIdle()
                try { Thread.sleep(2500) } catch (_: InterruptedException) { break }
            }
        }
    }
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (!foregroundReady) return START_NOT_STICKY
        lastStartId = startId
        when (intent?.action) {
            "push-wake" -> {
                if (stopping.get() || !PushBridge.canWake(this, intent.getStringExtra("pairId").orEmpty())) { stopSelf(); return START_NOT_STICKY }
                // Replace a potentially half-open control transport without cancelling file data.
                val pairId = intent.getStringExtra("pairId").orEmpty()
                sockets.keys.filter { it.startsWith("$pairId|") }.forEach { key ->
                    sockets.remove(key)?.cancel(); admitted.remove(key); lastPing.remove(key)
                }
                PushBridge.disconnected(pairId)
            }
            "pause" -> stopReceiving(startId)
            // CD left the foreground: drop idle control links, but never interrupt or pause a transfer.
            // With a transfer queued or running, stop once it finishes instead (see the loop).
            "idle" -> { background = true; if (stopIfIdle()) return START_NOT_STICKY }
            "pause-task", "cancel-task" -> intent.getStringExtra("taskId")?.let { pauseTask(it, intent.action == "cancel-task") }
            "refresh" -> { store.pairs().forEach { PushBridge.disconnected(it.id) }; NativeNetworkDetector.refreshPolicy(); sockets.values.forEach { it.cancel() }; sockets.clear(); admitted.clear(); lastPing.clear(); transferSocket?.cancel() }
            else -> if (intent != null) { background = false; store.enabled(!stopping.get()); store.tasks().filter { it.getString("state") == "queued" }.forEach { scheduler.wake(it.getString("id")) } }
        }
        if (intent == null && !store.enabled()) stopSelf()
        return if (stopping.get()) START_NOT_STICKY else START_STICKY
    }
    private fun stopIfIdle(): Boolean {
        if (receiving || transferActive || ControlHub.busy || store.tasks().any { it.getString("state") in listOf("queued", "connecting", "receiving", "verifying", "retrying") }) return false
        // stopSelfResult ignores the stop if a newer start (connect) arrived meanwhile.
        handler.post { if (background) stopSelfResult(lastStartId) }
        return true
    }
    private fun pauseTask(id: String, cancel: Boolean) {
        val task = store.task(id) ?: return
        if (task.getString("state") in listOf("complete", "cancelled")) return
        store.state(id, "paused")
        control(task.optString("pairId"), "paused", id)
        if (cancel) store.state(id, "cancelled")
        if (activeTaskId == id) transferSocket?.cancel()
        if (cancel) TransferFiles.discard(this, store, id)
    }
    private fun stopReceiving(startId: Int) {
        if (!stopping.compareAndSet(false, true)) return
        val paused = runCatching { store.pauseReceiving() }.getOrElse { store.tasks().filter { it.getString("state") == "paused" } }
        transferSocket?.cancel()
        paused.forEach { control(it.optString("pairId"), "paused", it.getString("id")) }
        running.set(false)
        releaseTransferWake()
        notify("Receiving stopped")
        handler.postDelayed({ stopSelf() }, 200)
    }
    private fun heartbeat() {
        val now = SystemClock.elapsedRealtime()
        admitted.forEach { (key, socket) ->
            if (now - (lastPing[key] ?: now) >= 20000L) {
                lastPing[key] = now
                if (!socket.send(JSONObject().put("type", "ping").put("protocol", "cd-device-v1").toString())) socket.cancel()
            }
        }
    }
    private fun enforceNetworkPolicy() {
        sockets.forEach { (key, socket) -> if (!network.allowed(key.substringAfter('|').substringAfter('|'))) socket.cancel() }
        if (activeEndpoint?.let { !network.allowed(it) } == true) transferSocket?.cancel()
    }
    private fun notification(text: String, offset: Long?, size: Long?): Notification {
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val stop = PendingIntent.getService(this, 1, Intent(this, ReceiverService::class.java).setAction("pause"), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val b = NotificationCompat.Builder(this, "receiving").setSmallIcon(R.drawable.ic_stat_cd).setContentTitle("CD").setContentText(text).setOngoing(true).setContentIntent(open).addAction(android.R.drawable.ic_media_pause, "Stop", stop).setOnlyAlertOnce(true)
        if (offset != null && size != null && size > 0) b.setProgress(1000, (offset * 1000 / size).toInt(), false)
        return b.build()
    }
    private fun notify(text: String, offset: Long? = null, size: Long? = null) { Status.text = text; getSystemService(NotificationManager::class.java).notify(1, notification(text, offset, size)) }
    private fun runTask(initial: JSONObject) {
        val id = initial.getString("id")
        val attempt = scheduler.attempt(id)
        while (running.get()) {
            val task = store.task(id) ?: return
            if (task.getString("state") in listOf("paused", "complete", "cancelled")) return
            val local = task.optString("localUrl")
            val usingLocal = localEndpoint(local) && network.allowed(local) && (attempt % 2 == 0 || !network.allowed(Invitation.parse(task.getString("url")).relay))
            val endpoint = if (usingLocal) local else Invitation.parse(task.getString("url")).relay
            if (!network.allowed(endpoint)) { notify("Waiting for unmetered Wi-Fi or a local connection"); return }
            activeEndpoint = endpoint
            val rootId = Invitation.parse(task.getString("url")).id
            val route = if (usingLocal) "local" else "relay"
            fun diagnostic(event: String) { if (event == "direct-receiving") store.progress(id, route = "direct"); Log.i("CD", "root=$rootId route=$route attempt=${attempt + 1} event=$event") }
            try {
                diagnostic("starting")
                ReceiveGate.expiry(task.optLong("rootExpiresAt", 0))
                store.progress(id, route = route)
                store.state(id, "connecting") ?: return
                var lastNetworkCheck = 0L
                var allowed = true
                transferActive = true; renewWake.run()
                if (Invitation.parse(task.getString("url")).version == 1) {
                LegacyReceiver(this, store, network.client(client, endpoint), { transferSocket = it }, { name, offset, size ->
                    val now = SystemClock.elapsedRealtime()
                    val text = "$name · $offset / $size bytes"
                    store.progress(id, offset)
                    if (now - lastProgressAt >= 250) { lastProgressAt = now; notify(text, offset, size) }
                }, { val now = SystemClock.elapsedRealtime(); if (now - lastNetworkCheck >= 1000) { allowed = network.allowed(endpoint); lastNetworkCheck = now }; ReceiveGate.check(running.get(), store.taskState(id), allowed); true }).receive(task, endpoint)
                } else {
                ResumeReceiver(this, store, network.client(client, endpoint), { transferSocket = it }, { name, offset, size ->
                    val now = SystemClock.elapsedRealtime()
                    val text = "$name · $offset / $size bytes"
                    store.progress(id, offset)
                    if (now - lastProgressAt >= 250) { lastProgressAt = now; notify(text, offset, size) }
                }, { val now = SystemClock.elapsedRealtime(); if (now - lastNetworkCheck >= 1000) { allowed = network.allowed(endpoint); lastNetworkCheck = now }; ReceiveGate.check(running.get(), store.taskState(id), allowed); true }, ::diagnostic).receive(task, endpoint, usingLocal)
                }
                scheduler.finished(id)
                control(task.optString("pairId"), "received", id)
                notify("Saved to Downloads/CD"); return
            } catch (e: Exception) {
                releaseTransferWake()
                val reason = when (e) {
                    is UserPausedException -> "user-paused"
                    is TransientNetworkException -> "network-unavailable"
                    is ExpiredTransferException -> "transfer-expired"
                    is ExhaustedTransferException -> "session-limit"
                    is WireFailure -> "websocket-${e.phase}-${e.status ?: 0}"
                    is InsufficientSpaceException -> "insufficient-storage"
                    is java.security.GeneralSecurityException -> "authentication-failed"
                    is IllegalArgumentException -> "invalid-protocol"
                    is org.json.JSONException -> "invalid-json"
                    is InterruptedException -> "interrupted"
                    is IllegalStateException -> "state-or-publication-failed"
                    else -> if (e.message == "Admission timed out") "admission-timeout" else if (e.message == "Peer timed out") "peer-timeout" else "connection-or-storage-failed"
                }
                Log.w("CD", "root=$rootId route=$route attempt=${attempt + 1} event=failed exception=${e.javaClass.simpleName} reason=$reason cause=${e.cause?.javaClass?.simpleName ?: "none"}")
                val current = store.task(id) ?: return
                if (current.getString("state") == "complete") { cleanupStaging(current); control(task.optString("pairId"), "received", id); return }
                if (current.getString("state") in listOf("paused", "cancelled") || !running.get()) { control(task.optString("pairId"), "paused", id); return }
                if (Invitation.parse(task.getString("url")).version == 1) {
                    store.state(id, "paused", "This transfer cannot resume. Ask the sender for a new code or link.")
                    return
                }
                if (e is ExhaustedTransferException || (e is WireFailure && e.exhausted)) {
                    val message = ExhaustedTransferException().message!!
                    store.state(id, "paused", message); notify(message); return
                }
                if (e is ExpiredTransferException || (e is WireFailure && e.expired)) {
                    val message = ExpiredTransferException().message!!
                    store.state(id, "paused", message); notify(message); return
                }
                if (StorageBudget.exhausted(e, this)) {
                    val message = if (e is InsufficientSpaceException) e.message!! else "Storage is full. Free space on your phone, then tap Resume. Retained progress is safe."
                    StorageBudget.releaseReserve(this)
                    notify(message); runCatching { store.state(id, "paused", message) }; return
                }
                if (e is IllegalArgumentException || e is IllegalStateException || e is org.json.JSONException || e is java.security.GeneralSecurityException) {
                    store.state(id, "paused", e.message ?: "Transfer verification failed")
                    notify("Transfer paused: verification failed"); return
                }
                scheduler.failed(id, SystemClock.elapsedRealtime())
                store.state(id, "retrying", e.message ?: "Connection interrupted") ?: return
                notify("Interrupted. Retrying from saved progress")
                return
            } finally { activeEndpoint = null; releaseTransferWake(); transferSocket?.cancel(); transferSocket = null; store.task(id)?.takeIf { it.getString("state") == "cancelled" }?.let { TransferFiles.discard(this, store, id, receiverFinished = true) } }
        }
    }
    private fun releaseTransferWake() {
        transferActive = false
        handler.removeCallbacks(renewWake)
        if (wake?.isHeld == true) wake?.release()
    }
    private fun cleanupStaging(task: JSONObject) { runCatching { TransferFiles.staging(this, task) } }
    private fun discard(task: JSONObject) { TransferFiles.discard(this, store, task.getString("id")) }
    private fun connect(pair: Pairing, url: String, localTransport: Boolean) {
        if (!running.get() || stopping.get() || !network.allowed(url) || !validEndpoint(url)) return
        val key = "${pair.id}|${if (localTransport) "local" else "relay"}|$url"
        if (sockets.containsKey(key)) return
        val join = ControlJoin(pair, localTransport)
        val ws = network.client(client, url).newWebSocket(Request.Builder().url(url).build(), object: WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                if (!running.get() || store.pairs().none { it.id == pair.id }) { webSocket.cancel(); return }
                join.initial()?.let { webSocket.send(it.toString()) }
            }
            override fun onMessage(webSocket: WebSocket, text: String) {
                runCatching {
                    require(text.length <= 16384)
                    val e = JSONObject(text)
                    join.event(e)?.let { webSocket.send(it.toString()) }
                    when (e.getString("type")) {
                        "accepted" -> {
                            admitted[key] = webSocket; lastPing[key] = SystemClock.elapsedRealtime()
                            ControlHub.admitted(pair.id, url, webSocket)
                            if (!localTransport) PushBridge.admitted(this@ReceiverService, pair)
                        }
                        "peer-joined" -> ControlHub.peer(pair.id, webSocket, true)
                        "peer-left" -> ControlHub.peer(pair.id, webSocket, false)
                    }
                    if (e.getString("type") in listOf("accepted", "peer-joined")) sendControl(webSocket, pair, JSONObject().put("type", "paired").put("name", Build.MODEL))
                }.onFailure { webSocket.cancel() }
            }
            override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
                pool.execute {
                    runCatching {
                        if (stopping.get()) return@execute
                        require(join.admitted)
                        require(store.pairs().any { it.id == pair.id } && network.allowed(url))
                        val msg = pair.open(bytes.toByteArray())
                        // Replies to a phone-to-computer share belong to TrustedSend, not the receive queue.
                        if (msg.getString("type") != "offer") { ControlHub.message(pair.id, msg); return@execute }
                        val response = OfferIntake.accept(store, pair, url, localTransport, msg)
                        scheduler.wake(msg.getString("transferId"))
                        if (response != null) sendControl(webSocket, pair, JSONObject().put("type", response).put("transferId", msg.getString("transferId")))
                    }.onFailure { webSocket.cancel() }
                }
            }
            private fun remove(webSocket: WebSocket) { ControlHub.removed(pair.id, webSocket); sockets.remove(key, webSocket); if (admitted.remove(key, webSocket)) { lastPing.remove(key); if (!localTransport) PushBridge.disconnected(pair.id) } }
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) { remove(webSocket) }
            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) { remove(webSocket); webSocket.close(code, "") }
            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) { remove(webSocket) }
        })
        sockets.putIfAbsent(key, ws)?.let { ws.cancel() }
    }
    private fun sendControl(ws: WebSocket, pair: Pairing, msg: JSONObject) {
        msg.put("version", 1).put("messageId", Crypto.encode(Crypto.random(16))).put("expiresAt", System.currentTimeMillis() + 300000)
        ws.send(ByteString.of(*pair.seal(msg)))
    }
    private fun control(pairId: String, type: String, transferId: String) {
        val pair = store.pairs().firstOrNull { it.id == pairId } ?: return
        admitted.filterKeys { it.startsWith("$pairId|") }.values.forEach { sendControl(it, pair, JSONObject().put("type", type).put("transferId", transferId)) }
    }
    // NsdManager resolves one service at a time before Android 14 and fails concurrent resolves with
    // FAILURE_ALREADY_ACTIVE. Resolving every found service at once dropped all but the first, so
    // LAN control waited for the 2.5 s loop on stale addresses. Resolve them one after another.
    private val resolveQueue = ArrayDeque<NsdServiceInfo>()
    private var resolving = false
    private fun enqueueResolve(info: NsdServiceInfo) = handler.post {
        if (resolveQueue.none { it.serviceName == info.serviceName }) resolveQueue.addLast(info)
        resolveNext()
    }
    @Suppress("DEPRECATION") private fun resolveNext() {
        if (resolving || !running.get()) return
        val info = resolveQueue.removeFirstOrNull() ?: return
        resolving = true
        fun done() = handler.post { resolving = false; resolveNext() }
        runCatching {
            nsd.resolveService(info, object: NsdManager.ResolveListener {
                override fun onResolveFailed(info: NsdServiceInfo, code: Int) {
                    if (code == NsdManager.FAILURE_ALREADY_ACTIVE) handler.postDelayed({ enqueueResolve(info) }, 250)
                    done()
                }
                override fun onServiceResolved(found: NsdServiceInfo) {
                    runCatching {
                        val id = found.attributes["pairId"]?.toString(Charsets.UTF_8) ?: return@runCatching
                        val pair = store.pairs().firstOrNull { it.id == id } ?: return@runCatching
                        val host = found.host?.hostAddress?.substringBefore('%') ?: return@runCatching
                        val url = "ws://${if (host.contains(':')) "[$host]" else host}:${found.port}/ws/devices/v1/$id"
                        if (localEndpoint(url)) pool.execute { connect(pair, url, localTransport = true) }
                    }
                    done()
                }
            })
        }.onFailure { done() }
    }
    private fun discover() {
        val listener = object: NsdManager.DiscoveryListener {
            override fun onDiscoveryStarted(type: String) {}
            override fun onDiscoveryStopped(type: String) {}
            override fun onStartDiscoveryFailed(type: String, code: Int) { Status.text = "Local discovery unavailable ($code). Relay available." }
            override fun onStopDiscoveryFailed(type: String, code: Int) {}
            override fun onServiceLost(info: NsdServiceInfo) {}
            override fun onServiceFound(info: NsdServiceInfo) {
                if (info.serviceType.trimEnd('.') != "_cdx._tcp") return
                // Only resolve services for pairings this phone trusts (instance name is the pair id).
                if (store.pairs().none { it.id == info.serviceName }) return
                enqueueResolve(info)
            }
        }
        discovery = listener
        runCatching { nsd.discoverServices("_cdx._tcp.", NsdManager.PROTOCOL_DNS_SD, listener) }
    }
    override fun onDestroy() {
        alive = false; running.set(false); handler.removeCallbacks(renewWake)
        if (::store.isInitialized) store.pairs().forEach { PushBridge.disconnected(it.id) }
        sockets.values.forEach { it.close(1000, "Receiver stopped") }; transferSocket?.cancel(); discovery?.let { runCatching { nsd.stopServiceDiscovery(it) } }
        if (wake?.isHeld == true) wake?.release()
        networkCallback?.let { runCatching { getSystemService(ConnectivityManager::class.java).unregisterNetworkCallback(it) } }
        if (::network.isInitialized) network.close()
        pool.shutdownNow(); client.dispatcher.executorService.shutdown(); super.onDestroy()
    }
}
object StoreRegistry {
    @Volatile private var instance: Store? = null
    @Synchronized fun get(context: Context): Store = instance ?: Store(context.applicationContext).also { instance = it }
}
object Status {
    var text: String
        get() = TransferBus.receivingStatus.value
        set(value) { TransferBus.status(value) }
}

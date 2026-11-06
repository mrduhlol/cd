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
    @Volatile private var transferActive = false
    private var lastProgressAt = 0L
    private var wake: PowerManager.WakeLock? = null
    private val handler = Handler(Looper.getMainLooper())
    private val renewWake = object: Runnable { override fun run() { if (running.get() && transferActive) { if (wake?.isHeld == true) wake?.release(); wake?.acquire(10 * 60 * 1000L); handler.postDelayed(this, 9 * 60 * 1000L) } } }
    override fun onBind(intent: Intent?) = null
    override fun onCreate() {
        super.onCreate(); store = StoreRegistry.get(this)
        getSystemService(NotificationManager::class.java).createNotificationChannel(NotificationChannel("receiving", "File receiving", NotificationManager.IMPORTANCE_LOW))
        try {
            ServiceCompat.startForeground(this, 1, notification("Ready to receive", null, null), ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE)
            foregroundReady = true
        } catch (_: RuntimeException) { PushBridge.fallback(this); stopSelf(); return }
        PushBridge.start(this)
        wake = getSystemService(PowerManager::class.java).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "CD:receiver").apply { setReferenceCounted(false) }
        nsd = getSystemService(NsdManager::class.java)
        discover()
        val callback = object: ConnectivityManager.NetworkCallback() {
            override fun onCapabilitiesChanged(network: Network, capabilities: NetworkCapabilities) { if (!networkAllowed()) { sockets.values.forEach { it.cancel() }; sockets.clear(); transferSocket?.cancel() } }
            override fun onLost(network: Network) { transferSocket?.cancel() }
        }
        networkCallback = callback
        getSystemService(ConnectivityManager::class.java).registerDefaultNetworkCallback(callback)
        pool.execute {
            while (running.get()) {
                if (store.enabled() && networkAllowed()) Account.maintenance(this)
                PushBridge.maintenance(this)
                if (!receiving) store.tasks().filter { it.getString("state") == "cancelled" && !it.optBoolean("discarded") }.forEach { discard(it) }
                if (store.enabled() && networkAllowed()) {
                    store.pairs().forEach { pair ->
                        connect(pair, pair.json.getString("relayUrl"), localTransport = false)
                        pair.json.optJSONArray("localUrls")?.let { urls -> repeat(urls.length()) { connect(pair, urls.getString(it), localTransport = true) } }
                    }
                    heartbeat()
                    if (!receiving) {
                        val pending = store.tasks().filter { it.getString("state") in listOf("queued", "receiving", "retrying") }
                        val next = scheduler.next(pending.map { it.getString("id") }, SystemClock.elapsedRealtime())
                        pending.firstOrNull { it.getString("id") == next }?.let { task ->
                            receiving = true
                            pool.execute {
                                var active: JSONObject? = null
                                try {
                                    val resolved = resolveDownload(task)
                                    if (TransferFiles.start(resolved)) {
                                        active = resolved
                                        activeTaskId = resolved.getString("id")
                                        runTask(resolved)
                                    }
                                } catch (e: Exception) {
                                    val id = task.getString("id")
                                    if (running.get() && store.task(id)?.getString("state") !in listOf("paused", "cancelled", "complete")) {
                                        if (e is java.io.IOException && e !is ExpiredTransferException) {
                                            scheduler.failed(id, SystemClock.elapsedRealtime())
                                            store.state(id, "retrying", "Could not look up this code. Retrying when connected.")
                                        } else store.state(id, "paused", e.message ?: "Could not open this transfer")
                                    }
                                } finally {
                                    activeTaskId = null
                                    active?.let(TransferFiles::finish)
                                    receiving = false
                                }
                            }
                        }
                    }
                }
                try { Thread.sleep(2500) } catch (_: InterruptedException) { break }
            }
        }
    }
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (!foregroundReady) return START_NOT_STICKY
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
            "pause-task", "cancel-task" -> intent.getStringExtra("taskId")?.let { pauseTask(it, intent.action == "cancel-task") }
            "refresh" -> { store.pairs().forEach { PushBridge.disconnected(it.id) }; NativeNetworkDetector.refreshPolicy(); sockets.values.forEach { it.cancel() }; sockets.clear(); admitted.clear(); lastPing.clear(); transferSocket?.cancel() }
            else -> if (intent != null) { store.enabled(!stopping.get()); store.tasks().filter { it.getString("state") == "queued" }.forEach { scheduler.wake(it.getString("id")) } }
        }
        if (intent == null && !store.enabled()) stopSelf()
        return if (stopping.get()) START_NOT_STICKY else START_STICKY
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
    private fun permittedNetwork(): Network? {
        val cm = getSystemService(ConnectivityManager::class.java)
        if (store.allowedMobile()) return cm.activeNetwork
        return cm.allNetworks.firstOrNull { network ->
            val caps = cm.getNetworkCapabilities(network)
            caps != null && caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED) && !caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) && (caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) || caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET))
        }
    }
    private fun networkAllowed(): Boolean = permittedNetwork() != null
    private fun networkClient(): OkHttpClient {
        val network = permittedNetwork() ?: throw java.io.IOException("Waiting for unmetered Wi-Fi")
        return client.newBuilder().socketFactory(network.socketFactory).dns(object: Dns { override fun lookup(hostname: String): List<java.net.InetAddress> = network.getAllByName(hostname).toList() }).build()
    }
    private fun notification(text: String, offset: Long?, size: Long?): Notification {
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val stop = PendingIntent.getService(this, 1, Intent(this, ReceiverService::class.java).setAction("pause"), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val b = NotificationCompat.Builder(this, "receiving").setSmallIcon(R.drawable.ic_stat_cd).setContentTitle("CD").setContentText(text).setOngoing(true).setContentIntent(open).addAction(android.R.drawable.ic_media_pause, "Stop", stop).setOnlyAlertOnce(true)
        if (offset != null && size != null && size > 0) b.setProgress(1000, (offset * 1000 / size).toInt(), false)
        return b.build()
    }
    private fun notify(text: String, offset: Long? = null, size: Long? = null) { Status.text = text; getSystemService(NotificationManager::class.java).notify(1, notification(text, offset, size)) }
    private fun resolveDownload(task: JSONObject): JSONObject {
        if (!task.has("code")) return task
        val request = DownloadRequest.parse(task.getString("url"))
        require(request.code == task.getString("code"))
        val lookup = Request.Builder().url("https://cd.yash0.in/api/codes/${request.code}").build()
        val lookupClient = networkClient().newBuilder().callTimeout(10, TimeUnit.SECONDS).followRedirects(false).build()
        val url = lookupClient.newCall(lookup).execute().use { response ->
            if (response.code == 404) throw ExpiredTransferException()
            if (!response.isSuccessful) throw java.io.IOException("Code lookup unavailable")
            val body = response.body?.source() ?: error("Missing code response")
            require(!body.request(4097)) { "Invalid code response" }
            request.resolveCapability(JSONObject(body.readUtf8()))
        }
        return store.resolveDownload(task.getString("id"), url) ?: throw UserPausedException()
    }
    private fun runTask(initial: JSONObject) {
        val id = initial.getString("id")
        val attempt = scheduler.attempt(id)
        while (running.get()) {
            val task = store.task(id) ?: return
            if (task.getString("state") in listOf("paused", "complete", "cancelled")) return
            if (!networkAllowed()) { notify("Waiting for unmetered Wi-Fi"); return }
            val local = task.optString("localUrl")
            val usingLocal = attempt % 2 == 0 && localEndpoint(local)
            val invitation = Invitation.parse(task.getString("url"))
            val endpoint = if (usingLocal) local else invitation.relay
            val rootId = invitation.id
            val route = if (usingLocal) "local" else "relay"
            fun diagnostic(event: String) { Log.i("CD", "root=$rootId route=$route attempt=${attempt + 1} event=$event") }
            try {
                diagnostic("starting")
                ReceiveGate.expiry(task.optLong("rootExpiresAt", 0))
                store.state(id, "receiving") ?: return
                transferActive = true; renewWake.run()
                val reportProgress: (String, Long, Long) -> Unit = { name, offset, size ->
                    val now = SystemClock.elapsedRealtime()
                    val text = "$name · $offset / $size bytes"
                    Status.text = text
                    if (offset == size || now - lastProgressAt >= 250) { lastProgressAt = now; notify(text, offset, size) }
                }
                val keepReceiving = { ReceiveGate.check(running.get(), store.task(id)?.getString("state"), networkAllowed()); true }
                if (invitation.version == 1) {
                    OrdinaryReceiver(this, store, networkClient(), { transferSocket = it }, reportProgress, keepReceiving, ::diagnostic).receive(task, endpoint)
                } else {
                    ResumeReceiver(this, store, networkClient(), { transferSocket = it }, reportProgress, keepReceiving, ::diagnostic).receive(task, endpoint, usingLocal)
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
                if (e is ExhaustedTransferException || (e is WireFailure && e.exhausted)) {
                    val message = ExhaustedTransferException().message!!
                    store.state(id, "paused", message); notify(message); return
                }
                if (e is ExpiredTransferException || (e is WireFailure && e.expired)) {
                    val message = ExpiredTransferException().message!!
                    store.state(id, "paused", message); notify(message); return
                }
                if (StorageBudget.exhausted(e, this)) {
                    val message = if (invitation.version == 1) "Storage is full. Free space on your phone and ask the sender for a new link." else if (e is InsufficientSpaceException) e.message!! else "Storage is full. Free space on your phone, then tap Resume. Retained progress is safe."
                    StorageBudget.releaseReserve(this)
                    notify(message); runCatching { store.state(id, "paused", message) }; return
                }
                if (invitation.version == 1) {
                    store.state(id, "paused", "This ordinary transfer was interrupted. Ask the sender for a new link, or use cdx send --resume for resumable downloads.")
                    notify("Download interrupted. Ask the sender for a new link.")
                    return
                }
                if (e is IllegalArgumentException || e is IllegalStateException || e is org.json.JSONException || e is java.security.GeneralSecurityException) {
                    store.state(id, "paused", e.message ?: "Transfer verification failed")
                    notify("Transfer paused: verification failed"); return
                }
                scheduler.failed(id, SystemClock.elapsedRealtime())
                store.state(id, "retrying", e.message ?: "Connection interrupted") ?: return
                notify("Interrupted. Retrying from saved progress")
                return
            } finally { releaseTransferWake(); transferSocket?.cancel(); transferSocket = null; store.task(id)?.takeIf { it.getString("state") == "cancelled" }?.let { TransferFiles.discard(this, store, id, receiverFinished = true) } }
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
        if (!running.get() || stopping.get() || !networkAllowed() || !validEndpoint(url)) return
        val key = "${pair.id}|${if (localTransport) "local" else "relay"}|$url"
        if (sockets.containsKey(key)) return
        val join = ControlJoin(pair, localTransport)
        val ws = networkClient().newWebSocket(Request.Builder().url(url).build(), object: WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                if (!running.get() || store.pairs().none { it.id == pair.id }) { webSocket.cancel(); return }
                join.initial()?.let { webSocket.send(it.toString()) }
            }
            override fun onMessage(webSocket: WebSocket, text: String) {
                runCatching {
                    require(text.length <= 16384)
                    val e = JSONObject(text)
                    join.event(e)?.let { webSocket.send(it.toString()) }
                    if (e.getString("type") == "accepted") {
                        admitted[key] = webSocket; lastPing[key] = SystemClock.elapsedRealtime()
                        if (!localTransport) PushBridge.admitted(this@ReceiverService, pair)
                    }
                    if (e.getString("type") in listOf("accepted", "peer-joined")) sendControl(webSocket, pair, JSONObject().put("type", "paired").put("name", Build.MODEL))
                }.onFailure { webSocket.cancel() }
            }
            override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
                pool.execute {
                    runCatching {
                        if (stopping.get()) return@execute
                        require(join.admitted)
                        require(store.pairs().any { it.id == pair.id } && networkAllowed())
                        val msg = pair.open(bytes.toByteArray())
                        if (localTransport && localEndpoint(msg.optString("localUrl"))) {
                            val control = java.net.URI(url)
                            val data = java.net.URI(msg.getString("localUrl"))
                            val endpoint = java.net.URI("ws", null, control.host, data.port, data.path, null, null).toString()
                            require(localEndpoint(endpoint)); msg.put("localUrl", endpoint)
                        }
                        val added = store.addOffer(pair, msg, localTransport)
                        scheduler.wake(msg.getString("transferId"))
                        if (!added) store.task(msg.getString("transferId"))?.let { task ->
                            val response = when (task.getString("state")) { "complete" -> "received"; "paused", "cancelled" -> "paused"; else -> null }
                            if (response != null) sendControl(webSocket, pair, JSONObject().put("type", response).put("transferId", task.getString("id")))
                        }
                    }.onFailure { webSocket.cancel() }
                }
            }
            private fun remove(webSocket: WebSocket) { sockets.remove(key, webSocket); if (admitted.remove(key, webSocket)) { lastPing.remove(key); if (!localTransport) PushBridge.disconnected(pair.id) } }
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
    private fun discover() {
        val listener = object: NsdManager.DiscoveryListener {
            override fun onDiscoveryStarted(type: String) {}
            override fun onDiscoveryStopped(type: String) {}
            override fun onStartDiscoveryFailed(type: String, code: Int) { Status.text = "Local discovery unavailable ($code). Relay available." }
            override fun onStopDiscoveryFailed(type: String, code: Int) {}
            override fun onServiceLost(info: NsdServiceInfo) {}
            @Suppress("DEPRECATION") override fun onServiceFound(info: NsdServiceInfo) {
                if (info.serviceType != "_cdx._tcp.") return
                nsd.resolveService(info, object: NsdManager.ResolveListener {
                    override fun onResolveFailed(info: NsdServiceInfo, code: Int) {}
                    override fun onServiceResolved(found: NsdServiceInfo) {
                        val id = found.attributes["pairId"]?.toString(Charsets.UTF_8) ?: return
                        val pair = store.pairs().firstOrNull { it.id == id } ?: return
                        val host = found.host?.hostAddress?.substringBefore('%') ?: return
                        val url = "ws://${if (host.contains(':')) "[$host]" else host}:${found.port}/ws/devices/v1/$id"
                        if (localEndpoint(url)) connect(pair, url, localTransport = true)
                    }
                })
            }
        }
        discovery = listener
        runCatching { nsd.discoverServices("_cdx._tcp.", NsdManager.PROTOCOL_DNS_SD, listener) }
    }
    override fun onDestroy() {
        running.set(false); handler.removeCallbacks(renewWake)
        if (::store.isInitialized) store.pairs().forEach { PushBridge.disconnected(it.id) }
        sockets.values.forEach { it.close(1000, "Receiver stopped") }; transferSocket?.cancel(); discovery?.let { runCatching { nsd.stopServiceDiscovery(it) } }
        if (wake?.isHeld == true) wake?.release()
        networkCallback?.let { runCatching { getSystemService(ConnectivityManager::class.java).unregisterNetworkCallback(it) } }
        pool.shutdownNow(); client.dispatcher.executorService.shutdown(); super.onDestroy()
    }
}
object StoreRegistry {
    @Volatile private var instance: Store? = null
    @Synchronized fun get(context: Context): Store = instance ?: Store(context.applicationContext).also { instance = it }
}
object Status { @Volatile var text = "Receiving is off" }

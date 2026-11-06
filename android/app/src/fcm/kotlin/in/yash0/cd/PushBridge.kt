package `in`.yash0.cd

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.Build
import android.os.SystemClock
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import com.google.firebase.messaging.FirebaseMessaging
import okhttp3.Dns
import okhttp3.OkHttpClient
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong

object PushBridge {
    const val available = true
    @Volatile var status = "Wake-up notifications are off"
        private set
    private val executor = Executors.newSingleThreadExecutor()
    private val admitted = ConcurrentHashMap.newKeySet<String>()
    private val uploaded = ConcurrentHashMap<String, String>()
    private val due = ConcurrentHashMap<String, Long>()
    private val pending = AtomicBoolean(false)
    private val changes = AtomicLong(0)
    private val started = AtomicBoolean(false)
    private val registrationPending = AtomicBoolean(false)
    @Volatile private var nextRegistration = 0L
    private val base = OkHttpClient.Builder().connectTimeout(5, TimeUnit.SECONDS).readTimeout(8, TimeUnit.SECONDS).callTimeout(12, TimeUnit.SECONDS).followRedirects(false).followSslRedirects(false).build()

    @Synchronized fun start(context: Context) {
        val app = context.applicationContext
        if (started.compareAndSet(false, true)) {
            val enabled = StoreRegistry.get(app).pushEnabled()
            firebase { isAutoInitEnabled = enabled }
            status = if (enabled) "Registering wake-up notifications" else "Wake-up notifications are off"
        }
        maintenance(app)
    }
    @Synchronized fun setEnabled(context: Context, enabled: Boolean) {
        val store = StoreRegistry.get(context)
        if (!enabled) store.pairs().forEach { store.queuePushDelete(it) }
        store.pushEnabled(enabled)
        changes.incrementAndGet()
        uploaded.clear(); due.clear(); nextRegistration = 0
        firebase { isAutoInitEnabled = enabled }
        if (!enabled) {
            status = "Wake-up notifications are off"
            context.getSystemService(NotificationManager::class.java).cancel(2)
            firebase { unregister() }
            store.pushFid("")
        } else status = "Registering wake-up notifications"
        maintenance(context.applicationContext)
    }
    @Synchronized fun registered(context: Context, fid: String) {
        val store = StoreRegistry.get(context)
        if (!store.pushEnabled()) { firebase { isAutoInitEnabled = false; unregister() }; return }
        if (!fid.matches(Regex("[A-Za-z0-9_-]{22}"))) { status = "Wake-up registration unavailable"; return }
        changes.incrementAndGet()
        store.pushFid(fid); uploaded.clear(); due.clear()
        status = "Waiting for trusted relay connection"
        maintenance(context.applicationContext)
    }
    fun admitted(context: Context, pair: Pairing) {
        // Credentials are posted only after authenticated relay admission, never LAN admission.
        changes.incrementAndGet()
        admitted.add(pair.id)
        uploaded.remove(pair.id); due.remove(pair.id)
        maintenance(context.applicationContext)
    }
    fun disconnected(pairId: String) { admitted.remove(pairId); uploaded.remove(pairId) }
    @Synchronized fun revoke(context: Context, pair: Pairing) {
        // Persist the scoped deletion credential before the caller drops the trusted pair.
        changes.incrementAndGet()
        StoreRegistry.get(context).queuePushDelete(pair)
        disconnected(pair.id)
        maintenance(context.applicationContext)
    }
    private fun firebase(block: FirebaseMessaging.() -> Unit) { runCatching { FirebaseMessaging.getInstance().block() } }
    @Synchronized private fun unavailable(store: Store) { if (store.pushEnabled()) status = "Wake-up unavailable; receiving still works" }
    private fun registration(store: Store) {
        val now = SystemClock.elapsedRealtime()
        if (!store.pushEnabled() || now < nextRegistration || !registrationPending.compareAndSet(false, true)) return
        nextRegistration = now + 3600000
        runCatching { FirebaseMessaging.getInstance().register().addOnCompleteListener { task ->
            registrationPending.set(false)
            if (!task.isSuccessful && store.pushEnabled()) { nextRegistration = SystemClock.elapsedRealtime() + 30000; unavailable(store) }
        } }.onFailure { registrationPending.set(false); nextRegistration = now + 30000; unavailable(store) }
    }
    fun maintenance(context: Context) {
        val app = context.applicationContext
        val store = StoreRegistry.get(app)
        if (networkClient(app) != null) registration(store)
        if (!pending.compareAndSet(false, true)) return
        val observed = changes.get()
        executor.execute {
            try {
                val now = SystemClock.elapsedRealtime()
                // A stale DELETE must finish before a later opt-in can register the same pair.
                store.pushDeletes().forEach { target ->
                    val id = target.getString("id")
                    if (now < (due["delete:$id"] ?: 0)) return@forEach
                    val client = networkClient(app) ?: return@forEach
                    val done = request(client, target.getString("relayUrl"), id, target.getString("token"), null, delete = true)
                    if (done) { store.finishPushDelete(id); due.remove("delete:$id") } else due["delete:$id"] = now + 30000
                }
                if (!store.pushEnabled()) return@execute
                val fid = store.pushFid()
                if (fid.isEmpty()) return@execute
                val deleting = store.pushDeletes().map { it.getString("id") }.toSet()
                store.pairs().forEach { pair ->
                    if (!store.pushEnabled() || pair.id in deleting || uploaded[pair.id] == fid || now < (due[pair.id] ?: 0)) return@forEach
                    if (!admitted.contains(pair.id)) return@forEach
                    val client = networkClient(app) ?: return@forEach
                    // Recheck trust after taking the admission snapshot; revocation runs on the UI thread.
                    if (store.pairs().none { it.id == pair.id }) return@forEach
                    if (request(client, pair.json.getString("relayUrl"), pair.id, pair.token(), fid, delete = false)) {
                        synchronized(this@PushBridge) {
                            if (store.pushEnabled() && store.pushFid() == fid && store.pairs().any { it.id == pair.id } && store.pushDeletes().none { it.getString("id") == pair.id }) {
                                uploaded[pair.id] = fid; due.remove(pair.id); status = "Wake-up notifications enabled"
                            }
                        }
                    } else {
                        due[pair.id] = now + 30000
                        unavailable(store)
                    }
                }
            } catch (_: Exception) { unavailable(store) }
            finally { pending.set(false); if (changes.get() != observed) maintenance(app) }
        }
    }
    private fun request(client: OkHttpClient, relay: String, id: String, token: String, fid: String?, delete: Boolean): Boolean = runCatching {
        val req = PushTarget.request(relay, id, token, if (delete) null else fid)
        client.newCall(req).execute().use { it.isSuccessful || (delete && it.code in setOf(401, 404, 410)) }
    }.getOrDefault(false)
    private fun networkClient(context: Context): OkHttpClient? {
        val store = StoreRegistry.get(context)
        val cm = context.getSystemService(ConnectivityManager::class.java)
        val network = if (store.allowedMobile()) cm.activeNetwork else cm.allNetworks.firstOrNull { network ->
            cm.getNetworkCapabilities(network)?.let { caps -> caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED) && !caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) && (caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) || caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET)) } == true
        }
        return network?.let { base.newBuilder().socketFactory(it.socketFactory).dns(object: Dns { override fun lookup(hostname: String) = it.getAllByName(hostname).toList() }).build() }
    }
    fun canWake(context: Context, pairId: String): Boolean {
        val store = StoreRegistry.get(context)
        return PushPolicy.canReceive(store.pushEnabled(), store.enabled(), store.pairs().any { it.id == pairId }, notifications(context))
    }
    fun notifications(context: Context): Boolean = NotificationManagerCompat.from(context).areNotificationsEnabled() && (Build.VERSION.SDK_INT < 33 || ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED)
    fun fallback(context: Context) {
        val store = StoreRegistry.get(context)
        if (!store.pushEnabled() || !store.enabled() || store.pairs().isEmpty() || !notifications(context)) return
        val manager = context.getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(NotificationChannel("wake", "Trusted transfer wake-up", NotificationManager.IMPORTANCE_DEFAULT))
        val open = PendingIntent.getActivity(context, 2, Intent(context, MainActivity::class.java).setAction("push-open"), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        manager.notify(2, NotificationCompat.Builder(context, "wake").setSmallIcon(R.drawable.ic_stat_cd).setContentTitle("CD is ready to reconnect").setContentText("Tap to receive from your trusted devices.").setContentIntent(open).setAutoCancel(true).setOnlyAlertOnce(true).build())
    }
}

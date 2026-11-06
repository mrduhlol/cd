package `in`.yash0.cd

import android.Manifest
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.view.WindowManager
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.core.content.ContextCompat
import androidx.core.content.IntentCompat
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import `in`.yash0.cd.ui.CdActions
import `in`.yash0.cd.ui.CdDialog
import `in`.yash0.cd.ui.CdIcons
import `in`.yash0.cd.ui.CdApp
import `in`.yash0.cd.ui.CdTheme
import `in`.yash0.cd.ui.DebugFakes
import `in`.yash0.cd.ui.PreviewData
import `in`.yash0.cd.ui.ReceiveMode
import `in`.yash0.cd.ui.Tab
import `in`.yash0.cd.ui.TrustedOffers
import `in`.yash0.cd.ui.Screen
import `in`.yash0.cd.ui.UiState
import `in`.yash0.cd.ui.active
import org.json.JSONObject

class MainActivity: ComponentActivity(), CdActions {
    private lateinit var store: Store
    private val ui = UiState()
    private val debug by lazy { applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0 }
    private var downloadLink by mutableStateOf<String?>(null)
    private var returnAfterReceive = false
    private var returnAfterPermission = false
    // Asked only when a transfer starts or a device is paired, never on first launch.
    private val notifications = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (!granted) ui.toast("Progress won’t show in notifications")
        if (returnAfterPermission) moveTaskToBack(true)
        returnAfterPermission = false
        refresh()
    }
    private val pushNotifications = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted -> if (granted) PushBridge.setEnabled(this, true) else TransferBus.status("Allow notifications to enable trusted wake-up"); refresh() }
    private val scanner = registerForActivityResult(ScanContract()) { result -> result.contents?.let { ui.input = it; submit(it.trim()) } }
    // OPEN_DOCUMENT (not GET_CONTENT) so the read grant can be persisted: a send interrupted by the app
    // closing can be resumed later from the same uris.
    private val picker = registerForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris ->
        uris.forEach { runCatching { contentResolver.takePersistableUriPermission(it, Intent.FLAG_GRANT_READ_URI_PERMISSION) } }
        val to = pickTarget?.let { id -> ui.pairs.firstOrNull { it.id == id } }
        pickTarget = null
        if (uris.isNotEmpty()) startSend(uris, to)
    }
    /** Pair id the open picker is choosing files for; survives recreation while the picker is up. */
    private var pickTarget: String? = null
    private val prefs by lazy { getSharedPreferences("cd-ui", MODE_PRIVATE) }

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge(SystemBarStyle.dark(Color.TRANSPARENT), SystemBarStyle.dark(Color.TRANSPARENT))
        super.onCreate(savedInstanceState)
        store = StoreRegistry.get(this)
        Senders.install(applicationContext)
        ReceiveViews.load(applicationContext)
        PushBridge.start(this)
        ReceiveMode.load(this)
        // Control links to paired computers start in onStart (ReceiveMode.onForeground) and stop once idle in the background.
        refresh()
        ui.restoreNav(savedInstanceState?.getString("cd.navigation"))
        pickTarget = savedInstanceState?.getString("cd.pickTarget")
        downloadLink = savedInstanceState?.getString("cd.downloadLink")
        returnAfterPermission = savedInstanceState?.getBoolean("cd.returnAfterPermission") ?: false
        ui.sendPrivate = prefs.getBoolean("sendPrivate", false)
        lifecycleScope.launch { TrustedOffers.messages.collect { (text, error) -> ui.toast(text, error) } }
        if (savedInstanceState == null && intent.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY == 0) acceptIntent(intent)
        setContent {
            val transfers by TransferBus.transfers.collectAsState()
            val status by TransferBus.receivingStatus.collectAsState()
            val paused by ReceiveMode.paused.collectAsState()
            val wake by ReceiveMode.wakeAvailable.collectAsState()
            LaunchedEffect(status, paused, wake) { refresh() }
            // Sending is foreground-only by design, so keep the screen on while a send is running.
            val sending = transfers.any { it.direction == Direction.SEND && it.active }
            LaunchedEffect(sending) { if (sending) window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON) else window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON) }
            CdTheme {
                CdApp(ui, transfers, status, this, debug, versionName())
                downloadLink?.takeUnless { ui.resolving }?.let { raw ->
                    CdDialog(
                        title = "Accept download?",
                        body = "Accept to download this file to Downloads/CD in the background. You can leave CD or turn off the screen. The sender must stay online.",
                        detail = ui.inputError.takeIf { it.isNotBlank() } ?: if (ui.mobile) "Mobile data is allowed." else "Downloads wait for unmetered Wi-Fi or Ethernet.",
                        confirm = "Accept", dismiss = "Reject", icon = CdIcons.ArrowDown,
                        onConfirm = {
                            returnAfterReceive = true
                            submit(raw)
                        },
                        onDismiss = {
                            downloadLink = null
                            returnAfterReceive = false
                            ui.inputError = ""
                            moveTaskToBack(true)
                        },
                    )
                }
            }
        }
    }

    override fun onSaveInstanceState(outState: Bundle) {
        outState.putString("cd.navigation", ui.saveNav())
        pickTarget?.let { outState.putString("cd.pickTarget", it) }
        outState.putString("cd.downloadLink", downloadLink)
        outState.putBoolean("cd.returnAfterPermission", returnAfterPermission)
        super.onSaveInstanceState(outState)
    }

    override fun onNewIntent(intent: Intent) { super.onNewIntent(intent); setIntent(intent); acceptIntent(intent) }
    override fun onResume() { super.onResume(); refresh() }
    // Paired computers can pair, confirm and send while CD is open; see ReceiveMode.
    override fun onStart() { super.onStart(); ReceiveMode.onForeground(this) }
    override fun onStop() { ReceiveMode.onBackground(this); super.onStop() }

    private fun acceptIntent(intent: Intent) {
        if (debug) intent.getStringExtra("cd.debug")?.let { debugScenario(it, intent); return }
        if (intent.action == Intent.ACTION_SEND || intent.action == Intent.ACTION_SEND_MULTIPLE) {
            val uris = if (intent.action == Intent.ACTION_SEND_MULTIPLE) IntentCompat.getParcelableArrayListExtra(intent, Intent.EXTRA_STREAM, Uri::class.java).orEmpty()
                else listOfNotNull(IntentCompat.getParcelableExtra(intent, Intent.EXTRA_STREAM, Uri::class.java))
            if (uris.isNotEmpty()) { startSend(uris); return }
        }
        val text = (intent.dataString ?: intent.getStringExtra(Intent.EXTRA_TEXT)).orEmpty().trim()
        if (text.isEmpty()) return
        ui.home(); ui.tab = Tab.RECEIVE; ui.input = ""; ui.inputError = ""
        if (text.startsWith("cdpair:", ignoreCase = true)) submit(text)
        else downloadLink = text
    }

    private fun notificationsAllowed() = Build.VERSION.SDK_INT < 33 || ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED

    private fun refresh() {
        ui.paused = ReceiveMode.paused.value
        ui.wakeAvailable = ReceiveMode.wakeAvailable.value
        ui.pairs = store.pairs() + (if (debug) DebugFakes.pairs else emptyList())
        ui.mobile = store.allowedMobile()
        ui.push = store.pushEnabled()
    }

    private fun askNotifications() { if (!notificationsAllowed()) notifications.launch(Manifest.permission.POST_NOTIFICATIONS) }
    /** A real receive transfer was queued: ask for notifications once, then run it. */
    private fun receiveNow() {
        if (returnAfterReceive) {
            ReceiveMode.setPaused(this, false)
            returnAfterPermission = !notificationsAllowed()
        }
        askNotifications()
        ReceiveMode.startTransfer(this)
        if (returnAfterReceive) {
            downloadLink = null
            if (!returnAfterPermission) moveTaskToBack(true)
            returnAfterReceive = false
        }
    }
    private fun refreshService() { if (store.enabled()) startService(Intent(this, ReceiverService::class.java).setAction("refresh")) }
    private fun taskAction(id: String, cancel: Boolean) {
        if (store.enabled()) startService(Intent(this, ReceiverService::class.java).setAction(if (cancel) "cancel-task" else "pause-task").putExtra("taskId", id))
        else { store.state(id, "paused"); if (cancel) { store.state(id, "cancelled"); TransferFiles.discard(this, store, id) } }
    }

    /** Sends to a trusted computer always use a private link: a code's key is held by the relay. */
    private fun startSend(uris: List<Uri>, to: Pairing? = null) {
        ui.home(); ui.tab = Tab.SEND
        askNotifications()
        runCatching { TransferBus.sender.start(this, uris, privateLink = to != null || ui.sendPrivate) }
            .onSuccess { id -> ui.sendError = null; ui.open(Screen.Transfer(id, Direction.SEND)); if (to != null) TrustedOffers.whenReady(this, id, to) }
            .onFailure { ui.sendError = it.message ?: "Sending failed" }
    }

    /* ---------- CdActions ---------- */

    override fun pickFiles(to: Pairing?) {
        pickTarget = to?.id
        runCatching { picker.launch(arrayOf("*/*")) }.onFailure { pickTarget = null; ui.sendError = "No file picker is available on this phone" }
    }

    override fun setSendPrivate(on: Boolean) { ui.sendPrivate = on; prefs.edit().putBoolean("sendPrivate", on).apply() }

    override fun sendToDevice(view: TransferView, pair: Pairing) = TrustedOffers.offerNow(this, view, pair)

    override fun scan() {
        scanner.launch(ScanOptions().setDesiredBarcodeFormats(ScanOptions.QR_CODE).setBeepEnabled(false).setCaptureActivity(QrScannerActivity::class.java).setOrientationLocked(false))
    }

    override fun submit(raw: String) {
        val input = raw.trim()
        if (ui.resolving) return
        val lookup = runCatching { ShareCodes.lookupUrl(input) }.getOrElse { ui.inputError = it.message ?: "Invalid code"; return }
        if (lookup == null) { submitLink(input); return }
        ui.resolving = true
        lifecycleScope.launch {
            runCatching { withContext(Dispatchers.IO) { ShareCodes.resolve(lookup) } }
                .onSuccess { ui.resolving = false; submitLink(it) }
                .onFailure { returnAfterReceive = false; ui.resolving = false; ui.inputError = it.message ?: "Could not look up code" }
        }
    }

    private fun submitLink(raw: String) {
        if (raw.isBlank()) return
        runCatching {
            if (raw.startsWith("cdpair:", ignoreCase = true)) ui.pending = Pairing.parse(raw)
            else {
                val invitation = runCatching { Invitation.parse(raw) }.getOrElse { e -> throw IllegalArgumentException(if (e.message?.contains("v2") == true) e.message else "That isn’t a CD link. Paste the sender’s private link.") }
                val id = invitation.id
                if (TransferBus.sender.owns(id)) {
                    returnAfterReceive = false
                    downloadLink = null
                    ui.open(Screen.Transfer(id, Direction.SEND))
                    ui.input = ""; ui.inputError = ""
                    ui.toast("This phone is sending this file. Open the invitation on another device.")
                    return
                }
                val prior = store.task(id)
                require(prior?.optString("state") != "complete") { "This transfer is already saved" }
                store.putTask((prior ?: JSONObject().put("id", id).put("url", raw)).put("state", "queued"))
                if (ReceiveMode.paused.value) ui.toast("Receiving is paused in Settings")
                receiveNow(); ui.input = ""
                // Optimistic row so the user lands on the transfer immediately; the receiver replaces it by id.
                if (TransferBus.transfers.value.none { it.id == id && it.direction == Direction.RECEIVE }) TransferBus.publish(TransferView(id, Direction.RECEIVE, prior?.optString("filename")?.takeIf { it.isNotEmpty() } ?: "Private transfer", prior?.optString("size")?.toLongOrNull() ?: -1, 0, 0, TransferPhase.WAITING, message = "Connecting to the sender"))
                ui.open(Screen.Transfer(id, Direction.RECEIVE))
            }
            ui.inputError = ""
        }.onFailure { returnAfterReceive = false; returnAfterPermission = false; ui.inputError = it.message ?: "Invalid link" }
        refresh()
    }

    override fun setPaused(paused: Boolean) { ReceiveMode.setPaused(this, paused); refresh() }

    override fun trust(pair: Pairing) {
        runCatching {
            require(pair.json.getLong("expiresAt") > System.currentTimeMillis())
            if (!pair.json.optBoolean("debugFake")) { store.trust(pair); ReceiveMode.paired(this); askNotifications() }
            ui.pending = null; ui.input = ""; ui.toast("Trusted ${pair.name}")
        }.onFailure { ui.inputError = "Pairing expired. Run cdx pair again."; ui.pending = null }
        refresh()
    }

    override fun revoke(pair: Pairing) {
        if (pair.json.optBoolean("debugFake")) DebugFakes.revoke(pair.id)
        else { PushBridge.revoke(this, pair); store.revoke(pair.id); refreshService() }
        refresh()
    }

    override fun setMobile(on: Boolean) { store.mobile(on); refreshService(); refresh() }

    override fun setPush(on: Boolean) {
        if (on && !notificationsAllowed()) pushNotifications.launch(Manifest.permission.POST_NOTIFICATIONS) else PushBridge.setEnabled(this, on)
        refresh()
    }

    override fun pause(view: TransferView) {
        if (view.direction == Direction.SEND) runCatching { TransferBus.sender.pause(this, view.id) }.onFailure { ui.toast(it.message ?: "Can’t pause", error = true) } else taskAction(view.id, cancel = false)
    }

    override fun resume(view: TransferView) {
        if (view.direction == Direction.SEND) runCatching { TransferBus.sender.resume(this, view.id) }.onFailure { ui.toast(it.message ?: "Can’t resume", error = true) }
        else { store.state(view.id, "queued"); receiveNow() }
    }

    override fun cancel(view: TransferView) {
        if (view.direction == Direction.SEND) runCatching { TransferBus.sender.cancel(this, view.id) }.onFailure { ui.toast(it.message ?: "Can’t cancel", error = true) } else taskAction(view.id, cancel = true)
    }

    override fun open(view: TransferView) {
        val uri = view.openUri ?: store.task(view.id)?.optString("publishedUri")?.takeIf { it.isNotEmpty() }
        runCatching { startActivity(Intent(Intent.ACTION_VIEW).setDataAndType(Uri.parse(uri), "*/*").addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)) }
            .onFailure { ui.toast("Open the file in Downloads/CD", error = true) }
    }

    override fun dismiss(view: TransferView) { TransferBus.remove(view.id, view.direction); ui.back() }

    override fun copy(label: String, text: String) {
        getSystemService(ClipboardManager::class.java).setPrimaryClip(ClipData.newPlainText(label, text))
        ui.toast("$label copied")
    }

    override fun share(text: String) { startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, text), "Share")) }

    override fun paste(): String? = getSystemService(ClipboardManager::class.java).primaryClip?.takeIf { it.itemCount > 0 }?.getItemAt(0)?.coerceToText(this)?.toString()?.trim()

    override fun batterySettings() {
        runCatching { startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)) }
            .onFailure { startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName"))) }
    }

    /* ---------- debug-only fake data ---------- */

    override fun debugInject() { if (debug) { DebugFakes.apply("all"); refresh(); ui.toast("Injected fake transfers") } }

    private fun debugScenario(scenario: String, intent: Intent) {
        DebugFakes.apply(scenario); refresh()
        ui.pending = null; ui.sendError = null
        ui.home(); ui.tab = Tab.SEND
        when (intent.getStringExtra("cd.debug.screen")) {
            "send" -> ui.tab = Tab.SEND
            "receive" -> ui.tab = Tab.RECEIVE
            "transfers", "history" -> ui.tab = Tab.TRANSFERS
            "devices" -> ui.tab = Tab.DEVICES
            "settings" -> ui.open(Screen.Settings)
            "transfer" -> if (scenario in PreviewData.scenarios) ui.open(PreviewData.view(scenario).let { Screen.Transfer(it.id, it.direction) })
        }
        if (intent.getBooleanExtra("cd.debug.pairing", false)) ui.pending = PreviewData.fakePair("yash-thinkpad", "pY3kQ9mVt2LwR8cZ1nB4xA")
        intent.getStringExtra("cd.debug.error")?.let { ui.sendError = it }
    }

    @Suppress("DEPRECATION")
    private fun versionName(): String = runCatching { packageManager.getPackageInfo(packageName, 0).versionName }.getOrNull() ?: ""
}

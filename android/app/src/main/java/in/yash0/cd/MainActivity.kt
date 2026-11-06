package `in`.yash0.cd

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import org.json.JSONObject

class MainActivity: ComponentActivity() {
    private lateinit var store: Store
    private var incoming by mutableStateOf("")
    private var backgroundAfterPermission = false
    private var incomingFromLink = false
    private val notifications = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (!granted) Status.text = "Receiving in the background. Notifications are disabled."
        if (backgroundAfterPermission) moveTaskToBack(true)
        backgroundAfterPermission = false
    }
    private val pushNotifications = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted -> if (granted) PushBridge.setEnabled(this, true) else Status.text = "Allow notifications to enable trusted wake-up" }
    private val scan = registerForActivityResult(ScanContract()) { result -> result.contents?.let { incomingFromLink = false; incoming = it } }
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        store = StoreRegistry.get(this)
        PushBridge.start(this)
        backgroundAfterPermission = savedInstanceState?.getBoolean("backgroundAfterPermission") ?: false
        if (savedInstanceState == null) acceptIntent(intent)
        if (store.enabled()) startReceiver()
        setContent { MaterialTheme(colorScheme = lightColorScheme(primary = Color(0xff225a45), background = Color(0xfff7f6f1), surface = Color(0xfff7f6f1))) { App() } }
    }
    override fun onNewIntent(intent: Intent) { super.onNewIntent(intent); setIntent(intent); acceptIntent(intent) }
    override fun onSaveInstanceState(outState: Bundle) {
        outState.putBoolean("backgroundAfterPermission", backgroundAfterPermission)
        super.onSaveInstanceState(outState)
    }
    private fun acceptIntent(intent: Intent) {
        incomingFromLink = intent.action == Intent.ACTION_VIEW || intent.action == Intent.ACTION_SEND
        incoming = intent.dataString ?: intent.getStringExtra(Intent.EXTRA_TEXT).orEmpty()
    }
    private fun enable(background: Boolean = false) {
        startReceiver()
        if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            backgroundAfterPermission = background
            notifications.launch(Manifest.permission.POST_NOTIFICATIONS)
        } else if (background) moveTaskToBack(true)
    }
    private fun startReceiver() { store.enabled(true); ContextCompat.startForegroundService(this, Intent(this, ReceiverService::class.java)); Status.text = "Ready to receive" }
    private fun refreshService() { if (store.enabled()) startService(Intent(this, ReceiverService::class.java).setAction("refresh")) }
    private fun taskAction(id: String, cancel: Boolean) {
        if (store.enabled()) startService(Intent(this, ReceiverService::class.java).setAction(if (cancel) "cancel-task" else "pause-task").putExtra("taskId", id))
        else { store.state(id, "paused"); if (cancel) { store.state(id, "cancelled"); TransferFiles.discard(this, store, id) } }
    }
    @Composable private fun App() {
        var input by rememberSaveable { mutableStateOf("") }
        var downloadLink by rememberSaveable { mutableStateOf<String?>(null) }
        var returnToCaller by rememberSaveable { mutableStateOf(false) }
        var downloadError by rememberSaveable { mutableStateOf("") }
        var pending by remember { mutableStateOf<Pairing?>(null) }
        var error by remember { mutableStateOf("") }
        var revision by remember { mutableIntStateOf(0) }
        LaunchedEffect(Unit) { while (true) { kotlinx.coroutines.delay(1000); revision++ } }
        fun parse(raw: String, external: Boolean = false) {
            if (!raw.startsWith("cdpair:")) {
                downloadLink = raw
                returnToCaller = external
                downloadError = ""
                return
            }
            runCatching { pending = Pairing.parse(raw); error = "" }
                .onFailure { error = it.message ?: "Invalid pairing link" }
        }
        LaunchedEffect(incoming) {
            if (incoming.isNotBlank()) {
                val raw = incoming.trim()
                incoming = ""
                input = raw
                parse(raw, incomingFromLink)
            }
        }
        val pairs = remember(revision) { store.pairs() }
        val tasks = remember(revision) { store.tasks() }
        val enabled = remember(revision) { store.enabled() }
        Column(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background).statusBarsPadding().navigationBarsPadding().verticalScroll(rememberScrollState()).padding(24.dp), verticalArrangement = Arrangement.spacedBy(18.dp)) {
            Text("CD", style = MaterialTheme.typography.displayLarge, fontWeight = FontWeight.Bold)
            Text("Your files. Your devices.", style = MaterialTheme.typography.titleLarge)
            Text(if (enabled) Status.text else "Receiving is off", style = MaterialTheme.typography.bodyLarge)
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Button(onClick = { enable(); revision++ }) { Text(if (enabled) "Receiving enabled" else "Enable receiving") }
                if (enabled) OutlinedButton(onClick = { startService(Intent(this@MainActivity, ReceiverService::class.java).setAction("pause")); revision++ }) { Text("Stop") }
            }
            Text("Stop keeps saved progress for resumable transfers. Ordinary transfers need a new link after stopping.", style = MaterialTheme.typography.bodyMedium)
            HorizontalDivider()
            Text("Account receiving", style = MaterialTheme.typography.headlineSmall)
            Text(Account.status)
            Text("Signing in authorizes your own signed-in terminals to send files automatically while receiving is enabled.")
            if (store.account() == null) Button(onClick = { Account.login(this@MainActivity); enable(); revision++ }, enabled = !Account.signingIn) { Text("Sign in with Clerk") }
            else OutlinedButton(onClick = { Account.logout(this@MainActivity); refreshService(); revision++ }) { Text("Sign out and revoke account devices") }
            Text("Trusted devices", style = MaterialTheme.typography.headlineSmall)
            if (pairs.isEmpty()) Text("Run cdx pair on your laptop. Scan its QR code and confirm Trust here.")
            pairs.forEach { pair ->
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                    Column(Modifier.weight(1f)) { Text(pair.name, style = MaterialTheme.typography.titleMedium); Text("Trusted · ${pair.id.take(8)}", style = MaterialTheme.typography.bodySmall) }
                    TextButton(onClick = { PushBridge.revoke(this@MainActivity, pair); store.revoke(pair.id); refreshService(); revision++ }) { Text("Revoke") }
                }
            }
            OutlinedButton(onClick = { scan.launch(ScanOptions().setDesiredBarcodeFormats(ScanOptions.QR_CODE).setPrompt("Scan the cdx pair QR code").setBeepEnabled(false).setOrientationLocked(false)) }) { Text("Scan pairing QR") }
            OutlinedTextField(value = input, onValueChange = { input = it }, modifier = Modifier.fillMaxWidth(), label = { Text("Pairing link, transfer link or short code") }, minLines = 2, maxLines = 4)
            Button(onClick = { parse(input.trim()) }, enabled = input.isNotBlank()) { Text(if (input.startsWith("cdpair:")) "Review device" else "Receive file") }
            if (error.isNotBlank()) Text(error, color = MaterialTheme.colorScheme.error)
            HorizontalDivider()
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Column(Modifier.weight(1f)) { Text("Allow mobile or metered data", style = MaterialTheme.typography.titleMedium); Text("Off by default. Unmetered Wi-Fi still works.", style = MaterialTheme.typography.bodySmall) }
                Switch(checked = remember(revision) { store.allowedMobile() }, onCheckedChange = { store.mobile(it); refreshService(); revision++ })
            }
            if (PushBridge.available) {
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                    Column(Modifier.weight(1f)) { Text("Trusted wake-up notifications", style = MaterialTheme.typography.titleMedium); Text(PushBridge.status, style = MaterialTheme.typography.bodySmall) }
                    Switch(checked = remember(revision) { store.pushEnabled() }, onCheckedChange = { enabled ->
                        if (enabled && Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(this@MainActivity, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) pushNotifications.launch(Manifest.permission.POST_NOTIFICATIONS)
                        else PushBridge.setEnabled(this@MainActivity, enabled)
                        revision++
                    })
                }
                Text("Google delivers a wake-up hint for trusted devices. Receiving must stay enabled. Stop and paused transfers stay paused. File transfers still follow your mobile data setting.", style = MaterialTheme.typography.bodySmall)
            }
            Text("Keep Ready to receive enabled for trusted transfers with the screen off. Samsung battery settings can stop background apps. After a force-stop, open CD and enable receiving again.", style = MaterialTheme.typography.bodySmall)
            Text("Transfers", style = MaterialTheme.typography.headlineSmall)
            if (tasks.isEmpty()) Text("Received files appear in Downloads/CD.")
            tasks.asReversed().take(30).forEach { task ->
                val state = task.getString("state")
                Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text(task.optString("filename", "Private transfer"), style = MaterialTheme.typography.titleMedium)
                    Text(state.replaceFirstChar { it.uppercase() }, style = MaterialTheme.typography.bodyMedium)
                    if (state == "paused" && !task.optBoolean("resumable", true)) Text("This transfer cannot resume. Ask the sender for a new link.", style = MaterialTheme.typography.bodySmall)
                    if (state in listOf("retrying", "paused") && task.optString("error").isNotEmpty()) Text(task.optString("error"), style = MaterialTheme.typography.bodySmall)
                    Row {
                        if (state in listOf("paused", "retrying") && task.optBoolean("resumable", true)) TextButton(onClick = { store.state(task.getString("id"), "queued"); enable(); revision++ }) { Text("Resume") }
                        if (state in listOf("queued", "receiving", "retrying")) TextButton(onClick = { taskAction(task.getString("id"), cancel = false); revision++ }) { Text("Pause") }
                        if (state == "paused") TextButton(onClick = { taskAction(task.getString("id"), cancel = true); revision++ }) { Text("Cancel and discard") }
                        if (state == "complete") TextButton(onClick = { runCatching { startActivity(Intent(Intent.ACTION_VIEW).setDataAndType(android.net.Uri.parse(task.getString("publishedUri")), "*/*").addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)) }.onFailure { error = "Open the file in Downloads/CD" } }) { Text("Open") }
                    }
                }
            }
        }
        downloadLink?.let { raw ->
            val request = remember(raw) { runCatching { DownloadRequest.parse(raw) } }
            fun dismissDownload() {
                downloadLink = null
                input = ""
                if (returnToCaller) moveTaskToBack(true)
            }
            AlertDialog(
                onDismissRequest = { dismissDownload() },
                title = { Text("Accept download?") },
                text = { Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    Text("Accept to save this transfer to Downloads/CD in the background. You can leave CD or turn off the screen. The sender must stay online.")
                    Text(if (store.allowedMobile()) "Mobile data is allowed." else "Downloads wait for unmetered Wi-Fi or Ethernet.")
                    if (request.isFailure) Text(request.exceptionOrNull()?.message ?: "Invalid download link", color = MaterialTheme.colorScheme.error)
                    if (downloadError.isNotBlank()) Text(downloadError, color = MaterialTheme.colorScheme.error)
                } },
                confirmButton = { TextButton(enabled = request.isSuccess, onClick = {
                    runCatching {
                        val download = request.getOrThrow()
                        store.putTask(download.queuedTask(download.invitation?.id?.let(store::task)))
                        enable(background = returnToCaller)
                        downloadLink = null
                        input = ""
                        revision++
                    }.onFailure { downloadError = it.message ?: "Could not start the download" }
                }) { Text("Accept") } },
                dismissButton = { TextButton(onClick = { dismissDownload() }) { Text("Reject") } },
            )
        }
        pending?.let { pair -> AlertDialog(onDismissRequest = { pending = null }, title = { Text("Trust ${pair.name}?") }, text = { Text("This laptop will be able to send files directly to Downloads/CD while receiving is enabled. Confirm that you scanned the QR shown by your own laptop. You can revoke access here at any time.") }, confirmButton = { TextButton(onClick = { runCatching { require(pair.json.getLong("expiresAt") > System.currentTimeMillis()); store.trust(pair); enable(); pending = null; input = ""; revision++ }.onFailure { error = "Pairing expired. Run cdx pair again."; pending = null } }) { Text("Trust device") } }, dismissButton = { TextButton(onClick = { pending = null }) { Text("Cancel") } }) }
    }
}

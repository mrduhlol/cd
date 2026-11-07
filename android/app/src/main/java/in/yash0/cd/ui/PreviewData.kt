package `in`.yash0.cd.ui

import android.os.Handler
import android.os.Looper
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.tooling.preview.Preview
import `in`.yash0.cd.Direction
import `in`.yash0.cd.Pairing
import `in`.yash0.cd.Route
import `in`.yash0.cd.TransferBus
import `in`.yash0.cd.TransferPhase
import `in`.yash0.cd.TransferView
import org.json.JSONObject
import kotlin.random.Random

/**
 * DEBUG-ONLY fake data. MainActivity calls [DebugFakes] only when the app is debuggable, so release
 * builds never publish these. Trigger with:
 *   adb shell am start -n in.yash0.cd/.MainActivity --es cd.debug <scenario> [--es cd.debug.screen <screen>] [--ez cd.debug.pairing true]
 * scenarios: all | send-waiting | send-private | sending | receiving | complete | paused | failed | clear
 * screens: send | receive | transfers | devices | settings | transfer (opens the scenario's transfer)
 * Long-pressing the "cd" wordmark in a debug build injects "all".
 */
object PreviewData {
    private const val MB = 1024L * 1024
    fun link(id: String) = "https://cd.yash0.in/s/$id#v2.k3J9xQ2mVd0pL8wR4tYbN6cZs1fH7gAeU5iOq3MnBvX"
    fun view(kind: String, now: Long = System.currentTimeMillis()): TransferView = when (kind) {
        "send-waiting" -> TransferView("fake-send-wait", Direction.SEND, "Holiday-2026-raw.mov", 1843 * MB, 0, 0, TransferPhase.WAITING, link = "https://cd.yash0.in/#48213", privateLink = link("Qm3xT8vLp2RkZ9wYc4NbAa"), code = "48213", isPrivate = false, message = "Waiting for the receiver", updatedAt = now)
        "sending" -> TransferView("fake-send", Direction.SEND, "design-assets.zip", 742 * MB, 311 * MB, 86 * MB, TransferPhase.TRANSFERRING, Route.LAN, link = "https://cd.yash0.in/#90514", privateLink = link("Hk2pQ7vNc4RtW8yZb1MsDf"), code = "90514", isPrivate = false, updatedAt = now - 1)
        "send-private" -> TransferView("fake-send-private", Direction.SEND, "tax-return-2026.pdf", 3 * MB, 0, 0, TransferPhase.WAITING, link = link("Pv8rT2wLq5NcZ7xYb3MkAa"), privateLink = link("Pv8rT2wLq5NcZ7xYb3MkAa"), message = "Waiting for the receiver", updatedAt = now)
        "receiving" -> TransferView("fake-recv", Direction.RECEIVE, "dataset-2026-10.parquet", 2560 * MB, 1210 * MB, 41 * MB, TransferPhase.TRANSFERRING, Route.RELAY, updatedAt = now - 2)
        "complete" -> TransferView("fake-done", Direction.RECEIVE, "Quarterly report final v3.pdf", 18 * MB + 400_000, 18 * MB + 400_000, 0, TransferPhase.COMPLETE, Route.DIRECT, openUri = "content://media/external/downloads/1", updatedAt = now - 7 * 60_000)
        "paused" -> TransferView("fake-paused", Direction.RECEIVE, "ubuntu-26.04-desktop-amd64.iso", 6144 * MB, 2290 * MB, 0, TransferPhase.PAUSED, Route.RELAY, message = "Paused. Saved progress is kept.", updatedAt = now - 40 * 60_000)
        "failed" -> TransferView("fake-failed", Direction.SEND, "screen-recording.mp4", 420 * MB, 96 * MB, 0, TransferPhase.FAILED, Route.RELAY, link = link("Zx9cV7bN5mL3kJ1hG8fDsa"), message = "The receiver went away. Resume continues from its checkpoint.", updatedAt = now - 3 * 3600_000)
        else -> error("unknown scenario $kind")
    }
    val scenarios = listOf("send-waiting", "send-private", "sending", "receiving", "complete", "paused", "failed")
    fun all(now: Long = System.currentTimeMillis()) = scenarios.map { view(it, now) }

    fun pairs(): List<Pairing> = listOf(
        fakePair("yash-thinkpad", "pY3kQ9mVt2LwR8cZ1nB4xA"),
        fakePair("studio-mac-mini", "aB7cD9eF1gH3iJ5kL7mN9o"),
    )
    fun fakePair(name: String, id: String) = Pairing(JSONObject().put("pairId", id).put("name", name).put("expiresAt", System.currentTimeMillis() + 300_000).put("debugFake", true))
}

object DebugFakes {
    private val handler = Handler(Looper.getMainLooper())
    var pairs: List<Pairing> = emptyList()
        private set
    private var ticking = false

    fun apply(scenario: String) {
        when (scenario) {
            "clear" -> { PreviewData.scenarios.forEach { TransferBus.remove(PreviewData.view(it).id) }; pairs = emptyList(); return }
            "all" -> PreviewData.all().forEach { TransferBus.publish(it) }
            else -> TransferBus.publish(PreviewData.view(scenario))
        }
        pairs = PreviewData.pairs()
        if (!ticking) { ticking = true; handler.post(tick) }
    }

    fun revoke(id: String) { pairs = pairs.filterNot { it.id == id } }

    /** Moves fake TRANSFERRING views forward with a jittery speed so the gauge and bar animate like the real thing. */
    private val tick = object: Runnable {
        override fun run() {
            val live = TransferBus.transfers.value.filter { it.id.startsWith("fake-") && it.phase == TransferPhase.TRANSFERRING }
            live.forEach { v ->
                val base = if (v.direction == Direction.SEND) 86.0 else 41.0
                val speed = (base * (0.82 + Random.nextDouble() * 0.36) * 1024 * 1024).toLong()
                val done = v.done + speed / 4
                // Loop back instead of completing so screenshots always find a live transfer.
                TransferBus.publish(v.copy(done = if (done >= v.size) v.size / 10 else done, bytesPerSecond = speed, updatedAt = v.updatedAt))
            }
            if (live.isEmpty()) ticking = false else handler.postDelayed(this, 250)
        }
    }
}

@Preview(widthDp = 412, heightDp = 915)
@Composable
private fun TransferPreview() = CdTheme {
    Box(Modifier.fillMaxSize().background(Cd.bg)) { TransferScreen("fake-send-private", Direction.SEND, PreviewData.all(), PreviewActions, PreviewData.pairs(), emptyMap()) {} }
}

@Preview(widthDp = 412, heightDp = 915)
@Composable
private fun HomePreview() = CdTheme { CdApp(UiState(), PreviewData.all(), "Ready to receive", PreviewActions, debug = true, version = "preview") }

private object PreviewActions: CdActions {
    override fun pickFiles(to: Pairing?) {}
    override fun setSendPrivate(on: Boolean) {}
    override fun sendToDevice(view: TransferView, pair: Pairing) {}
    override fun scan() {}
    override fun submit(raw: String) {}
    override fun setPaused(paused: Boolean) {}
    override fun trust(pair: Pairing) {}
    override fun revoke(pair: Pairing) {}
    override fun setMobile(on: Boolean) {}
    override fun setPush(on: Boolean) {}
    override fun pause(view: TransferView) {}
    override fun resume(view: TransferView) {}
    override fun cancel(view: TransferView) {}
    override fun open(view: TransferView) {}
    override fun dismiss(view: TransferView) {}
    override fun copy(label: String, text: String) {}
    override fun share(text: String) {}
    override fun paste(): String? = null
    override fun batterySettings() {}
}

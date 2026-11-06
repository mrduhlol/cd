package `in`.yash0.cd

import android.content.Context
import android.os.SystemClock
import android.util.AtomicFile
import org.json.JSONObject
import java.io.File

/** Call load(context) from Activity.onCreate to show retained receive tasks before the service starts. */
object ReceiveViews {
    private val meters = HashMap<String, ReceiveRate>()
    fun load(context: Context) {
        val store = StoreRegistry.get(context)
        store.tasks().forEach { task ->
            if (task.optString("state") != "complete") runCatching {
                val invitation = Invitation.parse(task.getString("url"))
                val cp = JSONObject(String(AtomicFile(File(context.filesDir, "resume-${invitation.id}.json")).readFully()))
                require(java.security.MessageDigest.isEqual(cp.getString("mac").toByteArray(), checkpointMac(cp, invitation).toByteArray()))
                task.put("received", cp.getLong("offset"))
                store.progress(task.getString("id"), cp.getLong("offset"))
            }
            publish(task, force = true)
        }
    }
    @Synchronized fun publish(task: JSONObject, force: Boolean = false) {
        val id = task.getString("id")
        val phase = phase(task.optString("state"))
        val now = SystemClock.elapsedRealtime()
        val meter = meters.getOrPut(id) { ReceiveRate() }
        val done = task.optLong("received", 0)
        val speed = meter.update(done, now, phase == TransferPhase.TRANSFERRING)
        if (!force && meter.published && now - meter.lastPublished < 250 && phase == meter.lastPhase) return
        meter.published = true; meter.lastPublished = now; meter.lastPhase = phase
        TransferBus.publish(TransferView(
            id = id, direction = Direction.RECEIVE, name = task.optString("filename", "Incoming file"),
            size = task.optLong("size", -1), done = done, bytesPerSecond = speed, phase = phase,
            route = when (task.optString("route")) { "local" -> Route.LAN; "direct" -> Route.DIRECT; "relay" -> Route.RELAY; else -> Route.NONE },
            message = task.optString("error").takeIf { it.isNotEmpty() },
            openUri = task.optString("publishedUri").takeIf { phase == TransferPhase.COMPLETE && it.isNotEmpty() }
        ))
    }
    fun phase(state: String): TransferPhase = when (state) {
        "queued" -> TransferPhase.WAITING
        "connecting" -> TransferPhase.CONNECTING
        "receiving" -> TransferPhase.TRANSFERRING
        "verifying" -> TransferPhase.VERIFYING
        "paused" -> TransferPhase.PAUSED
        "retrying" -> TransferPhase.RETRYING
        "complete" -> TransferPhase.COMPLETE
        "cancelled" -> TransferPhase.CANCELLED
        else -> TransferPhase.FAILED
    }
}

/** Samples only at UI cadence, rather than reacting to individual chunks or fsync bursts. */
class ReceiveRate {
    var published = false
    var lastPublished = 0L
    var lastPhase: TransferPhase? = null
    private var sampled = false
    private var previousBytes = 0L
    private var previousAt = 0L
    private var speed = 0.0
    fun update(bytes: Long, now: Long, active: Boolean): Long {
        if (!active || !sampled || bytes < previousBytes) {
            sampled = active; previousBytes = bytes; previousAt = now; speed = 0.0
            return 0
        }
        val elapsed = now - previousAt
        if (elapsed >= 250) {
            val instant = (bytes - previousBytes).coerceAtLeast(0) * 1000.0 / elapsed
            val weight = 1.0 - kotlin.math.exp(-elapsed / 1000.0)
            speed = if (speed == 0.0) instant else speed + weight * (instant - speed)
            previousBytes = bytes; previousAt = now
        }
        return speed.toLong()
    }
}

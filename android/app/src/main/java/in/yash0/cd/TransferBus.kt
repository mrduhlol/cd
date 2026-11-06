package `in`.yash0.cd

import android.content.Context
import android.net.Uri
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/*
 * UI <-> transport contract. The UI (MainActivity and ui/) reads only these flows and calls only
 * these functions. Transport code (ReceiverService, ResumeReceiver, Sender*) publishes into them.
 * Keep field names stable: frontend and backend are developed in parallel against this file.
 */

enum class Direction { SEND, RECEIVE }

enum class TransferPhase {
    PREPARING,   // hashing / opening source, creating invitation
    WAITING,     // send: link/code shown, waiting for a receiver. receive: queued
    CONNECTING,
    TRANSFERRING,
    VERIFYING,   // final SHA-256 check / publishing
    PAUSED,      // resumable; checkpoint retained
    RETRYING,
    COMPLETE,
    FAILED,
    CANCELLED,
}

enum class Route { NONE, RELAY, LAN, DIRECT }

data class TransferView(
    val id: String,
    val direction: Direction,
    val name: String,
    val size: Long,             // -1 when unknown
    val done: Long,             // bytes durably sent/received
    val bytesPerSecond: Long,   // smoothed, 0 when idle
    val phase: TransferPhase,
    val route: Route = Route.NONE,
    // Default sharing uses a five-digit code URL; private sends use a full capability URL.
    val link: String? = null,
    val code: String? = null,
    val message: String? = null,// human-readable status / error; never contains keys or raw URLs
    val openUri: String? = null,// receive: published MediaStore uri when COMPLETE
    val updatedAt: Long = System.currentTimeMillis(),
    val privateLink: String? = null,
    val isPrivate: Boolean = true,
    val codeExpiresAt: Long = 0,
    val codeSpent: Boolean = false,
    val expiresAt: Long = 0,    // send: unix ms when the invitation expires; 0 when unknown
)

object TransferBus {
    private val _transfers = MutableStateFlow<List<TransferView>>(emptyList())
    /** Newest first. A transfer is identified by (direction, id): the same root can be sent and received. */
    val transfers: StateFlow<List<TransferView>> = _transfers.asStateFlow()

    private val _receiving = MutableStateFlow("Receiving is off")
    /** One-line receiver status shown under the receive toggle. */
    val receivingStatus: StateFlow<String> = _receiving.asStateFlow()

    fun status(text: String) { _receiving.value = text }

    @Synchronized fun publish(view: TransferView) {
        val newest = (listOf(view) + _transfers.value.filterNot { it.id == view.id && it.direction == view.direction }).sortedByDescending { it.updatedAt }
        // Hydrating old receives on Activity recreation must never evict a live or resumable send.
        // Bound finished history only; unfinished transfers still need their controls and invitation.
        var finished = 0
        _transfers.value = newest.filter {
            when (it.phase) {
                TransferPhase.COMPLETE, TransferPhase.CANCELLED, TransferPhase.FAILED -> finished++ < 50
                else -> true
            }
        }
    }

    @Synchronized fun remove(id: String, direction: Direction) { _transfers.value = _transfers.value.filterNot { it.id == id && it.direction == direction } }

    @Synchronized fun remove(id: String) { _transfers.value = _transfers.value.filterNot { it.id == id } }

    fun find(id: String, direction: Direction): TransferView? = transfers.value.firstOrNull { it.id == id && it.direction == direction }

    /** Pluggable send engine; the transport layer installs a real implementation. */
    @Volatile var sender: SendEngine = SendEngine.Unavailable
}

interface SendEngine {
    /** Starts a foreground (in-app) resumable send. Returns the transfer id. */
    fun start(context: Context, uris: List<Uri>, privateLink: Boolean = false): String
    fun pause(context: Context, id: String)
    fun resume(context: Context, id: String)
    fun cancel(context: Context, id: String)
    /** True when [id] is a send this device owns that is not cancelled/complete; the UI must not receive it. */
    fun owns(id: String): Boolean = false

    object Unavailable: SendEngine {
        override fun start(context: Context, uris: List<Uri>, privateLink: Boolean): String = error("Sending is not available in this build")
        override fun pause(context: Context, id: String) {}
        override fun resume(context: Context, id: String) {}
        override fun cancel(context: Context, id: String) {}
    }
}

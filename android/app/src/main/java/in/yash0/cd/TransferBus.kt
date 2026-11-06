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
    val link: String? = null,   // send: private resumable link (https://.../s/...#v2...)
    val code: String? = null,   // send: short share code, when available
    val message: String? = null,// human-readable status / error
    val openUri: String? = null,// receive: published MediaStore uri when COMPLETE
    val updatedAt: Long = System.currentTimeMillis(),
)

object TransferBus {
    private val _transfers = MutableStateFlow<List<TransferView>>(emptyList())
    /** Newest first. */
    val transfers: StateFlow<List<TransferView>> = _transfers.asStateFlow()

    private val _receiving = MutableStateFlow("Receiving is off")
    /** One-line receiver status shown under the receive toggle. */
    val receivingStatus: StateFlow<String> = _receiving.asStateFlow()

    fun status(text: String) { _receiving.value = text }

    @Synchronized fun publish(view: TransferView) {
        _transfers.value = (listOf(view) + _transfers.value.filterNot { it.id == view.id }).sortedByDescending { it.updatedAt }.take(50)
    }

    @Synchronized fun remove(id: String) { _transfers.value = _transfers.value.filterNot { it.id == id } }

    /** Pluggable send engine; the transport layer installs a real implementation. */
    @Volatile var sender: SendEngine = SendEngine.Unavailable
}

interface SendEngine {
    /** Starts a foreground (in-app) resumable send. Returns the transfer id. */
    fun start(context: Context, uris: List<Uri>): String
    fun pause(context: Context, id: String)
    fun resume(context: Context, id: String)
    fun cancel(context: Context, id: String)

    object Unavailable: SendEngine {
        override fun start(context: Context, uris: List<Uri>): String = error("Sending is not available in this build")
        override fun pause(context: Context, id: String) {}
        override fun resume(context: Context, id: String) {}
        override fun cancel(context: Context, id: String) {}
    }
}

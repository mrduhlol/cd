package `in`.yash0.cd.ui

import android.content.Context
import androidx.compose.runtime.mutableStateMapOf
import `in`.yash0.cd.ControlHub
import `in`.yash0.cd.Direction
import `in`.yash0.cd.Pairing
import `in`.yash0.cd.TransferBus
import `in`.yash0.cd.TransferPhase
import `in`.yash0.cd.TrustedSend
import `in`.yash0.cd.TransferView
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull

/**
 * Offers of private sends to trusted computers. Process-owned, so a rotation or Activity recreation
 * between "pick files" and "link ready" never drops the offer, and keyed by (send, computer) so a
 * recreated screen or a second tap never sends the same offer twice. Main thread only.
 */
object TrustedOffers {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    /** (send id, pair id) offers waiting for the link or in flight. */
    private val busy = mutableSetOf<String>()
    /**
     * Send id -> pair ids that accepted delivery of the offer for the current WAITING session. Keyed by
     * pair id (names can repeat). Cleared when the send pauses or ends, so after Resume the user can offer again.
     */
    val offered = mutableStateMapOf<String, Set<String>>()
    private val _messages = MutableSharedFlow<Pair<String, Boolean>>(extraBufferCapacity = 8)
    /** (text, isError) toasts for whichever Activity is alive. */
    val messages: SharedFlow<Pair<String, Boolean>> = _messages.asSharedFlow()

    private fun key(id: String, pair: Pairing) = "$id\n${pair.id}"
    private fun delivered(id: String, pair: Pairing) = pair.id in offered[id].orEmpty()

    init {
        scope.launch {
            TransferBus.transfers.collect { list ->
                for (id in offered.keys.toList()) {
                    val view = list.findTransfer(id, Direction.SEND)
                    if (view == null || view.finished || view.phase == TransferPhase.PAUSED) offered.remove(id)
                }
            }
        }
    }

    /** After start(privateLink = true): waits up to a minute for the relay to accept the root, then offers once. */
    fun whenReady(context: Context, id: String, pair: Pairing) {
        val app = context.applicationContext
        val key = key(id, pair)
        if (delivered(id, pair) || !busy.add(key)) return
        // Holds the receiver's control links while the picker backgrounds CD and the link is pending.
        val hold = ControlHub.hold()
        scope.launch {
            try {
                val view = withTimeoutOrNull(60_000) {
                    TransferBus.transfers.map { it.findTransfer(id, Direction.SEND) }
                        // The send may not be published yet right after start(); wait for it rather than give up.
                        .first { it != null && (it.finished || it.phase == TransferPhase.PAUSED || privateOffer(it) != null) }
                }
                when {
                    view != null && privateOffer(view) != null -> deliver(app, view, pair)
                    view?.finished == true -> {}
                    else -> _messages.tryEmit("Couldn’t reach CD’s server to send to ${pair.name}. Resume the send, then tap ${pair.name} on its screen." to true)
                }
            } finally { hold.close(); busy.remove(key) }
        }
    }

    /** One tap on the transfer screen. Ignored while the same offer is pending or once it was delivered. */
    fun offerNow(context: Context, view: TransferView, pair: Pairing) {
        val app = context.applicationContext
        val key = key(view.id, pair)
        if (delivered(view.id, pair)) { _messages.tryEmit("Already offered to ${pair.name}" to false); return }
        if (privateOffer(view) == null) { _messages.tryEmit("Only a private send that’s ready can go to a computer. Resume it first." to true); return }
        if (!busy.add(key)) return
        scope.launch { try { deliver(app, view, pair) } finally { busy.remove(key) } }
    }

    private suspend fun deliver(context: Context, view: TransferView, pair: Pairing) {
        val link = privateOffer(view) ?: return
        val result = if (pair.json.optBoolean("debugFake")) Result.success(Unit)
            else runCatching { withContext(Dispatchers.IO) { TrustedSend.offer(context, pair, link, view.name, view.size) } }
        result
            .onSuccess {
                // Don't mark a send that paused or ended while the offer was in flight; Resume must allow a new offer.
                val now = TransferBus.find(view.id, Direction.SEND)
                if (now != null && !now.finished && now.phase != TransferPhase.PAUSED) offered[view.id] = offered[view.id].orEmpty() + pair.id
                _messages.tryEmit("Offered to ${pair.name}" to false)
            }
            .onFailure { _messages.tryEmit((it.message ?: "Couldn’t reach ${pair.name}") to true) }
    }
}

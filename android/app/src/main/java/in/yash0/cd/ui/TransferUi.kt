package `in`.yash0.cd.ui

import `in`.yash0.cd.Direction
import `in`.yash0.cd.TransferPhase
import `in`.yash0.cd.TransferView
import java.net.URLDecoder
import java.net.URLEncoder

/*
 * Pure presentation logic for the transfer screen and rows. No Compose here so it is JVM unit tested.
 */

/** What the send invitation (QR + private link) area may show. */
sealed interface ShareState {
    /** No invitation to show: receive, finished, expired, or a receiver is already connected. */
    data object Hidden: ShareState
    /** Send started but the relay has not accepted the root yet: no link exists to show. */
    data object Preparing: ShareState
    /** WAITING on the current socket: the only state that may claim readiness. */
    data class Ready(val link: String): ShareState
    /** The invitation is still valid but this phone is not connected to the relay. Keep the QR, don't claim readiness. */
    data class Offline(val link: String, val paused: Boolean, val message: String?): ShareState
}

val ShareState.link: String? get() = when (this) { is ShareState.Ready -> link; is ShareState.Offline -> link; else -> null }

private fun TransferView.expired(now: Long) = expiresAt in 1..now

/**
 * What the QR and Share button carry. A private send shares its private link. A code send shares
 * only its short code URL while the code is live, never the long transfer URL behind it: after the
 * code expires or a receiver has used it there is nothing to share.
 */
private fun TransferView.invitation(now: Long): String? =
    if (isPrivate) link ?: privateLink else link?.takeIf { !codeSpent && codeLive(now) }

/** Code expiry is separate from the 24h transfer expiry; fixtures without one fall back to [TransferView.expiresAt]. */
private fun TransferView.codeDeadline(): Long = if (codeExpiresAt > 0) codeExpiresAt else expiresAt
private fun TransferView.codeLive(now: Long): Boolean = code != null && codeDeadline().let { it <= 0 || now < it }

/** The next moment the screen must re-evaluate (code or transfer expiry), or 0 when nothing is pending. */
fun nextDeadline(view: TransferView, now: Long = System.currentTimeMillis()): Long =
    listOf(view.codeExpiresAt, view.expiresAt).filter { it > now }.minOrNull() ?: 0

/**
 * The end-to-end private link of a private-mode send that a trusted computer can join right now.
 * Requires the explicit private flag (never inferred from a missing code) and WAITING on the relay:
 * a paused or reconnecting send cannot admit the computer until it is resumed.
 */
fun privateOffer(view: TransferView, now: Long = System.currentTimeMillis()): String? =
    (view.privateLink ?: view.link)?.takeIf { view.isPrivate && view.code == null && view.done == 0L && shareState(view, now) is ShareState.Ready }

fun shareState(view: TransferView, now: Long = System.currentTimeMillis()): ShareState {
    if (view.direction != Direction.SEND || view.finished || view.expired(now)) return ShareState.Hidden
    // A used code is never shown again: only the receiver that used it can continue, so this is progress.
    if (!view.isPrivate && view.codeSpent) return ShareState.Hidden
    val link = view.invitation(now)
    return when (view.phase) {
        TransferPhase.WAITING -> if (link != null) ShareState.Ready(link) else ShareState.Preparing
        TransferPhase.PREPARING, TransferPhase.CONNECTING, TransferPhase.RETRYING ->
            if (link != null) ShareState.Offline(link, paused = false, message = view.message) else ShareState.Preparing
        TransferPhase.PAUSED -> if (link != null) ShareState.Offline(link, paused = true, message = view.message) else ShareState.Hidden
        else -> ShareState.Hidden // TRANSFERRING / VERIFYING: the receiver is connected, progress is what matters
    }
}

/** The private link if it may still be shared or copied (not expired, not finished). */
fun liveLink(view: TransferView, now: Long = System.currentTimeMillis()): String? =
    view.invitation(now)?.takeIf { view.direction == Direction.SEND && !view.finished && !view.expired(now) }

private val shareCodePattern = Regex("[0-9]{5}")

/**
 * The 5-digit share code while it can still admit a receiver: until its own (15 min) expiry, and gone
 * once bytes moved (a code admits one receiver). Its expiry never ends the transfer itself: the
 * backend pauses and Resume asks for a code again. While unspent and inside its TTL the relay keeps the
 * same code across disconnects. Null for private-link sends and once a receiver has used it.
 */
fun liveCode(view: TransferView, now: Long = System.currentTimeMillis()): String? =
    view.code?.takeIf { !view.isPrivate && shareCodePattern.matches(it) && view.done == 0L && view.codeLive(now) && shareState(view, now) != ShareState.Hidden }

/** Text for the share sheet: the code first when there is one, so it reads well in a chat message. */
fun shareText(link: String, code: String?): String = if (code != null) "CD code $code — open $link or run: cdx receive $code" else link

/** Terminal command for the receiver. The code is preferred: it is short enough to type. */
fun receiveCommand(link: String, code: String?): String = "cdx receive ${code ?: link}"

/** Truthful privacy line for the current invitation. Only an explicitly private send is called end-to-end encrypted. */
fun privacyNote(private: Boolean, code: String?): String = when {
    private -> "Private link: end-to-end encrypted, the key never reaches CD’s server. Anyone with the link can receive the file."
    code != null -> "Anyone with this code can receive the file until someone does. CD’s server holds the key for codes — turn on Private link for sensitive files."
    else -> "Anyone with this link can receive the file. It came from a share code, so CD’s server holds the key — it isn’t end-to-end private."
}

/** Copy/label noun for the transfer URL. */
fun linkLabel(private: Boolean): String = if (private) "Private link" else "Transfer link"

/** Line under a dimmed QR. Never claims the receiver can connect right now. */
fun offlineLabel(share: ShareState.Offline, code: Boolean = false): String =
    if (share.paused) "Not connected — resume to accept the receiver" else "Reconnecting — the ${if (code) "code" else "link"} stays the same"

private val codeUrlPattern = Regex("https://[A-Za-z0-9.-]+(:[0-9]{1,5})?/?#[0-9]{5}")

/**
 * Typed text complete enough to submit without a tap: a 5-digit code or a code URL. Typed links and
 * pairing credentials wait for Receive/Go, so a half-typed link never shows an error; pasting or
 * scanning is an explicit action and submits directly.
 */
fun autoSubmittable(typed: String): Boolean {
    val text = typed.trim()
    return shareCodePattern.matches(text) || codeUrlPattern.matches(text)
}

/**
 * A code send whose unused code ran out (or that paused without one): nothing can be shared and the
 * only way on is Resume, which asks the relay for a code. Never shown as "Getting a code…", and never
 * for a spent code: that send waits for the same receiver instead.
 */
fun codeExpired(view: TransferView, now: Long = System.currentTimeMillis()): Boolean =
    view.direction == Direction.SEND && !view.isPrivate && !view.codeSpent && !view.finished && !view.expired(now) && view.done == 0L &&
        !view.codeLive(now) && (view.code != null || view.phase == TransferPhase.PAUSED)

enum class TransferBody { RESULT, SHARE, PREPARING, PROGRESS, CODE_EXPIRED }

/**
 * Main area of the transfer screen. Before any byte moved, a send keeps the invitation on screen
 * through WAITING / PAUSED / CONNECTING / RETRYING so network flaps never swap the QR for a gauge.
 * Once bytes moved, progress is primary and the link is a compact row.
 */
fun transferBody(view: TransferView, now: Long = System.currentTimeMillis()): TransferBody {
    if (view.finished) return TransferBody.RESULT
    if (view.done != 0L) return TransferBody.PROGRESS
    if (codeExpired(view, now)) return TransferBody.CODE_EXPIRED
    return when (shareState(view, now)) {
        is ShareState.Ready, is ShareState.Offline -> TransferBody.SHARE
        ShareState.Preparing -> TransferBody.PREPARING
        ShareState.Hidden -> TransferBody.PROGRESS
    }
}

fun transferTitle(view: TransferView, now: Long = System.currentTimeMillis()): String {
    val send = view.direction == Direction.SEND
    if (codeExpired(view, now)) return if (view.code != null) "Code expired" else "No live code"
    if (send && !view.isPrivate && view.codeSpent && view.phase == TransferPhase.WAITING) return "Waiting for receiver"
    return when (view.phase) {
        TransferPhase.COMPLETE -> if (send) "Sent" else "Saved"
        TransferPhase.FAILED -> "Transfer stopped"
        TransferPhase.CANCELLED -> "Cancelled"
        TransferPhase.PAUSED -> "Paused"
        else -> when (if (transferBody(view, now) == TransferBody.SHARE) shareState(view, now) else null) {
            is ShareState.Ready -> "Ready to send"
            is ShareState.Offline -> "Reconnecting"
            else -> if (send) "Sending" else "Receiving"
        }
    }
}

/** Transfer lookup: the same root id can exist once as SEND and once as RECEIVE. */
fun List<TransferView>.findTransfer(id: String, direction: Direction): TransferView? = firstOrNull { it.id == id && it.direction == direction }

/**
 * Bundle codec for the navigation state, so the current tab and screen stack survive configuration
 * changes and process recreation. Plain text, so it is unit tested without Android. Transfer ids are
 * not secrets (the relay sees them); private links are never stored here.
 */
object NavCodec {
    data class Nav(val tab: Tab, val stack: List<Screen>)

    val Default = Nav(Tab.SEND, listOf(Screen.Home))
    private const val VERSION = "nav1"
    private const val MAX_DEPTH = 16
    private val transferId = Regex("[A-Za-z0-9_-]{1,128}")

    fun encode(tab: Tab, stack: List<Screen>): String {
        if (stack.any { it is Screen.Transfer && !transferId.matches(it.id) }) return encode(Default.tab, Default.stack)
        return (listOf(VERSION, tab.name) + stack.map(::token)).joinToString("\n")
    }

    /** Any unknown or malformed value restores home on the Send tab rather than a half-valid stack. */
    fun decode(raw: String?): Nav {
        val parts = raw?.split("\n") ?: return Default
        if (parts.size < 3 || parts[0] != VERSION || parts.size - 2 > MAX_DEPTH) return Default
        val tab = Tab.entries.firstOrNull { it.name == parts[1] } ?: return Default
        val stack = parts.drop(2).map { screen(it) ?: return Default }
        if (stack.first() != Screen.Home || stack.drop(1).any { it == Screen.Home }) return Default
        return Nav(tab, stack)
    }

    private fun token(screen: Screen): String = when (screen) {
        Screen.Home -> "home"
        Screen.Settings -> "settings"
        is Screen.Transfer -> "transfer:${screen.direction.name}:${URLEncoder.encode(screen.id, "UTF-8")}"
    }

    private fun screen(token: String): Screen? = when {
        token == "home" -> Screen.Home
        token == "settings" -> Screen.Settings
        token.startsWith("transfer:") -> {
            val rest = token.removePrefix("transfer:").split(":", limit = 2)
            val direction = Direction.entries.firstOrNull { it.name == rest.getOrNull(0) }
            val id = rest.getOrNull(1)?.let { runCatching { URLDecoder.decode(it, "UTF-8") }.getOrNull() }
            if (direction == null || id == null || !transferId.matches(id)) null else Screen.Transfer(id, direction)
        }
        else -> null
    }
}

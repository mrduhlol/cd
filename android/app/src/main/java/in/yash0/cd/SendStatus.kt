package `in`.yash0.cd

import java.io.IOException
import java.io.InterruptedIOException
import java.net.ConnectException
import java.net.NoRouteToHostException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import java.security.cert.CertificateException
import java.util.Collections
import java.util.IdentityHashMap
import javax.net.ssl.SSLHandshakeException
import javax.net.ssl.SSLPeerUnverifiedException

/**
 * Why a send stopped. [terminal] failures become FAILED (link dropped, retained copy removed);
 * the rest pause and wait for an explicit Resume (ADR 0001: no endless automatic reconnect).
 * Messages are fixed text: they never contain keys, tokens, URLs or exception text.
 */
enum class SendFailureKind(val terminal: Boolean, val message: String) {
    OFFLINE(false, "No internet connection. Connect to a network, then tap Resume."),
    UNREACHABLE(false, "Couldn't reach the CD server. Check your connection, then tap Resume."),
    TIMEOUT(false, "The connection timed out. Check your connection, then tap Resume."),
    TLS(false, "Couldn't open a secure connection to the CD server. This network may be blocking it. Try another network, then tap Resume."),
    UNSUPPORTED(false, "This CD server doesn't support private resumable transfers yet. Try again after the server is updated."),
    REJECTED(true, "The CD server rejected this transfer. Start a new send."),
    SENDER_BUSY(false, "The CD server still has an earlier connection from this phone. Wait a few seconds, then tap Resume."),
    EXPIRED(true, "This link expired. Start a new send."),
    FINISHED(true, "This transfer already finished or expired on the server. Start a new send if the file didn't arrive."),
    EXHAUSTED(true, "This transfer reached its reconnect limit. Start a new send."),
    RATE_LIMITED(false, "The CD server is busy. Wait a minute, then tap Resume."),
    SERVER(false, "The CD server had a problem. Tap Resume to try again."),
    INTERRUPTED(false, "The connection was interrupted. Tap Resume to continue from saved progress."),
    NO_RECEIVER(false, "No one connected for 15 minutes, so sending paused. Tap Resume for a new code or to keep your private link waiting."),
    CLOCK(false, "The code appears expired. Check that your phone’s date and time are automatic, then tap Resume."),
    CODE_UNAVAILABLE(false, "Share codes are temporarily unavailable. Tap Resume to try again, or start a new send with Private link."),
    RECEIVER_TIMEOUT(false, "The receiver stopped responding. Tap Resume to continue from saved progress."),
    RECEIVER_UNVERIFIED(false, "The receiver couldn't be verified for this file. Tap Resume to try again."),
    SOURCE_UNAVAILABLE(false, "Couldn't read the selected file. Check that it still exists, then tap Resume or choose it again."),
    SOURCE_CHANGED(true, "The saved copy of this file changed or is missing. Start a new send."),
    TOO_LARGE(true, "This file is too large to send."),
    STORAGE(false, "Not enough phone storage to prepare this send. Free up space, then tap Resume."),
    PROTOCOL(false, "Sending stopped after an unexpected response. Tap Resume to try again."),
}

/** A send-side condition the engine recognised itself. The message is the kind name only, never shown. */
class SendProblem(val kind: SendFailureKind, cause: Throwable? = null): IOException(kind.name, cause)

object SendFailures {
    /** Classifies by type and status/close code, walking the cause chain. A passed expiry always wins. */
    fun classify(error: Throwable, expiresAt: Long = 0, now: Long = System.currentTimeMillis()): SendFailureKind {
        if (expiresAt > 0 && now >= expiresAt) return SendFailureKind.EXPIRED
        val seen = Collections.newSetFromMap(IdentityHashMap<Throwable, Boolean>())
        var current: Throwable? = error
        while (current != null && seen.add(current)) {
            direct(current)?.let { return it }
            current = current.cause
        }
        return if (error is IOException) SendFailureKind.INTERRUPTED else SendFailureKind.PROTOCOL
    }

    private fun direct(e: Throwable): SendFailureKind? = when (e) {
        is SendProblem -> e.kind
        is ExpiredTransferException -> SendFailureKind.EXPIRED
        is ExhaustedTransferException -> SendFailureKind.EXHAUSTED
        is WireTimeout -> SendFailureKind.RECEIVER_TIMEOUT
        is WireFailure -> wire(e)
        is UnknownHostException, is NoRouteToHostException -> SendFailureKind.OFFLINE
        is ConnectException -> SendFailureKind.UNREACHABLE
        is SocketTimeoutException -> SendFailureKind.TIMEOUT
        // Only handshake/certificate problems are TLS problems; a generic SSLException mid-stream is a reset.
        is SSLHandshakeException, is SSLPeerUnverifiedException, is CertificateException -> SendFailureKind.TLS
        is InterruptedIOException -> SendFailureKind.TIMEOUT
        else -> null
    }

    private fun wire(e: WireFailure): SendFailureKind? {
        val code = e.status ?: return null
        return if (e.phase == "failed") http(code) else closed(code, e)
    }

    /** HTTP status of a refused WebSocket upgrade. */
    fun http(code: Int): SendFailureKind = when (code) {
        404 -> SendFailureKind.UNSUPPORTED
        401, 403 -> SendFailureKind.REJECTED
        410 -> SendFailureKind.FINISHED
        429 -> SendFailureKind.RATE_LIMITED
        else -> SendFailureKind.SERVER
    }

    /** WebSocket close codes used by worker/resume-room.ts. */
    private fun closed(code: Int, e: WireFailure): SendFailureKind = when {
        e.expired -> SendFailureKind.EXPIRED
        e.exhausted -> SendFailureKind.EXHAUSTED
        code == 4409 && e.reason == "transfer is terminal" -> SendFailureKind.FINISHED
        // The relay answers 4401 to a sender while it still holds this root's previous sender socket.
        // Our own token cannot be wrong, so this is retryable, not an authentication failure.
        code == 4401 -> SendFailureKind.SENDER_BUSY
        code == 4408 -> SendFailureKind.TIMEOUT
        code == 4403 || code == 4406 -> SendFailureKind.PROTOCOL
        code == 1011 || code == 1013 || code == 1014 -> SendFailureKind.SERVER
        else -> SendFailureKind.INTERRUPTED
    }
}

/** Pure send-state rules shared by the engine and its tests. */
object SendStatus {
    private val ended = setOf(TransferPhase.CANCELLED, TransferPhase.COMPLETE, TransferPhase.FAILED)

    /** expiresAt is only ever stored from a relay `accepted` event, so it also marks older saved states. */
    fun accepted(flag: Boolean, expiresAt: Long): Boolean = flag || expiresAt > 0

    /** The private link may be shown only after the relay accepted the root, and only until it ends or expires. */
    fun linkVisible(accepted: Boolean, phase: TransferPhase, expiresAt: Long, now: Long): Boolean =
        accepted && phase !in ended && expiresAt > now

    /** A send this device still holds; the UI must not receive it on the same device. */
    fun owns(phase: TransferPhase, expiresAt: Long, now: Long): Boolean =
        phase != TransferPhase.CANCELLED && phase != TransferPhase.COMPLETE && (expiresAt <= 0 || now < expiresAt)

    /** Saved sends come back paused unless they already ended. */
    fun restored(saved: String?): TransferPhase {
        val phase = TransferPhase.entries.firstOrNull { it.name == saved }
        return if (phase != null && phase in ended) phase else TransferPhase.PAUSED
    }

    /** Pause never overrides an ended send; cancel overrides everything except COMPLETE and CANCELLED. */
    fun canStop(current: TransferPhase?, requested: TransferPhase): Boolean = when (current) {
        TransferPhase.COMPLETE, TransferPhase.CANCELLED -> false
        TransferPhase.FAILED -> requested == TransferPhase.CANCELLED
        else -> true
    }
}

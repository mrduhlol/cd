package `in`.yash0.cd.ui

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.SizeTransform
import androidx.compose.animation.togetherWith
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.*
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.graphicsLayer
import kotlinx.coroutines.delay
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import `in`.yash0.cd.Direction
import `in`.yash0.cd.Pairing
import `in`.yash0.cd.Route
import `in`.yash0.cd.TransferPhase
import `in`.yash0.cd.TransferView
import `in`.yash0.cd.TrustedSend
import kotlin.math.cos
import kotlin.math.sin

fun TransferView.tone(): Tone = when (phase) {
    TransferPhase.COMPLETE -> Tone.SUCCESS
    TransferPhase.FAILED -> Tone.DANGER
    TransferPhase.PAUSED, TransferPhase.CANCELLED -> Tone.IDLE
    else -> Tone.ACCENT
}

@Composable
fun TransferScreen(id: String, direction: Direction, transfers: List<TransferView>, actions: CdActions, pairs: List<Pairing>, offered: Map<String, Set<String>>, onBack: () -> Unit) {
    val view = transfers.findTransfer(id, direction)
    if (view == null) {
        ScreenFrame("Transfer", largeTitle = false, navigation = { BackButton(onBack) }, pinned = { SecondaryButton("Back", onBack, Modifier.fillMaxWidth()) }) {
            EmptyBrand("This transfer is no longer listed", "Finished files are kept in Downloads/CD.")
        }
        return
    }
    // Re-evaluated at the code expiry and the invitation expiry, so the code and QR disappear even if the engine publishes nothing.
    val now by produceState(System.currentTimeMillis(), view.codeExpiresAt, view.expiresAt) {
        while (true) {
            value = System.currentTimeMillis()
            val next = nextDeadline(view, value).takeIf { it > 0 } ?: break
            delay(next - value + 50)
        }
    }
    val share = shareState(view, now)
    val body = transferBody(view, now)
    val link = liveLink(view, now)
    val code = liveCode(view, now)
    // Only a private-mode send may go to a trusted computer; a code send's key is held by the relay.
    val devices = if (privateOffer(view, now) != null) pairs else emptyList()
    // Copy/Share sit in the pinned area while the invitation is the main content and the sender can accept a receiver.
    val pinnedShare = body == TransferBody.SHARE && !(share is ShareState.Offline && share.paused)
    ScreenFrame(
        transferTitle(view, now), largeTitle = false,
        navigation = { BackButton(onBack) },
        actions = {
            if (link != null && !pinnedShare) IconAction(CdIcons.Share, if (code != null) "Share code" else "Share ${linkLabel(view.isPrivate).lowercase()}", { actions.share(shareText(link, code)) })
        },
        pinned = { Pinned(view, if (pinnedShare) link else null, code, actions, onBack) },
    ) {
        // Keyed by the body kind, never by the TransferView, so progress ticks don't restart the fade.
        AnimatedContent(
            body,
            transitionSpec = { (fadeIn(tween(220, 60)) togetherWith fadeOut(tween(120))).using(SizeTransform(clip = false)) },
            label = "transferBody",
        ) { kind ->
            when (kind) {
                TransferBody.RESULT -> Result(view)
                TransferBody.SHARE -> SharePanel(view, share, code, devices, offered[view.id].orEmpty(), actions)
                TransferBody.PREPARING -> Preparing(view)
                TransferBody.PROGRESS -> Progress(view, link, actions)
                TransferBody.CODE_EXPIRED -> CodeExpired(view)
            }
        }
    }
}

@Composable
private fun FileLine(view: TransferView, center: Boolean = false) {
    Column(Modifier.fillMaxWidth(), horizontalAlignment = if (center) Alignment.CenterHorizontally else Alignment.Start) {
        Text(view.name, style = CdType.title.copy(fontSize = 20.sp, lineHeight = 26.sp), maxLines = 2, overflow = TextOverflow.Ellipsis, textAlign = if (center) TextAlign.Center else TextAlign.Start)
        Spacer(Modifier.height(4.dp))
        Text(Format.size(view.size), style = CdType.monoSmall.copy(color = Cd.accent))
    }
}

/** A code send with no live, unused code: no URL to share, Resume asks the relay for a code. */
@Composable
private fun CodeExpired(view: TransferView) {
    Column(Modifier.fillMaxWidth().padding(top = 48.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        ResultMark(CdIcons.Pause, Tone.IDLE, size = 72.dp)
        Spacer(Modifier.height(24.dp))
        Text(if (view.code != null) "This code expired" else "No live code", style = CdType.title)
        Spacer(Modifier.height(8.dp))
        Text(
            if (view.phase == TransferPhase.PAUSED) "Unused codes last 15 minutes. Tap Get code to share this file again — nothing was sent yet."
            else "Unused codes last 15 minutes. Pausing the send…",
            style = CdType.bodyMuted, textAlign = TextAlign.Center,
        )
        Spacer(Modifier.height(40.dp))
        FileLine(view, center = true)
    }
}

@Composable
private fun Preparing(view: TransferView) {
    Column(Modifier.fillMaxWidth().padding(top = 48.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        Spinner(size = 40.dp)
        Spacer(Modifier.height(24.dp))
        Text(if (view.direction != Direction.SEND) "Finding the sender…" else if (view.isPrivate) "Creating private link…" else "Getting a code…", style = CdType.title)
        Spacer(Modifier.height(8.dp))
        Text(view.message ?: "This usually takes a second or two.", style = CdType.bodyMuted, textAlign = TextAlign.Center)
        Spacer(Modifier.height(40.dp))
        FileLine(view, center = true)
    }
}

/**
 * The invitation. Ready (WAITING) shows the QR at full strength; Offline keeps the same QR in place,
 * dimmed, with a distinct status so it never looks ready. The QR composable stays in the same slot
 * across Ready <-> Offline, so its matrix and draw cache are reused rather than regenerated.
 */
@Composable
private fun SharePanel(view: TransferView, share: ShareState, code: String?, devices: List<Pairing>, offeredTo: Set<String>, actions: CdActions) {
    val link = share.link ?: return
    val offline = share as? ShareState.Offline
    val qrAlpha by animateFloatAsState(if (offline != null) 0.28f else 1f, tween(240), label = "qrDim")
    Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally) {
        if (code != null) {
            // The code is the primary thing to share: big, tappable to copy, read digit by digit by screen readers.
            Text("Share code", style = CdType.section)
            Spacer(Modifier.height(4.dp))
            Text(
                code,
                Modifier.clip(RoundedCornerShape(12.dp)).clickable(role = Role.Button) { actions.copy("Code", code) }
                    .padding(horizontal = 16.dp, vertical = 4.dp).graphicsLayer { alpha = maxOf(qrAlpha, 0.5f) }
                    .semantics { contentDescription = "Share code ${code.toList().joinToString(" ")}. Tap to copy." },
                style = CdType.code.copy(fontSize = 56.sp, lineHeight = 64.sp),
            )
            Spacer(Modifier.height(12.dp))
        }
        BoxWithConstraints(Modifier.fillMaxWidth().padding(top = 8.dp), contentAlignment = Alignment.Center) {
            QrCode(link, Modifier.size(minOf(maxWidth, if (code != null) 220.dp else 300.dp)).graphicsLayer { alpha = qrAlpha })
        }
        Spacer(Modifier.height(20.dp))
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            StatusDot(if (offline != null) Tone.IDLE else Tone.LIVE, pulse = offline == null)
            Text(
                if (offline != null) offlineLabel(offline, code = code != null) else "Ready — waiting for the receiver",
                style = CdType.body.copy(color = if (offline != null) Cd.text else Cd.muted),
            )
        }
        offline?.message?.takeIf { it.isNotBlank() }?.let {
            Spacer(Modifier.height(6.dp))
            Text(it, Modifier.fillMaxWidth(), style = CdType.small.copy(color = Cd.text), textAlign = TextAlign.Center)
        }
        Spacer(Modifier.height(12.dp))
        Text(
            if (offline != null && offline.paused) "The ${if (code != null) "code" else "link"} stays valid. Resume this send to let the receiver connect."
            else if (offline != null) "The ${if (code != null) "code" else "link"} stays valid while this phone reconnects."
            else if (code != null) "Type the code on cd.yash0.in, scan the QR, or share it."
            else "Scan the QR on the other device, or share the link.",
            style = CdType.bodyMuted, textAlign = TextAlign.Center,
        )
        Spacer(Modifier.height(6.dp))
        Text(privacyNote(view.isPrivate, code), style = CdType.small.copy(color = Cd.faint), textAlign = TextAlign.Center)
        if (devices.isNotEmpty()) {
            Spacer(Modifier.height(28.dp))
            SectionHeader("Send to your computer", Modifier.fillMaxWidth())
            Group {
                devices.forEachIndexed { i, pair ->
                    if (i > 0) RowDivider()
                    val sent = pair.id in offeredTo
                    ListRow(
                        pair.name, if (sent) "Offered — accept it with ${TrustedSend.LISTEN_COMMAND}" else "Tap to send it there privately",
                        icon = CdIcons.Laptop, iconTint = if (sent) Cd.success else Cd.accent,
                        onClick = { actions.sendToDevice(view, pair) },
                        trailing = { Icon(if (sent) CdIcons.Check else CdIcons.Upload, null, Modifier.size(20.dp), tint = if (sent) Cd.success else Cd.faint) },
                    )
                }
            }
        }
        Spacer(Modifier.height(28.dp))
        Hairline()
        Spacer(Modifier.height(20.dp))
        FileLine(view)
        Spacer(Modifier.height(20.dp))
        val cmd = receiveCommand(link, code)
        Row(
            Modifier.fillMaxWidth().panel(14.dp, Cd.ink).clickable(role = Role.Button) { actions.copy("Command", cmd) }.heightIn(min = 56.dp).padding(horizontal = 16.dp),
            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Text("$", style = CdType.mono.copy(color = Cd.accent))
            Text(if (code != null) cmd else "Copy receive command", Modifier.weight(1f), style = if (code != null) CdType.mono else CdType.body, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Icon(CdIcons.Copy, "Copy command", Modifier.size(20.dp), tint = Cd.faint)
        }
        Spacer(Modifier.height(10.dp))
        Text("In a terminal, run this to receive.", Modifier.fillMaxWidth(), style = CdType.small.copy(color = Cd.faint))
    }
}

@Composable
private fun Progress(view: TransferView, link: String?, actions: CdActions) {
    val fraction by animateFloatAsState(Format.fraction(view), tween(650, easing = LinearOutSlowInEasing), label = "frac")
    val live = view.phase == TransferPhase.TRANSFERRING || view.phase == TransferPhase.VERIFYING
    val speed by animateFloatAsState(if (live) view.bytesPerSecond.toFloat() else 0f, tween(700, easing = FastOutSlowInEasing), label = "speed")
    val scale by animateFloatAsState(Format.gaugeScale(view.bytesPerSecond.toDouble()).toFloat(), tween(900, easing = EaseInOutSoft), label = "scale")
    Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally) {
        BoxWithConstraints(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
            val side = minOf(maxWidth, 300.dp)
            Box(Modifier.size(side), contentAlignment = Alignment.BottomCenter) {
                Speedometer(speed, scale, live, Modifier.fillMaxSize())
                // Status sits in the gauge's open bottom instead of below it.
                Row(Modifier.padding(bottom = side * 0.06f), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    StatusDot(view.tone(), pulse = view.active)
                    Text(Format.phase(view).replaceFirstChar { it.uppercase() }, style = CdType.body.copy(color = Cd.muted))
                    if (view.route != Route.NONE) Chip(Format.route(view.route), when (view.route) { Route.LAN -> CdIcons.Wifi; Route.DIRECT -> CdIcons.Bolt; else -> CdIcons.Relay }, if (view.route == Route.RELAY) Cd.muted else Cd.success)
                }
            }
        }
        Spacer(Modifier.height(24.dp))
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.Bottom) {
            Text(Format.percent(fraction), style = CdType.mono.copy(fontSize = 34.sp, lineHeight = 38.sp, fontWeight = FontWeight.Bold, letterSpacing = (-0.02).em))
            Spacer(Modifier.weight(1f))
            if (live) Text("${Format.eta(view)} left", style = CdType.body.copy(color = Cd.muted))
        }
        Spacer(Modifier.height(14.dp))
        ProgressTrack(fraction, height = 10.dp, glint = live, color = if (view.phase == TransferPhase.PAUSED) Cd.faint else Cd.accent)
        Spacer(Modifier.height(12.dp))
        Text(
            "${Format.size((view.size.toDouble() * fraction).toLong().takeIf { view.size > 0 } ?: view.done)} of ${Format.size(view.size)}",
            Modifier.fillMaxWidth(), style = CdType.monoSmall,
        )
        Spacer(Modifier.height(28.dp))
        Hairline()
        Spacer(Modifier.height(20.dp))
        FileLine(view)
        view.message?.takeIf { it.isNotBlank() }?.let { Spacer(Modifier.height(14.dp)); Text(it, Modifier.fillMaxWidth(), style = CdType.small) }
        if (view.direction == Direction.SEND && link != null && view.isPrivate) {
            Spacer(Modifier.height(20.dp))
            Row(
                Modifier.fillMaxWidth().panel(14.dp, Cd.ink).clickable(role = Role.Button) { actions.copy(linkLabel(view.isPrivate), link) }.heightIn(min = 56.dp).padding(horizontal = 16.dp),
                verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                Icon(CdIcons.Link, null, Modifier.size(20.dp), tint = Cd.accent)
                Text(if (view.isPrivate) "Private transfer link" else "Transfer link", Modifier.weight(1f), style = CdType.body)
                Icon(CdIcons.Copy, "Copy ${linkLabel(view.isPrivate).lowercase()}", Modifier.size(20.dp), tint = Cd.faint)
            }
        }
        if (view.direction == Direction.SEND && view.active) {
            Spacer(Modifier.height(16.dp))
            Text("Keep CD open while sending. If it closes, open it and tap Resume.", Modifier.fillMaxWidth(), style = CdType.small.copy(color = Cd.faint))
        }
    }
}

/** 240° arc gauge. [bytesPerSecond] and [scaleMb] arrive animated so the arc and number glide. */
@Composable
fun Speedometer(bytesPerSecond: Float, scaleMb: Float, live: Boolean, modifier: Modifier = Modifier) {
    val (num, unit) = Format.speedParts(bytesPerSecond.toDouble())
    val fill = ((bytesPerSecond / (1024f * 1024f)) / scaleMb).coerceIn(0f, 1f)
    Box(modifier.aspectRatio(1f).semantics { contentDescription = "Speed $num $unit" }, contentAlignment = Alignment.Center) {
        Canvas(Modifier.fillMaxSize()) {
            val stroke = size.minDimension * 0.045f
            val inset = stroke / 2 + size.minDimension * 0.07f
            val arcSize = Size(size.width - inset * 2, size.height - inset * 2)
            val tl = Offset(inset, inset)
            val start = 150f
            val sweep = 240f
            drawArc(Cd.ink, start, sweep, false, tl, arcSize, style = Stroke(stroke, cap = StrokeCap.Round))
            if (fill > 0.002f) drawArc(
                Brush.sweepGradient(0f to Cd.accentSoft, 0.42f to Cd.accentSoft, 0.75f to Cd.accent, 1f to Cd.accentHi, center = center),
                start, sweep * fill, false, tl, arcSize, style = Stroke(stroke, cap = StrokeCap.Round),
            )
            val r = size.minDimension / 2 - size.minDimension * 0.02f
            for (i in 0..24) {
                val a = Math.toRadians((start + sweep * i / 24f).toDouble())
                val on = i / 24f <= fill && fill > 0f
                val major = i % 6 == 0
                drawCircle(if (on) Cd.accent else Cd.faint.copy(alpha = if (major) 0.55f else 0.25f), if (major) 2.2.dp.toPx() else 1.3.dp.toPx(), Offset(center.x + r * cos(a).toFloat(), center.y + r * sin(a).toFloat()))
            }
            if (fill > 0.002f) {
                val a = Math.toRadians((start + sweep * fill).toDouble())
                val rr = arcSize.width / 2
                val p = Offset(center.x + rr * cos(a).toFloat(), center.y + rr * sin(a).toFloat())
                drawCircle(Cd.accent.copy(alpha = 0.25f), stroke * 1.1f, p)
                drawCircle(Cd.text, stroke * 0.32f, p)
            }
        }
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Text(if (live || bytesPerSecond > 1f) num else "–", style = CdType.mono.copy(fontSize = 56.sp, lineHeight = 60.sp, fontWeight = FontWeight.Bold, letterSpacing = (-0.03).em, color = Cd.text))
            Text(unit, style = CdType.mono.copy(fontSize = 15.sp, color = Cd.accent))
        }
    }
}

@Composable
private fun ColumnScope.Pinned(view: TransferView, link: String?, code: String?, actions: CdActions, onBack: () -> Unit) {
    val send = view.direction == Direction.SEND
    when {
        view.phase == TransferPhase.COMPLETE -> {
            if (send) PrimaryButton("Send more files", { actions.pickFiles() }, Modifier.fillMaxWidth(), icon = CdIcons.Upload)
            else PrimaryButton("Open", { actions.open(view) }, Modifier.fillMaxWidth(), icon = CdIcons.Open)
            SecondaryButton("Done", onBack, Modifier.fillMaxWidth())
        }
        view.phase == TransferPhase.FAILED -> {
            if (send) PrimaryButton("Choose files again", { actions.pickFiles() }, Modifier.fillMaxWidth(), icon = CdIcons.Upload)
            else PrimaryButton("Try again", { actions.resume(view) }, Modifier.fillMaxWidth(), icon = CdIcons.Retry)
            SecondaryButton("Remove from list", { actions.dismiss(view) }, Modifier.fillMaxWidth())
        }
        view.phase == TransferPhase.CANCELLED -> SecondaryButton("Remove from list", { actions.dismiss(view) }, Modifier.fillMaxWidth())
        link != null -> {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                if (code != null) SecondaryButton("Copy code", { actions.copy("Code", code) }, Modifier.weight(1f), icon = CdIcons.Copy)
                else SecondaryButton("Copy link", { actions.copy(linkLabel(view.isPrivate), link) }, Modifier.weight(1f), icon = CdIcons.Copy)
                PrimaryButton("Share", { actions.share(shareText(link, code)) }, Modifier.weight(1f), icon = CdIcons.Share)
            }
            Text("Cancel send", Modifier.align(Alignment.CenterHorizontally).clip(RoundedCornerShape(10.dp)).clickable(role = Role.Button) { actions.cancel(view) }.padding(horizontal = 16.dp, vertical = 12.dp), style = CdType.label.copy(color = Cd.danger))
        }
        else -> {
            val canResume = view.phase == TransferPhase.PAUSED || (view.phase == TransferPhase.RETRYING && !send)
            // Receive transfers are discarded only once paused (the receiver keeps verified progress until then).
            val canCancel = send || view.phase == TransferPhase.PAUSED
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                if (canCancel) SecondaryButton(if (send) "Cancel" else "Discard", { actions.cancel(view) }, Modifier.weight(1f), icon = CdIcons.Close, danger = true)
                if (canResume) PrimaryButton(if (codeExpired(view)) "Get code" else "Resume", { actions.resume(view) }, Modifier.weight(1f), icon = CdIcons.Play)
                else if (view.active) SecondaryButton("Pause", { actions.pause(view) }, Modifier.weight(1f), icon = CdIcons.Pause)
            }
        }
    }
}

@Composable
private fun Result(view: TransferView) {
    val send = view.direction == Direction.SEND
    val (icon, tone) = when (view.phase) {
        TransferPhase.COMPLETE -> CdIcons.Check to Tone.SUCCESS
        TransferPhase.CANCELLED -> CdIcons.Close to Tone.IDLE
        else -> CdIcons.Close to Tone.DANGER
    }
    Column(Modifier.fillMaxWidth().padding(top = 48.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        ResultMark(icon, tone, size = 88.dp)
        Spacer(Modifier.height(28.dp))
        Text(
            when (view.phase) { TransferPhase.COMPLETE -> if (send) "Sent" else "Saved"; TransferPhase.CANCELLED -> "Cancelled"; else -> "That didn’t work" },
            style = CdType.largeTitle,
        )
        Spacer(Modifier.height(10.dp))
        Text(
            when (view.phase) {
                TransferPhase.COMPLETE -> if (send) "The receiver verified every byte." else "Saved to Downloads/CD"
                else -> view.message ?: if (view.phase == TransferPhase.CANCELLED) "Nothing more will be sent." else "The transfer stopped."
            },
            style = CdType.body.copy(color = if (view.phase == TransferPhase.FAILED) Cd.dangerText else Cd.muted), textAlign = TextAlign.Center,
        )
        Spacer(Modifier.height(40.dp))
        Hairline()
        Spacer(Modifier.height(20.dp))
        FileLine(view, center = true)
    }
}

/** 72dp history row. */
@Composable
fun TransferRow(view: TransferView, onClick: () -> Unit, modifier: Modifier = Modifier) {
    val fraction by animateFloatAsState(Format.fraction(view), tween(650, easing = LinearOutSlowInEasing), label = "rowfrac")
    val tone = view.tone()
    val tint = when (tone) { Tone.SUCCESS -> Cd.success; Tone.DANGER -> Cd.danger; Tone.IDLE -> Cd.faint; else -> Cd.accent }
    val sub = when {
        view.phase == TransferPhase.TRANSFERRING -> "${Format.percent(fraction)} · ${Format.speed(view.bytesPerSecond)}"
        view.finished -> "${Format.phase(view).replaceFirstChar { it.uppercase() }} · ${Format.size(view.size)} · ${Format.ago(view.updatedAt)}"
        else -> "${Format.phase(view).replaceFirstChar { it.uppercase() }} · ${Format.size(view.size)}"
    }
    ListRow(
        view.name, sub, modifier, icon = if (view.direction == Direction.SEND) CdIcons.ArrowUp else CdIcons.ArrowDown, iconTint = tint,
        supportingColor = if (tone == Tone.DANGER) Cd.danger else Cd.muted, onClick = onClick,
        below = {
            AnimatedVisibility(view.active || view.phase == TransferPhase.PAUSED, enter = fadeIn() + expandVertically(), exit = fadeOut() + shrinkVertically()) {
                ProgressTrack(fraction, Modifier.padding(top = 8.dp), height = 4.dp, glint = false, color = if (view.phase == TransferPhase.PAUSED) Cd.faint else Cd.accent)
            }
        },
        trailing = { Icon(CdIcons.Chevron, null, Modifier.size(20.dp), tint = Cd.faint) },
    )
}

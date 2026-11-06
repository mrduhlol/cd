package `in`.yash0.cd.ui

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import `in`.yash0.cd.Direction
import `in`.yash0.cd.Pairing
import `in`.yash0.cd.PushBridge
import `in`.yash0.cd.TransferView

/* ---------- Send ---------- */

@Composable
fun SendTab(state: UiState, transfers: List<TransferView>, actions: CdActions, chrome: TabChrome) {
    val sends = transfers.filter { it.direction == Direction.SEND }
    ScreenFrame(
        "Send", navigation = chrome.brand, actions = chrome.actions, bottomBar = chrome.bottomBar,
        pinned = { PrimaryButton(if (state.sendError != null) "Try again" else if (state.sendPrivate) "Choose files · private link" else "Choose files", { state.sendError = null; actions.pickFiles() }, Modifier.fillMaxWidth(), icon = CdIcons.Upload) },
    ) {
        val error = state.sendError
        if (error != null) {
            Row(
                Modifier.fillMaxWidth().clip(RoundedCornerShape(18.dp)).background(Cd.panel).border(1.dp, Cd.danger.copy(alpha = 0.35f), RoundedCornerShape(18.dp)).padding(18.dp),
                horizontalArrangement = Arrangement.spacedBy(16.dp),
            ) {
                ResultMark(CdIcons.Close, Tone.DANGER, size = 44.dp)
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text("That didn’t work", style = CdType.rowTitle)
                    Text(error, style = CdType.small.copy(color = Cd.dangerText))
                    Text("Dismiss", Modifier.padding(top = 6.dp).clip(RoundedCornerShape(6.dp)).clickable(role = Role.Button) { state.sendError = null }.padding(vertical = 8.dp), style = CdType.label.copy(color = Cd.accent))
                }
            }
            Spacer(Modifier.height(28.dp))
        }
        Hero(
            CdIcons.Upload, "Share anything from your phone",
            if (state.sendPrivate) "Pick files and CD makes a private, end-to-end encrypted link and QR."
            else "Pick files and CD gives you a 5-digit code and QR. Type the code on cd.yash0.in or run cdx receive <code>.",
        )
        Spacer(Modifier.height(24.dp))
        Group {
            SwitchListRow(
                "Private link instead of a code",
                "End-to-end encrypted: the key never reaches CD’s server. There is no code to type.",
                state.sendPrivate, { actions.setSendPrivate(it) }, CdIcons.Shield,
            )
        }
        Spacer(Modifier.height(28.dp))
        SectionHeader("Send to your computer")
        if (state.pairs.isEmpty()) Group {
            ListRow(
                "Pair a computer", "Run cdx pair on it, then tap to scan its QR. After that, send here without codes.",
                icon = CdIcons.Laptop, onClick = { actions.scan() },
                trailing = { Icon(CdIcons.Scan, null, Modifier.size(20.dp), tint = Cd.faint) },
            )
        } else Group {
            state.pairs.forEachIndexed { i, pair ->
                if (i > 0) RowDivider()
                ListRow(
                    pair.name, "Private link, straight to cdx on it", icon = CdIcons.Laptop,
                    onClick = { state.sendError = null; actions.pickFiles(pair) },
                    trailing = { Icon(CdIcons.Upload, "Choose files for ${pair.name}", Modifier.size(20.dp), tint = Cd.accent) },
                )
            }
        }
        if (sends.isNotEmpty()) {
            Spacer(Modifier.height(28.dp))
            SectionHeader("Your sends")
            TransferGroup(sends.take(4), state)
        }
    }
}

@Composable
private fun Hero(icon: ImageVector, title: String, body: String) {
    Column(Modifier.fillMaxWidth().enter(), horizontalAlignment = Alignment.Start) {
        Box(
            Modifier.size(72.dp).clip(CircleShape)
                .background(Brush.radialGradient(listOf(Cd.accent.copy(alpha = 0.24f), Cd.accent.copy(alpha = 0.04f))))
                .border(1.dp, Cd.accent.copy(alpha = 0.4f), CircleShape),
            contentAlignment = Alignment.Center,
        ) { Icon(icon, null, Modifier.size(30.dp), tint = Cd.accent) }
        Spacer(Modifier.height(24.dp))
        Text(title, style = CdType.title)
        Spacer(Modifier.height(8.dp))
        Text(body, style = CdType.bodyMuted)
    }
}

/* ---------- Receive ---------- */

@Composable
fun ReceiveTab(state: UiState, status: String, actions: CdActions, chrome: TabChrome) {
    ScreenFrame(
        "Receive", navigation = chrome.brand, actions = chrome.actions, bottomBar = chrome.bottomBar,
        pinned = {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                SecondaryButton("Scan QR", { actions.scan() }, Modifier.weight(1f), icon = CdIcons.Scan)
                PrimaryButton(
                    when { state.resolving -> "Looking up…"; state.input.trim().startsWith("cdpair:", ignoreCase = true) -> "Review"; else -> "Receive" },
                    { actions.submit(state.input.trim()) }, Modifier.weight(1f), enabled = state.input.isNotBlank() && !state.resolving,
                )
            }
        },
    ) {
        SectionHeader("Code or link from the sender")
        InkField(
            state.input,
            { value ->
                val was = autoSubmittable(state.input)
                state.input = value; state.inputError = ""
                // A complete 5-digit code (or code URL) goes straight through; typed links wait for Receive.
                if (!was && autoSubmittable(value) && !state.resolving) actions.submit(value.trim())
            },
            "5-digit code or link", error = state.inputError.isNotEmpty(),
            onGo = { if (state.input.isNotBlank() && !state.resolving) actions.submit(state.input.trim()) }, description = "Share code, private transfer link, or pairing link",
            trailing = {
                if (state.resolving) Spinner(Modifier.padding(end = 12.dp))
                else if (state.input.isEmpty()) GhostButton("Paste", {
                    actions.paste()?.takeIf { it.isNotBlank() }?.let { pasted ->
                        // Pasting is an explicit action: submit whatever was pasted, including pairing links.
                        state.input = pasted; state.inputError = ""
                        actions.submit(pasted.trim())
                    }
                }, icon = CdIcons.Paste, color = Cd.accent)
                else IconAction(CdIcons.Close, "Clear", { state.input = ""; state.inputError = "" }, tint = Cd.faint)
            },
        )
        AnimatedVisibility(state.inputError.isNotEmpty()) { Text(state.inputError, Modifier.padding(top = 10.dp), style = CdType.small.copy(color = Cd.danger)) }
        Spacer(Modifier.height(10.dp))
        Text("Type the 5-digit code, paste a link, or scan the sender’s QR. A complete code starts right away.", style = CdType.small)

        Spacer(Modifier.height(32.dp))
        SectionHeader("Trusted devices")
        Group {
            val (title, detail, icon) = when {
                state.paused -> Triple("Receiving is paused", "Trusted devices can’t send until you turn it back on in Settings.", CdIcons.Pause)
                state.wakeAvailable -> Triple("Trusted devices wake CD", "Your paired laptops wake CD automatically when they send.", CdIcons.Bell)
                else -> Triple("Receive while CD is open", "Keep CD open to receive from trusted devices — wake-up isn’t set up.", CdIcons.Shield)
            }
            ListRow(
                title, detail, icon = icon, iconTint = if (state.paused) Cd.faint else Cd.accent,
                onClick = { state.open(Screen.Settings) },
                below = liveStatus(status)?.let { s -> { Text(s, Modifier.padding(top = 4.dp), style = CdType.monoSmall.copy(fontSize = 13.sp, color = Cd.accent)) } },
            )
            RowDivider()
            ListRow(
                when (state.pairs.size) { 0 -> "Pair a laptop"; 1 -> "1 trusted device"; else -> "${state.pairs.size} trusted devices" },
                if (state.pairs.isEmpty()) "Run cdx pair on it, then tap to scan its QR." else state.pairs.joinToString(" · ") { it.name },
                icon = CdIcons.Laptop, onClick = { if (state.pairs.isEmpty()) actions.scan() else state.tab = Tab.DEVICES },
                trailing = { Icon(if (state.pairs.isEmpty()) CdIcons.Scan else CdIcons.Chevron, null, Modifier.size(20.dp), tint = Cd.faint) },
            )
        }
    }
}

/** The legacy receiver posts idle lines ("Ready to receive", "Receiving is off"); only real activity is worth showing. */
private fun liveStatus(status: String): String? = status.takeIf { it.isNotBlank() && it !in setOf("Receiving is off", "Ready to receive", "Receiving stopped") }

/* ---------- Transfers ---------- */

@Composable
fun TransfersTab(state: UiState, transfers: List<TransferView>, chrome: TabChrome) {
    ScreenFrame("Transfers", navigation = chrome.brand, actions = chrome.actions, bottomBar = chrome.bottomBar) {
        if (transfers.isEmpty()) {
            EmptyBrand("Nothing here yet", "Sends and receives show up here. Received files land in Downloads/CD.")
            return@ScreenFrame
        }
        val active = transfers.filter { !it.finished }
        val earlier = transfers.filter { it.finished }
        if (active.isNotEmpty()) { SectionHeader("In progress"); TransferGroup(active, state); Spacer(Modifier.height(28.dp)) }
        if (earlier.isNotEmpty()) { SectionHeader("Earlier"); TransferGroup(earlier, state) }
    }
}

@Composable
fun TransferGroup(list: List<TransferView>, state: UiState) {
    Group {
        list.forEachIndexed { i, view ->
            if (i > 0) RowDivider()
            TransferRow(view, { state.open(Screen.Transfer(view.id, view.direction)) })
        }
    }
}

/** Empty state: the website's identity lives here instead of on every screen. */
@Composable
fun EmptyBrand(title: String, body: String) {
    Column(Modifier.fillMaxWidth().padding(top = 40.dp).enter(), horizontalAlignment = Alignment.CenterHorizontally) {
        Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Text("cd", style = CdType.brandLarge)
            Text("/di·rect/", Modifier.padding(bottom = 8.dp), style = CdType.kicker.copy(fontSize = 13.sp))
        }
        Spacer(Modifier.height(16.dp))
        Text("Direct phone-to-terminal file transfer.", style = CdType.body.copy(color = Cd.muted), textAlign = TextAlign.Center)
        Spacer(Modifier.height(40.dp))
        Text(title, style = CdType.title, textAlign = TextAlign.Center)
        Spacer(Modifier.height(8.dp))
        Text(body, style = CdType.bodyMuted, textAlign = TextAlign.Center)
    }
}

/* ---------- Devices ---------- */

@Composable
fun DevicesTab(state: UiState, actions: CdActions, chrome: TabChrome) {
    var revoking by remember { mutableStateOf<Pairing?>(null) }
    ScreenFrame(
        "Devices", navigation = chrome.brand, actions = chrome.actions, bottomBar = chrome.bottomBar,
        pinned = { PrimaryButton("Scan pairing QR", { actions.scan() }, Modifier.fillMaxWidth(), icon = CdIcons.Scan) },
    ) {
        Text("Paired computers send straight to Downloads/CD on this phone. Send to them from the Send tab: pick the computer, then the files.", style = CdType.bodyMuted)
        Spacer(Modifier.height(28.dp))
        Spacer(Modifier.height(28.dp))
        SectionHeader(if (state.pairs.isEmpty()) "Trusted" else "Trusted · ${state.pairs.size}")
        if (state.pairs.isEmpty()) {
            Text("No trusted devices yet.", Modifier.padding(vertical = 8.dp), style = CdType.body.copy(color = Cd.faint))
        } else Group {
            state.pairs.forEachIndexed { i, pair ->
                if (i > 0) RowDivider()
                ListRow(pair.name, "Trusted · ${pair.id.take(8)}", icon = CdIcons.Laptop, trailing = {
                    Text("Revoke", Modifier.clip(RoundedCornerShape(10.dp)).clickable(role = Role.Button) { revoking = pair }.padding(horizontal = 12.dp, vertical = 12.dp), style = CdType.label.copy(color = Cd.danger))
                })
            }
        }
        Spacer(Modifier.height(32.dp))
        SectionHeader("How to pair")
        listOf("Run cdx pair on your laptop", "Scan the QR code it shows", "Confirm Trust on this phone").forEachIndexed { i, step ->
            Row(Modifier.fillMaxWidth().heightIn(min = 48.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                Box(Modifier.size(32.dp).clip(CircleShape).border(1.dp, Cd.accent.copy(alpha = 0.45f), CircleShape), contentAlignment = Alignment.Center) {
                    Text("${i + 1}", style = CdType.label.copy(color = Cd.accent, fontSize = 15.sp))
                }
                Text(step, style = CdType.body)
            }
        }
        Spacer(Modifier.height(12.dp))
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Chip("Beta", null)
            Text("Pairing is in beta. Pair only laptops you control, and revoke any you stop using.", Modifier.weight(1f), style = CdType.small.copy(color = Cd.faint))
        }
    }
    revoking?.let { pair ->
        CdDialog(
            title = "Revoke ${pair.name}?", body = "It will no longer be able to send to this phone. Pair again with cdx pair to restore it.",
            confirm = "Revoke", danger = true, onConfirm = { actions.revoke(pair); revoking = null }, onDismiss = { revoking = null },
        )
    }
}

/* ---------- Settings ---------- */

@OptIn(ExperimentalFoundationApi::class)
@Composable
fun SettingsScreen(state: UiState, actions: CdActions, version: String, debug: Boolean) {
    ScreenFrame("Settings", navigation = { BackButton { state.back() } }) {
        Spacer(Modifier.height(32.dp))
        SectionHeader("Receiving")
        Group {
            SwitchListRow("Pause receiving", "Reject wake-ups and transfers from trusted devices.", state.paused, { actions.setPaused(it) }, CdIcons.Pause)
            if (PushBridge.available) {
                RowDivider()
                SwitchListRow("Wake-up notifications", PushBridge.status, state.push, { actions.setPush(it) }, CdIcons.Bell)
            }
            RowDivider()
            SwitchListRow("Use mobile data", "Off by default. Unmetered Wi-Fi always works.", state.mobile, { actions.setMobile(it) }, CdIcons.Signal)
        }
        Spacer(Modifier.height(10.dp))
        Text(
            if (PushBridge.available) "Google delivers a wake-up hint when a trusted laptop starts sending. Paused transfers stay paused." else "This build has no wake-up. Keep CD open to receive from trusted devices.",
            Modifier.padding(horizontal = 4.dp), style = CdType.small.copy(color = Cd.faint),
        )
        Spacer(Modifier.height(32.dp))
        SectionHeader("Battery")
        Group {
            ListRow("Battery settings", "If wake-ups are slow, let CD run unrestricted.", icon = CdIcons.Battery, onClick = { actions.batterySettings() },
                trailing = { Icon(CdIcons.Open, null, Modifier.size(20.dp), tint = Cd.faint) })
        }
        Spacer(Modifier.height(32.dp))
        SectionHeader("Get the cdx CLI (beta)")
        // The install script defaults to the latest stable release, which lacks cdx pair; pin the beta tag explicitly.
        val cmd = "curl -fsSL https://cd.yash0.in/install.sh | CDX_VERSION=v0.4.0-beta.2 sh"
        Group {
            ListRow(cmd, "Tap to copy. Then cdx receive <code or link>, or cdx pair (beta).", icon = CdIcons.Terminal, titleStyle = CdType.mono.copy(fontSize = 14.sp), titleLines = 3, onClick = { actions.copy("Install command", cmd) },
                trailing = { Icon(CdIcons.Copy, null, Modifier.size(20.dp), tint = Cd.faint) })
        }
        Spacer(Modifier.height(40.dp))
        Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally) {
            Row(
                Modifier.combinedClickable(onClick = {}, onLongClick = { if (debug) actions.debugInject() }, indication = null, interactionSource = null),
                verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                Text("cd", style = CdType.brand.copy(fontSize = 40.sp, lineHeight = 40.sp))
                Text("/di·rect/", Modifier.padding(bottom = 5.dp), style = CdType.kicker)
            }
            Spacer(Modifier.height(8.dp))
            Text("Direct phone-to-terminal file transfer.", style = CdType.small)
            Text("Version $version · cd.yash0.in", style = CdType.small.copy(color = Cd.faint))
            Spacer(Modifier.height(8.dp))
            Text("Beta build. Features and compatibility may change between releases.", style = CdType.small.copy(color = Cd.faint), textAlign = TextAlign.Center)
        }
    }
}

@Composable
fun SwitchListRow(title: String, detail: String, checked: Boolean, onChange: (Boolean) -> Unit, icon: ImageVector) {
    val haptics = rememberHaptics()
    ListRow(
        title, detail, icon = icon, iconTint = if (checked) Cd.accent else Cd.faint,
        modifier = Modifier.toggleable(checked, role = Role.Switch) { haptics.tick(); onChange(it) },
        trailing = { CdSwitch(checked, onChange) },
    )
}

/* ---------- dialog ---------- */

@Composable
fun CdDialog(title: String, body: String, confirm: String, onConfirm: () -> Unit, onDismiss: () -> Unit, danger: Boolean = false, detail: String? = null, icon: ImageVector? = null, dismiss: String = "Cancel") {
    Dialog(onDismiss, DialogProperties(usePlatformDefaultWidth = false)) {
        Column(
            Modifier.padding(Gutter).fillMaxWidth().enter().clip(RoundedCornerShape(24.dp)).background(Cd.workbench)
                .border(1.dp, Cd.lineSoft, RoundedCornerShape(24.dp)).padding(24.dp),
        ) {
            if (icon != null) { IconTile(icon, size = 52.dp); Spacer(Modifier.height(20.dp)) }
            Text(title, style = CdType.title, maxLines = 3, overflow = TextOverflow.Ellipsis)
            Spacer(Modifier.height(10.dp))
            Text(body, style = CdType.bodyMuted)
            if (detail != null) { Spacer(Modifier.height(14.dp)); StatusNote(detail) }
            Spacer(Modifier.height(24.dp))
            if (danger) SecondaryButton(confirm, onConfirm, Modifier.fillMaxWidth(), danger = true, highlighted = true)
            else PrimaryButton(confirm, onConfirm, Modifier.fillMaxWidth())
            Spacer(Modifier.height(10.dp))
            SecondaryButton(dismiss, onDismiss, Modifier.fillMaxWidth())
        }
    }
}

/** Shared top-bar and bottom-bar slots for the four root tabs. */
class TabChrome(
    val brand: @Composable () -> Unit,
    val actions: @Composable RowScope.() -> Unit,
    val bottomBar: @Composable () -> Unit,
)

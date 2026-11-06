package `in`.yash0.cd.ui

import androidx.activity.compose.BackHandler
import androidx.compose.animation.*
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.unit.dp
import `in`.yash0.cd.TransferView
import kotlinx.coroutines.delay

@Composable
fun CdApp(state: UiState, transfers: List<TransferView>, status: String, actions: CdActions, debug: Boolean, version: String) {
    BackHandler(state.stack.size > 1 || state.tab != Tab.SEND) { state.back() }
    val activeCount = transfers.count { it.active }
    val chrome = TabChrome(
            brand = { BrandMark { if (debug) actions.debugInject() } },
            actions = { IconAction(CdIcons.Settings, "Settings", { state.open(Screen.Settings) }) },
            bottomBar = { BottomNav(state.tab, activeCount, { state.tab = it }) },
    )
    Box(Modifier.fillMaxSize().background(Cd.bg)) {
        AmbientBackground(height = 300.dp)
        AnimatedContent(
            targetState = state.screen to state.stack.size,
            transitionSpec = {
                val forward = targetState.second >= initialState.second
                val dir = if (forward) 1 else -1
                (fadeIn(tween(200, 30, EaseOutSoft)) + slideInHorizontally(tween(260, easing = EaseOutSoft)) { dir * it / 14 })
                    .togetherWith(fadeOut(tween(160)) + slideOutHorizontally(tween(260, easing = EaseOutSoft)) { -dir * it / 20 })
            },
            contentKey = { it.first },
            label = "screen",
        ) { (screen, _) ->
            when (screen) {
                Screen.Home -> AnimatedContent(state.tab, transitionSpec = { fadeIn(tween(220, 60)).togetherWith(fadeOut(tween(120))) }, label = "tab") { tab ->
                    when (tab) {
                        Tab.SEND -> SendTab(state, transfers, actions, chrome)
                        Tab.RECEIVE -> ReceiveTab(state, status, actions, chrome)
                        Tab.TRANSFERS -> TransfersTab(state, transfers, chrome)
                        Tab.DEVICES -> DevicesTab(state, actions, chrome)
                    }
                }
                Screen.Settings -> SettingsScreen(state, actions, version, debug)
                is Screen.Transfer -> TransferScreen(screen.id, screen.direction, transfers, actions, state.pairs, TrustedOffers.offered) { state.back() }
            }
        }
        Toast(state, Modifier.align(Alignment.TopCenter))
    }
    state.pending?.let { pair ->
        CdDialog(
            title = "Trust ${pair.name}?",
            body = "This computer will be able to send files straight to Downloads/CD on this phone, and you can send to it without a code. Confirm that you scanned the QR shown by your own computer. You can revoke access at any time.",
            detail = "device ${pair.id.take(8)}",
            confirm = "Trust device", icon = CdIcons.Shield,
            onConfirm = { actions.trust(pair) }, onDismiss = { state.pending = null },
        )
    }
}

/** Snackbar-style confirmation under the app bar, clear of the pinned buttons and the keyboard. */
@Composable
private fun Toast(state: UiState, modifier: Modifier) {
    var visible by remember { mutableStateOf(false) }
    LaunchedEffect(state.toastSerial) { if (state.toast != null) { visible = true; delay(if (state.toastError) 5000 else 1800); visible = false } }
    val tint = if (state.toastError) Cd.danger else Cd.success
    AnimatedVisibility(visible, modifier.statusBarsPadding().padding(top = 72.dp),
        enter = fadeIn(tween(220)) + slideInVertically(tween(320, easing = EaseOutSoft)) { -it / 2 } + scaleIn(tween(320, easing = EaseOutSoft), 0.92f),
        exit = fadeOut(tween(200)) + slideOutVertically(tween(240)) { -it / 3 }) {
        Row(
            Modifier.padding(horizontal = Gutter).clip(RoundedCornerShape(14.dp)).background(Cd.workbenchTab).border(1.dp, tint.copy(alpha = 0.45f), RoundedCornerShape(14.dp)).padding(horizontal = 18.dp, vertical = 14.dp),
            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Icon(if (state.toastError) CdIcons.Close else CdIcons.Check, null, Modifier.size(18.dp), tint = tint)
            Text(state.toast.orEmpty(), style = CdType.body)
        }
    }
}

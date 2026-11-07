package `in`.yash0.cd.ui

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.ScrollState
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Icon
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

val Gutter = 20.dp

/**
 * One screen: a top app bar that sits below the status bar and display cutout, a large title that
 * scrolls away (the bar then shows the small title on a solid background), scrolling content, and an
 * optional bottom area (pinned actions and/or the tab bar) above the navigation bar and keyboard.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun ScreenFrame(
    title: String,
    modifier: Modifier = Modifier,
    largeTitle: Boolean = true,
    navigation: (@Composable () -> Unit)? = null,
    actions: @Composable RowScope.() -> Unit = {},
    pinned: (@Composable ColumnScope.() -> Unit)? = null,
    bottomBar: (@Composable () -> Unit)? = null,
    scroll: ScrollState = rememberScrollState(),
    content: @Composable ColumnScope.() -> Unit,
) {
    val density = LocalDensity.current
    val collapsePx = with(density) { 44.dp.toPx() }
    // derivedStateOf: reading scroll.value directly recomposed the whole screen (QR, gauge) on every scrolled pixel.
    val collapsed by remember(scroll, largeTitle, collapsePx) { derivedStateOf { !largeTitle || scroll.value > collapsePx } }
    val scrolled by remember(scroll) { derivedStateOf { scroll.value > 0 } }
    val imeVisible = WindowInsets.isImeVisible
    Scaffold(
        modifier = modifier,
        containerColor = Color.Transparent,
        contentWindowInsets = WindowInsets(0),
        topBar = { AppBar(title, collapsed, scrolled, navigation, actions) },
        bottomBar = {
            Column {
                if (pinned != null) PinnedArea(scroll.canScrollForward, insets = bottomBar == null || imeVisible, content = pinned)
                if (bottomBar != null && !imeVisible) bottomBar()
                else if (pinned == null) Spacer(Modifier.windowInsetsBottomHeight(WindowInsets.navigationBars.union(WindowInsets.ime)))
            }
        },
    ) { pad ->
        Column(
            Modifier.padding(pad).consumeWindowInsets(pad).fillMaxSize().verticalScroll(scroll)
                .windowInsetsPadding(WindowInsets.displayCutout.only(WindowInsetsSides.Horizontal))
                .padding(horizontal = Gutter).padding(bottom = 32.dp),
        ) {
            if (largeTitle) {
                val a by animateFloatAsState(if (collapsed) 0f else 1f, tween(160), label = "lt")
                Text(title, Modifier.padding(top = 4.dp, bottom = 20.dp).alpha(a).semantics { heading() }, style = CdType.largeTitle, maxLines = 2, overflow = TextOverflow.Ellipsis)
            } else Spacer(Modifier.height(8.dp))
            content()
        }
    }
}

@Composable
private fun AppBar(title: String, collapsed: Boolean, scrolled: Boolean, navigation: (@Composable () -> Unit)?, actions: @Composable RowScope.() -> Unit) {
    // Solid bar once content moves under it, so nothing scrolls illegibly beneath the clock and icons.
    val bg by animateColorAsState(if (scrolled) Cd.bg.copy(alpha = 0.97f) else Color.Transparent, tween(200), label = "bar")
    val line by animateColorAsState(if (scrolled) Cd.lineSoft else Color.Transparent, tween(200), label = "line")
    val titleAlpha by animateFloatAsState(if (collapsed) 1f else 0f, tween(180), label = "bt")
    Column(Modifier.fillMaxWidth().background(bg).drawBehind { drawLine(line, Offset(0f, size.height - 0.5f), Offset(size.width, size.height - 0.5f), 1f) }) {
        Spacer(Modifier.windowInsetsTopHeight(WindowInsets.statusBars.union(WindowInsets.displayCutout)))
        Row(
            Modifier.fillMaxWidth().height(64.dp).windowInsetsPadding(WindowInsets.displayCutout.only(WindowInsetsSides.Horizontal)).padding(horizontal = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (navigation != null) navigation() else Spacer(Modifier.width(Gutter - 8.dp))
            Text(title, Modifier.weight(1f).padding(horizontal = 6.dp).alpha(titleAlpha), style = CdType.barTitle, maxLines = 1, overflow = TextOverflow.Ellipsis)
            actions()
        }
    }
}

@Composable
private fun PinnedArea(fade: Boolean, insets: Boolean, content: @Composable ColumnScope.() -> Unit) {
    Column(
        Modifier.fillMaxWidth()
            .drawBehind {
                // Content scrolling under the pinned buttons fades out instead of colliding with them.
                val h = 24.dp.toPx()
                if (fade) drawRect(Brush.verticalGradient(listOf(Color.Transparent, Cd.bg), startY = -h, endY = 0f), Offset(0f, -h), androidx.compose.ui.geometry.Size(size.width, h))
                drawRect(Cd.bg)
            }
            .then(if (insets) Modifier.windowInsetsPadding(WindowInsets.navigationBars.union(WindowInsets.ime).only(WindowInsetsSides.Bottom)) else Modifier)
            .padding(horizontal = Gutter).padding(top = 8.dp, bottom = 12.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
        content = content,
    )
}

/** Compact brand mark for root tabs; long-press injects fake data in debug builds. */
@OptIn(ExperimentalFoundationApi::class)
@Composable
fun BrandMark(onLongPress: () -> Unit) {
    Box(
        Modifier.height(48.dp).clip(RoundedCornerShape(10.dp))
            .combinedClickable(onClick = {}, onLongClick = onLongPress, indication = null, interactionSource = null)
            .padding(horizontal = 12.dp),
        contentAlignment = Alignment.Center,
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("cd", style = CdType.brand.copy(fontSize = 28.sp))
            Chip("Beta", null)
        }
    }
}

@Composable
fun BackButton(onBack: () -> Unit) = IconAction(CdIcons.Back, "Back", onBack)

/** Borderless 48dp icon action for app bars. */
@Composable
fun IconAction(icon: ImageVector, description: String, onClick: () -> Unit, tint: Color = Cd.text, badge: Boolean = false) {
    val haptics = rememberHaptics()
    Box(
        Modifier.size(48.dp).clip(CircleShape).clickable(role = Role.Button, onClickLabel = description) { haptics.tap(); onClick() }
            .semantics { contentDescription = description },
        contentAlignment = Alignment.Center,
    ) {
        Icon(icon, null, Modifier.size(24.dp), tint = tint)
        if (badge) Box(Modifier.align(Alignment.TopEnd).padding(10.dp).size(8.dp).clip(CircleShape).background(Cd.accent))
    }
}

/* ---------- bottom navigation ---------- */

@Composable
fun BottomNav(tab: Tab, activeCount: Int, onSelect: (Tab) -> Unit) {
    val haptics = rememberHaptics()
    val items = listOf(
        Triple(Tab.SEND, "Send", CdIcons.ArrowUp), Triple(Tab.RECEIVE, "Receive", CdIcons.ArrowDown),
        Triple(Tab.TRANSFERS, "Transfers", CdIcons.History), Triple(Tab.DEVICES, "Devices", CdIcons.Devices),
    )
    Column(
        Modifier.fillMaxWidth().background(Color(0xFF110604))
            .drawBehind { drawLine(Cd.lineSoft, Offset(0f, 0.5f), Offset(size.width, 0.5f), 1f) }
            .windowInsetsPadding(WindowInsets.navigationBars.union(WindowInsets.displayCutout).only(WindowInsetsSides.Bottom + WindowInsetsSides.Horizontal)),
    ) {
        Row(Modifier.fillMaxWidth().height(76.dp).padding(horizontal = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            items.forEach { (t, label, icon) ->
                val selected = t == tab
                val pill by animateFloatAsState(if (selected) 1f else 0f, tween(260, easing = EaseOutSoft), label = "pill")
                val color by animateColorAsState(if (selected) Cd.text else Cd.faint, label = "nc")
                Column(
                    Modifier.weight(1f).fillMaxHeight().clip(RoundedCornerShape(16.dp))
                        .selectable(selected, role = Role.Tab) { if (!selected) { haptics.tick(); onSelect(t) } },
                    horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center,
                ) {
                    Box(contentAlignment = Alignment.Center) {
                        Box(Modifier.size(64.dp, 32.dp).graphicsLayer { scaleX = 0.6f + 0.4f * pill; alpha = pill }.clip(CircleShape).background(Cd.accent.copy(alpha = 0.16f)))
                        Icon(icon, null, Modifier.size(22.dp), tint = if (selected) Cd.accent else Cd.faint)
                        if (t == Tab.TRANSFERS && activeCount > 0) Box(
                            Modifier.align(Alignment.TopEnd).offset(x = 2.dp, y = (-2).dp).sizeIn(minWidth = 18.dp, minHeight = 18.dp).clip(CircleShape).background(Cd.accent).padding(horizontal = 5.dp),
                            contentAlignment = Alignment.Center,
                        ) { Text("$activeCount", style = CdType.label.copy(fontSize = 11.sp, lineHeight = 12.sp, color = Cd.bg)) }
                    }
                    Spacer(Modifier.height(5.dp))
                    Text(label, style = CdType.label.copy(fontSize = 13.sp, color = color, fontWeight = if (selected) androidx.compose.ui.text.font.FontWeight.SemiBold else androidx.compose.ui.text.font.FontWeight.Medium), maxLines = 1)
                }
            }
        }
    }
}

/* ---------- one-level surfaces and rows ---------- */

@Composable
fun SectionHeader(text: String, modifier: Modifier = Modifier, trailing: (@Composable () -> Unit)? = null) {
    Row(modifier.fillMaxWidth().padding(top = 8.dp, bottom = 10.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(text, Modifier.weight(1f).semantics { heading() }, style = CdType.section)
        trailing?.invoke()
    }
}

/** A single surface holding rows. Never nest another surface inside. */
@Composable
fun Group(modifier: Modifier = Modifier, content: @Composable ColumnScope.() -> Unit) {
    Column(modifier.fillMaxWidth().clip(RoundedCornerShape(18.dp)).background(Cd.panel).border(1.dp, Cd.lineSoft, RoundedCornerShape(18.dp)), content = content)
}

@Composable
fun RowDivider(inset: Dp = 72.dp) = Box(Modifier.padding(start = inset).fillMaxWidth().height(1.dp).background(Cd.lineSoft))

/** 64–72dp list row: leading tile, title + supporting text, trailing slot. */
@Composable
fun ListRow(
    title: String, supporting: String?, modifier: Modifier = Modifier, icon: ImageVector? = null, iconTint: Color = Cd.accent,
    supportingColor: Color = Cd.muted, titleStyle: androidx.compose.ui.text.TextStyle = CdType.rowTitle, titleLines: Int = 2, onClick: (() -> Unit)? = null, below: (@Composable () -> Unit)? = null, trailing: (@Composable () -> Unit)? = null,
) {
    Row(
        modifier.fillMaxWidth().heightIn(min = 72.dp).then(if (onClick != null) Modifier.clickable(onClick = onClick) else Modifier).padding(horizontal = 16.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        if (icon != null) IconTile(icon, tint = iconTint)
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(title, style = titleStyle, maxLines = titleLines, overflow = TextOverflow.Ellipsis)
            if (supporting != null) Text(supporting, style = CdType.small.copy(color = supportingColor))
            below?.invoke()
        }
        trailing?.invoke()
    }
}

@Composable
fun SlideFadeVisibility(visible: Boolean, content: @Composable () -> Unit) =
    AnimatedVisibility(visible, enter = fadeIn() + slideInVertically { it / 4 }, exit = fadeOut() + slideOutVertically { it / 4 }) { content() }

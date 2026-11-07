package `in`.yash0.cd.ui

import android.os.Build
import android.view.HapticFeedbackConstants
import android.view.View
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.*
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsFocusedAsState
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.draw.scale
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.*
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp

/* ---------- haptics ---------- */

class Haptics(private val view: View) {
    fun confirm() { view.performHapticFeedback(if (Build.VERSION.SDK_INT >= 30) HapticFeedbackConstants.CONFIRM else HapticFeedbackConstants.VIRTUAL_KEY) }
    fun tick() { view.performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK) }
    fun tap() { view.performHapticFeedback(HapticFeedbackConstants.VIRTUAL_KEY) }
    fun reject() { view.performHapticFeedback(if (Build.VERSION.SDK_INT >= 30) HapticFeedbackConstants.REJECT else HapticFeedbackConstants.LONG_PRESS) }
}

@Composable fun rememberHaptics(): Haptics { val view = LocalView.current; return remember(view) { Haptics(view) } }

/* ---------- motion ---------- */

/** The site's signature curve: cubic-bezier(.2,.8,.2,1). */
val EaseOutSoft = CubicBezierEasing(0.2f, 0.8f, 0.2f, 1f)
/** The segmented pill's curve: cubic-bezier(.65,0,.35,1). */
val EaseInOutSoft = CubicBezierEasing(0.65f, 0f, 0.35f, 1f)

/** Fade + 14dp rise on first composition, like the site's `enter` keyframes. */
@Composable
fun Modifier.enter(delayMillis: Int = 0): Modifier {
    var shown by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) { shown = true }
    val t by animateFloatAsState(if (shown) 1f else 0f, tween(650, delayMillis, EaseOutSoft), label = "enter")
    return this.graphicsLayer { alpha = t; translationY = (1 - t) * 14.dp.toPx() }
}

/* ---------- surfaces ---------- */

/** The ambient header: warm vertical gradient plus the dot grid from src/ambient-dots.js, both masked out by ~60% height. */
@Composable
fun AmbientBackground(modifier: Modifier = Modifier, height: Dp = 520.dp) {
    val glow = rememberInfiniteTransition(label = "dots")
    val sweep by glow.animateFloat(0f, 1f, infiniteRepeatable(tween(9000, easing = LinearEasing)), label = "sweep")
    Canvas(modifier.fillMaxWidth().height(height)) {
        drawRect(Brush.verticalGradient(0f to Cd.headerTop, 0.6f to Cd.headerMid, 1f to Color.Transparent))
        val spacing = 16.dp.toPx()
        val dot = 1.5.dp.toPx()
        val fadeStart = size.height * 0.42f
        // A slow warm highlight drifts across the grid; on the site the pointer does this.
        val cx = size.width * (-0.2f + 1.4f * sweep)
        val cy = size.height * 0.28f
        val reach = 140.dp.toPx()
        var y = spacing / 2
        while (y < size.height) {
            val fade = if (y < fadeStart) 1f else (1f - (y - fadeStart) / (size.height - fadeStart)).coerceIn(0f, 1f)
            var x = spacing / 2
            while (x < size.width) {
                val d = kotlin.math.hypot(x - cx, y - cy)
                val strength = if (d < reach) (1 - d / reach).let { it * it } else 0f
                val color = if (strength > 0.08f) Cd.accent.copy(alpha = (0.34f + 0.38f * strength) * fade) else Color(0xFFE55F30).copy(alpha = 0.30f * fade)
                drawRect(color, Offset(x, y), Size(dot, dot))
                x += spacing
            }
            y += spacing
        }
    }
}

/** The website's `.workbench` card. */
fun Modifier.workbench(radius: Dp = 16.dp): Modifier = this
    .shadow(30.dp, RoundedCornerShape(radius), ambientColor = Color.Black, spotColor = Color.Black)
    .clip(RoundedCornerShape(radius))
    .background(Brush.verticalGradient(listOf(Color(0xEB1E0D09), Color(0xEB140806))))
    .drawBehind {
        drawRect(Brush.radialGradient(listOf(Cd.accent.copy(alpha = 0.09f), Color.Transparent), center = Offset(size.width / 2, -size.height * 0.1f), radius = size.width * 0.75f))
        drawLine(Color(0x0FFFDCBE), Offset(radius.toPx(), 0.5f), Offset(size.width - radius.toPx(), 0.5f), 1f)
    }
    .border(1.dp, Cd.lineSoft, RoundedCornerShape(radius))

/** Inner blocks (`.code-block`, stats tiles). */
fun Modifier.panel(radius: Dp = 10.dp, color: Color = Cd.panel): Modifier = this.clip(RoundedCornerShape(radius)).background(color).border(1.dp, Cd.line, RoundedCornerShape(radius))

fun Modifier.dashedBorder(color: Color, radius: Dp, width: Dp = 1.5.dp, dash: Dp = 6.dp, gap: Dp = 5.dp): Modifier = this.drawWithContent {
    drawContent()
    val w = width.toPx()
    drawRoundRect(color, topLeft = Offset(w / 2, w / 2), size = Size(size.width - w, size.height - w), cornerRadius = CornerRadius(radius.toPx()),
        style = Stroke(w, pathEffect = PathEffect.dashPathEffect(floatArrayOf(dash.toPx(), gap.toPx()))))
}

/* ---------- text bits ---------- */

@Composable fun Kicker(text: String, modifier: Modifier = Modifier, color: Color = Cd.faint) =
    Text(text.uppercase(), modifier, style = CdType.kicker.copy(color = color), maxLines = 1, overflow = TextOverflow.Ellipsis)

@Composable fun Hairline(modifier: Modifier = Modifier) = Box(modifier.fillMaxWidth().height(1.dp).background(Cd.line))

/** `.status` — mono note with a soft accent rule on the left. */
@Composable fun StatusNote(text: String, modifier: Modifier = Modifier) {
    Row(modifier.height(IntrinsicSize.Min)) {
        Box(Modifier.width(1.dp).fillMaxHeight().background(Cd.accentSoft))
        Text(text, Modifier.padding(horizontal = 12.dp, vertical = 6.dp), style = CdType.monoSmall)
    }
}

enum class Tone { ACCENT, LIVE, SUCCESS, DANGER, IDLE }

fun Tone.color(): Color = when (this) { Tone.ACCENT -> Cd.accent; Tone.LIVE -> Cd.live; Tone.SUCCESS -> Cd.success; Tone.DANGER -> Cd.dangerStrong; Tone.IDLE -> Cd.faint }

@Composable
fun StatusDot(tone: Tone, pulse: Boolean, modifier: Modifier = Modifier, size: Dp = 7.dp) {
    val alpha = if (pulse) {
        val t = rememberInfiniteTransition(label = "pulse")
        t.animateFloat(1f, 0.35f, infiniteRepeatable(tween(600, easing = FastOutSlowInEasing), RepeatMode.Reverse), label = "a").value
    } else 1f
    val c = tone.color()
    Box(modifier.size(size + 6.dp), contentAlignment = Alignment.Center) {
        Box(Modifier.size(size + 6.dp).clip(CircleShape).background(c.copy(alpha = 0.13f)))
        Box(Modifier.size(size).alpha(alpha).clip(CircleShape).background(c))
    }
}

/** `.state-board`: ● LABEL / value */
@Composable
fun StateBoard(label: String, value: String, tone: Tone, pulse: Boolean, modifier: Modifier = Modifier) {
    Row(modifier, verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        StatusDot(tone, pulse)
        Text("${label.uppercase()} /", style = CdType.kicker)
        Text(value, style = CdType.kicker.copy(color = if (tone == Tone.IDLE) Cd.muted else tone.color(), letterSpacing = 0.04.em), maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

/* ---------- buttons ---------- */

@Composable
private fun pressScale(source: MutableInteractionSource): Float {
    val pressed by source.collectIsPressedAsState()
    return animateFloatAsState(if (pressed) 0.97f else 1f, spring(stiffness = Spring.StiffnessMediumLow), label = "press").value
}

@Composable
fun PrimaryButton(text: String, onClick: () -> Unit, modifier: Modifier = Modifier, icon: ImageVector? = null, enabled: Boolean = true, haptic: Boolean = true) {
    val source = remember { MutableInteractionSource() }
    val haptics = rememberHaptics()
    val shape = RoundedCornerShape(10.dp)
    Box(
        modifier
            .scale(pressScale(source))
            .alpha(if (enabled) 1f else 0.5f)
            .heightIn(min = 52.dp)
            .shadow(if (enabled) 14.dp else 0.dp, shape, ambientColor = Cd.accent, spotColor = Cd.accent)
            .clip(shape)
            .background(Brush.verticalGradient(listOf(Cd.accentHi, Cd.accent)))
            .drawBehind { drawLine(Color(0x59FFE6D2), Offset(0f, 0.5f), Offset(size.width, 0.5f), 1.dp.toPx()) }
            .clickable(source, indication = androidx.compose.material3.ripple(color = Cd.bg), enabled = enabled, role = Role.Button) { if (haptic) haptics.confirm(); onClick() }
            .padding(horizontal = 22.dp, vertical = 14.dp),
        contentAlignment = Alignment.Center,
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            if (icon != null) Icon(icon, null, Modifier.size(18.dp), tint = Cd.bg)
            Text(text, style = CdType.label.copy(color = Cd.bg), maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
    }
}

@Composable
fun SecondaryButton(text: String, onClick: () -> Unit, modifier: Modifier = Modifier, icon: ImageVector? = null, enabled: Boolean = true, danger: Boolean = false, compact: Boolean = false, highlighted: Boolean = false) {
    val source = remember { MutableInteractionSource() }
    val haptics = rememberHaptics()
    val shape = RoundedCornerShape(10.dp)
    val pressed by source.collectIsPressedAsState()
    val hot = pressed || highlighted
    val border by animateColorAsState(if (hot) (if (danger) Cd.danger else Cd.accent) else Cd.line, label = "b")
    val content by animateColorAsState(if (hot) (if (danger) Cd.danger else Cd.accent) else if (danger) Cd.dangerText else Cd.text, label = "c")
    Box(
        modifier
            .scale(pressScale(source))
            .alpha(if (enabled) 1f else 0.5f)
            .heightIn(min = if (compact) 44.dp else 52.dp)
            .clip(shape)
            .background(Cd.block)
            .border(1.dp, border, shape)
            .clickable(source, indication = androidx.compose.material3.ripple(color = Cd.accent), enabled = enabled, role = Role.Button) { haptics.tap(); onClick() }
            .padding(horizontal = if (compact) 14.dp else 18.dp, vertical = 10.dp),
        contentAlignment = Alignment.Center,
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            if (icon != null) Icon(icon, null, Modifier.size(18.dp), tint = content)
            Text(text, style = CdType.label.copy(color = content, fontSize = if (compact) 14.sp else 15.sp), maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
    }
}

@Composable
fun GhostButton(text: String, onClick: () -> Unit, modifier: Modifier = Modifier, icon: ImageVector? = null, color: Color = Cd.muted) {
    val haptics = rememberHaptics()
    Row(
        modifier.heightIn(min = 44.dp).clip(RoundedCornerShape(8.dp)).clickable(role = Role.Button) { haptics.tap(); onClick() }.padding(horizontal = 6.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        if (icon != null) Icon(icon, null, Modifier.size(18.dp), tint = color)
        Text(text, style = CdType.label.copy(color = color, fontWeight = androidx.compose.ui.text.font.FontWeight.Medium))
    }
}

@Composable
fun IconCircleButton(icon: ImageVector, description: String, onClick: () -> Unit, modifier: Modifier = Modifier, badge: Boolean = false) {
    val haptics = rememberHaptics()
    Box(modifier.size(48.dp), contentAlignment = Alignment.Center) {
        Box(
            Modifier.size(44.dp).clip(CircleShape).background(Color(0x8C070302)).border(1.dp, Cd.line, CircleShape)
                .clickable(role = Role.Button) { haptics.tap(); onClick() }.semantics { contentDescription = description },
            contentAlignment = Alignment.Center,
        ) { Icon(icon, null, Modifier.size(20.dp), tint = Cd.text) }
        if (badge) Box(Modifier.align(Alignment.TopEnd).padding(5.dp).size(9.dp).clip(CircleShape).background(Cd.accent).border(2.dp, Cd.bg, CircleShape))
    }
}

/* ---------- controls ---------- */

/** The site's segmented control: the pill slides under the active tab. */
@Composable
fun Segmented(left: Pair<String, ImageVector>, right: Pair<String, ImageVector>, rightSelected: Boolean, onSelect: (Boolean) -> Unit, modifier: Modifier = Modifier) {
    val haptics = rememberHaptics()
    val t by animateFloatAsState(if (rightSelected) 1f else 0f, tween(400, easing = EaseInOutSoft), label = "seg")
    BoxWithConstraints(modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(Color(0x8C070302)).border(1.dp, Cd.line, RoundedCornerShape(12.dp)).padding(4.dp)) {
        val half = (maxWidth) / 2
        Box(
            Modifier.offset(x = half * t).width(half).height(48.dp)
                .clip(RoundedCornerShape(9.dp))
                .background(Cd.workbenchTab)
                .background(Brush.verticalGradient(listOf(Cd.accent.copy(alpha = 0.26f), Cd.accent.copy(alpha = 0.14f))))
                .border(1.dp, Cd.accent.copy(alpha = 0.4f), RoundedCornerShape(9.dp))
        )
        Row(Modifier.fillMaxWidth()) {
            listOf(left to false, right to true).forEach { (item, isRight) ->
                val selected = isRight == rightSelected
                val color by animateColorAsState(if (selected) Cd.text else Cd.faint, label = "segc")
                val iconColor by animateColorAsState(if (selected) Cd.accent else Cd.faint, label = "segi")
                Row(
                    Modifier.weight(1f).height(48.dp).clip(RoundedCornerShape(9.dp))
                        .clickable(role = Role.Tab) { if (!selected) { haptics.tick(); onSelect(isRight) } },
                    horizontalArrangement = Arrangement.Center, verticalAlignment = Alignment.CenterVertically,
                ) {
                    Icon(item.second, null, Modifier.size(17.dp).offset(y = if (selected) (if (isRight) 1.dp else (-1).dp) else 0.dp), tint = iconColor)
                    Spacer(Modifier.width(8.dp))
                    Text(item.first, style = CdType.label.copy(color = color, fontWeight = androidx.compose.ui.text.font.FontWeight.Medium))
                }
            }
        }
    }
}

/** Switch drawn in the site's language: dark track, accent gradient when on, cream thumb. */
@Composable
fun CdSwitch(checked: Boolean, onChange: (Boolean) -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true) {
    val haptics = rememberHaptics()
    val t by animateFloatAsState(if (checked) 1f else 0f, spring(dampingRatio = 0.72f, stiffness = 500f), label = "sw")
    Box(
        modifier.size(56.dp, 48.dp).alpha(if (enabled) 1f else 0.5f)
            .toggleable(checked, enabled = enabled, role = Role.Switch, interactionSource = null, indication = null) { haptics.tick(); onChange(it) },
        contentAlignment = Alignment.Center,
    ) {
        Canvas(Modifier.size(52.dp, 30.dp)) {
            val r = size.height / 2
            drawRoundRect(lerp(Color(0xFF070302), Cd.accent, t), cornerRadius = CornerRadius(r))
            if (t > 0f) drawRoundRect(Brush.verticalGradient(listOf(Cd.accentHi.copy(alpha = t), Cd.accent.copy(alpha = t))), cornerRadius = CornerRadius(r))
            drawRoundRect(lerp(Cd.line, Cd.accent, t), cornerRadius = CornerRadius(r), style = Stroke(1.dp.toPx()))
            val thumbR = r - 4.dp.toPx()
            val cx = r + (size.width - 2 * r) * t
            drawCircle(Color.Black.copy(alpha = 0.25f), thumbR, Offset(cx, r + 1.dp.toPx()))
            drawCircle(lerp(Cd.faint, Cd.bg, t), thumbR, Offset(cx, r))
        }
    }
}

/** Setting row: title + detail on the left, a switch on the right. Whole row toggles. */
@Composable
fun SwitchRow(title: String, detail: String, checked: Boolean, onChange: (Boolean) -> Unit, modifier: Modifier = Modifier, icon: ImageVector? = null) {
    val haptics = rememberHaptics()
    Row(
        modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp))
            .toggleable(checked, role = Role.Switch) { haptics.tick(); onChange(it) }
            .padding(vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        if (icon != null) IconTile(icon)
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Text(title, style = CdType.rowTitle)
            Text(detail, style = CdType.small)
        }
        CdSwitch(checked, onChange)
    }
}

@Composable
fun IconTile(icon: ImageVector, tint: Color = Cd.accent, size: Dp = 40.dp, modifier: Modifier = Modifier) {
    Box(modifier.size(size).clip(RoundedCornerShape(10.dp)).background(Brush.radialGradient(listOf(tint.copy(alpha = 0.18f), tint.copy(alpha = 0.04f)))).border(1.dp, tint.copy(alpha = 0.32f), RoundedCornerShape(10.dp)), contentAlignment = Alignment.Center) {
        Icon(icon, null, Modifier.size(size * 0.5f), tint = tint)
    }
}

/** `#code-input`-style field: ink well, mono text, accent focus ring. */
@Composable
fun InkField(
    value: String, onValueChange: (String) -> Unit, placeholder: String, modifier: Modifier = Modifier,
    error: Boolean = false, onGo: () -> Unit = {}, trailing: (@Composable () -> Unit)? = null, description: String = placeholder,
) {
    val source = remember { MutableInteractionSource() }
    val focused by source.collectIsFocusedAsState()
    val border by animateColorAsState(when { error -> Cd.danger; focused -> Cd.accent; else -> Cd.line }, label = "f")
    val ring by animateDpAsState(if (focused && !error) 3.dp else 0.dp, label = "r")
    val shape = RoundedCornerShape(10.dp)
    BasicTextField(
        value = value, onValueChange = onValueChange, interactionSource = source,
        modifier = modifier.fillMaxWidth().semantics { contentDescription = description },
        textStyle = TextStyle(fontFamily = Mono, fontSize = 15.sp, lineHeight = 21.sp, color = Cd.text),
        cursorBrush = SolidColor(Cd.accent), maxLines = 3,
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, imeAction = ImeAction.Go, autoCorrectEnabled = false),
        keyboardActions = KeyboardActions(onGo = { onGo() }),
        decorationBox = { inner ->
            Row(
                Modifier.border(ring, Cd.accent.copy(alpha = 0.15f), RoundedCornerShape(10.dp + ring)).padding(ring)
                    .clip(shape).background(Cd.ink).border(1.dp, border, shape).heightIn(min = 56.dp).padding(start = 16.dp, end = 6.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Box(Modifier.weight(1f).padding(vertical = 14.dp)) {
                    if (value.isEmpty()) Text(placeholder, style = TextStyle(fontFamily = Mono, fontSize = 15.sp, color = Cd.faint.copy(alpha = 0.6f), letterSpacing = 0.04.em), maxLines = 1)
                    inner()
                }
                trailing?.invoke()
            }
        },
    )
}

/* ---------- progress ---------- */

/** `.progress-bar` with the gradient fill and the moving glint. [fraction] should already be animated. */
@Composable
fun ProgressTrack(fraction: Float, modifier: Modifier = Modifier, height: Dp = 8.dp, glint: Boolean = true, color: Color = Cd.accent) {
    val glintX = if (glint) {
        val t = rememberInfiniteTransition(label = "glint")
        t.animateFloat(-1f, 1f, infiniteRepeatable(tween(2600, easing = FastOutSlowInEasing)), label = "g").value
    } else -2f
    Canvas(modifier.fillMaxWidth().height(height)) {
        val r = CornerRadius(size.height / 2)
        drawRoundRect(Cd.ink, cornerRadius = r)
        drawRoundRect(Cd.line, cornerRadius = r, style = Stroke(1.dp.toPx()))
        val w = size.width * fraction.coerceIn(0f, 1f)
        if (w > 0f) {
            drawRoundRect(Brush.horizontalGradient(listOf(lerp(Cd.accentSoft, color, 0.15f), color), endX = size.width.coerceAtLeast(w)), size = Size(w.coerceAtLeast(size.height), size.height), cornerRadius = r)
            if (glintX > -1.5f) {
                val gx = w * (glintX + 1) / 2
                drawRoundRect(Brush.horizontalGradient(listOf(Color.Transparent, Color(0x52FFE4BF), Color.Transparent), startX = gx - w * 0.2f, endX = gx + w * 0.2f), size = Size(w.coerceAtLeast(size.height), size.height), cornerRadius = r)
            }
        }
    }
}

/** `.result-mark` square with an icon, popping in like the site's mark-in. */
@Composable
fun ResultMark(icon: ImageVector, tone: Tone, modifier: Modifier = Modifier, size: Dp = 52.dp) {
    var shown by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) { shown = true }
    val s by animateFloatAsState(if (shown) 1f else 0.7f, tween(450, easing = EaseOutSoft), label = "mark")
    val c = when (tone) { Tone.SUCCESS -> Cd.success; Tone.DANGER -> Cd.danger; else -> Cd.accent }
    val bg = when (tone) { Tone.DANGER -> Color(0x995A160B); else -> Color.Transparent }
    Box(
        modifier.size(size).graphicsLayer { scaleX = s; scaleY = s; alpha = s }.clip(RoundedCornerShape(8.dp)).background(bg)
            .border(BorderStroke(1.dp, c.copy(alpha = 0.45f)), RoundedCornerShape(8.dp)),
        contentAlignment = Alignment.Center,
    ) { Icon(icon, null, Modifier.size(size * 0.44f), tint = c) }
}

@Composable
fun Spinner(modifier: Modifier = Modifier, size: Dp = 22.dp) {
    val t = rememberInfiniteTransition(label = "spin")
    val angle by t.animateFloat(0f, 360f, infiniteRepeatable(tween(800, easing = LinearEasing)), label = "a")
    Canvas(modifier.size(size)) {
        val w = 2.dp.toPx()
        drawCircle(Cd.line, style = Stroke(w), radius = this.size.minDimension / 2 - w / 2)
        drawArc(Cd.accent, angle, 90f, false, topLeft = Offset(w / 2, w / 2), size = Size(this.size.width - w, this.size.height - w), style = Stroke(w, cap = StrokeCap.Round))
    }
}

@Composable
fun Chip(text: String, icon: ImageVector?, tone: Color = Cd.accent, modifier: Modifier = Modifier) {
    Row(
        modifier.clip(RoundedCornerShape(6.dp)).background(tone.copy(alpha = 0.12f)).border(1.dp, tone.copy(alpha = 0.28f), RoundedCornerShape(6.dp)).padding(horizontal = 8.dp, vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(5.dp),
    ) {
        if (icon != null) Icon(icon, null, Modifier.size(13.dp), tint = tone)
        Text(text.uppercase(), style = CdType.kicker.copy(color = tone, fontSize = 10.sp, letterSpacing = 0.06.em))
    }
}

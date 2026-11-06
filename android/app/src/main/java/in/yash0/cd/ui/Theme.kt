package `in`.yash0.cd.ui

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.material3.LocalContentColor
import androidx.compose.foundation.text.selection.LocalTextSelectionColors
import androidx.compose.foundation.text.selection.TextSelectionColors
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import `in`.yash0.cd.R

/** Design tokens copied from the website's `src/style.css` :root block. Dark only, like the site. */
object Cd {
    val bg = Color(0xFF0D0503)
    val panel = Color(0xFF160907)
    val workbench = Color(0xFF180A07)
    val workbenchTab = Color(0xFF1E0D09)
    val block = Color(0xFF1B0D09)
    val ink = Color(0xFF070707)
    val text = Color(0xFFE4D4B6)
    val muted = Color(0xFFB3A38C)
    val faint = Color(0xFFA28F79)
    val accent = Color(0xFFE58A57)
    val accentHi = Color(0xFFF0A073)
    val accentSoft = Color(0xFF6B2F1C)
    val line = Color(0x26E4D4B6)          // rgba(228,212,182,.15)
    val lineSoft = Color(0x1AE4D4B6)      // rgba(228,212,182,.10)
    val success = Color(0xFF7FD18B)
    val danger = Color(0xFFFF8A62)
    val dangerStrong = Color(0xFFFF5D2A)
    val dangerText = Color(0xFFFFB08F)
    val live = Color(0xFF4ADE80)
    val headerTop = Color(0xFF1B0603)
    val headerMid = Color(0xFF120504)
}

val Inter = FontFamily(
    Font(R.font.inter_regular, FontWeight.Normal),
    Font(R.font.inter_medium, FontWeight.Medium),
    Font(R.font.inter_semibold, FontWeight.SemiBold),
    Font(R.font.inter_bold, FontWeight.Bold),
)
val Mono = FontFamily(
    Font(R.font.jetbrains_mono_regular, FontWeight.Normal),
    Font(R.font.jetbrains_mono_medium, FontWeight.Medium),
    Font(R.font.jetbrains_mono_bold, FontWeight.Bold),
)

object CdType {
    /** The `cd` wordmark is a serif on the site (Georgia); Android's serif is the closest system match. */
    val brand = TextStyle(fontFamily = FontFamily.Serif, fontSize = 30.sp, lineHeight = 32.sp, letterSpacing = (-0.055).em, color = Cd.text)
    val brandLarge = brand.copy(fontSize = 56.sp, lineHeight = 56.sp)
    val intro = TextStyle(fontFamily = Inter, fontWeight = FontWeight.Medium, fontSize = 24.sp, lineHeight = 30.sp, letterSpacing = (-0.03).em, color = Cd.text)
    val largeTitle = TextStyle(fontFamily = Inter, fontWeight = FontWeight.SemiBold, fontSize = 30.sp, lineHeight = 36.sp, letterSpacing = (-0.03).em, color = Cd.text)
    val barTitle = TextStyle(fontFamily = Inter, fontWeight = FontWeight.SemiBold, fontSize = 18.sp, lineHeight = 24.sp, letterSpacing = (-0.01).em, color = Cd.text)
    val title = TextStyle(fontFamily = Inter, fontWeight = FontWeight.SemiBold, fontSize = 22.sp, lineHeight = 28.sp, letterSpacing = (-0.02).em, color = Cd.text)
    val screenTitle = largeTitle
    val body = TextStyle(fontFamily = Inter, fontSize = 16.sp, lineHeight = 24.sp, color = Cd.text)
    val bodyMuted = body.copy(color = Cd.muted)
    val small = TextStyle(fontFamily = Inter, fontSize = 14.sp, lineHeight = 20.sp, color = Cd.muted)
    val label = TextStyle(fontFamily = Inter, fontWeight = FontWeight.SemiBold, fontSize = 16.sp, lineHeight = 20.sp, color = Cd.text)
    val rowTitle = TextStyle(fontFamily = Inter, fontWeight = FontWeight.Medium, fontSize = 17.sp, lineHeight = 22.sp, color = Cd.text)
    /** Sentence-case section header; replaces most mono micro-labels on phone screens. */
    val section = TextStyle(fontFamily = Inter, fontWeight = FontWeight.SemiBold, fontSize = 14.sp, lineHeight = 20.sp, color = Cd.faint)
    val kicker = TextStyle(fontFamily = Mono, fontSize = 12.sp, lineHeight = 16.sp, letterSpacing = 0.08.em, color = Cd.faint)
    val mono = TextStyle(fontFamily = Mono, fontSize = 15.sp, lineHeight = 22.sp, color = Cd.text)
    val monoSmall = TextStyle(fontFamily = Mono, fontSize = 14.sp, lineHeight = 20.sp, color = Cd.muted)
    val code = TextStyle(fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = 52.sp, lineHeight = 56.sp, letterSpacing = 0.14.em, color = Cd.accent)
}

@Composable
fun CdTheme(content: @Composable () -> Unit) {
    // Material components (Switch, text field cursor, dialogs) take every color from this scheme,
    // so nothing falls back to Material purple.
    val scheme = darkColorScheme(
        primary = Cd.accent, onPrimary = Cd.bg, primaryContainer = Cd.accentSoft, onPrimaryContainer = Cd.text,
        secondary = Cd.muted, onSecondary = Cd.bg, secondaryContainer = Cd.block, onSecondaryContainer = Cd.text,
        tertiary = Cd.success, onTertiary = Cd.bg,
        background = Cd.bg, onBackground = Cd.text, surface = Cd.panel, onSurface = Cd.text,
        surfaceVariant = Cd.block, onSurfaceVariant = Cd.muted, surfaceTint = Cd.accent,
        surfaceContainer = Cd.panel, surfaceContainerHigh = Cd.workbenchTab, surfaceContainerHighest = Cd.block,
        surfaceContainerLow = Cd.workbench, surfaceContainerLowest = Cd.bg, surfaceBright = Cd.workbenchTab, surfaceDim = Cd.bg,
        inverseSurface = Cd.text, inverseOnSurface = Cd.bg, inversePrimary = Cd.accentSoft,
        outline = Cd.line, outlineVariant = Cd.lineSoft, error = Cd.danger, onError = Cd.bg,
        errorContainer = Color(0xFF5A160B), onErrorContainer = Cd.dangerText, scrim = Color(0xCC000000),
    )
    MaterialTheme(colorScheme = scheme) {
        CompositionLocalProvider(
            LocalContentColor provides Cd.text,
            LocalTextSelectionColors provides TextSelectionColors(handleColor = Cd.accent, backgroundColor = Cd.accentSoft),
            content = content,
        )
    }
}

package `in`.yash0.cd.ui

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.unit.dp

/**
 * Stroke icons in the website's style: 24-unit viewBox, 2px round strokes, no fills.
 * Drawn from path strings so the app needs no icon library.
 */
object CdIcons {
    private fun icon(name: String, vararg paths: String, width: Float = 2f): ImageVector =
        ImageVector.Builder(name = name, defaultWidth = 24.dp, defaultHeight = 24.dp, viewportWidth = 24f, viewportHeight = 24f).apply {
            paths.forEach { d ->
                addPath(
                    pathData = PathParser().parsePathString(d).toNodes(),
                    stroke = SolidColor(Color.Black), strokeLineWidth = width,
                    strokeLineCap = StrokeCap.Round, strokeLineJoin = StrokeJoin.Round,
                )
            }
        }.build()

    val ArrowUp by lazy { icon("up", "M12 19V5", "M6 11l6-6 6 6") }
    val ArrowDown by lazy { icon("down", "M12 5v14", "M6 13l6 6 6-6") }
    val Upload by lazy { icon("upload", "M12 16V4", "M6.5 9.5L12 4l5.5 5.5", "M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3") }
    val Back by lazy { icon("back", "M15 18l-6-6 6-6") }
    val Chevron by lazy { icon("chevron", "M9 6l6 6-6 6") }
    val Close by lazy { icon("close", "M7 7l10 10", "M17 7L7 17") }
    val Check by lazy { icon("check", "M5 12.5l4.5 4.5L19 7.5") }
    val Copy by lazy { icon("copy", "M9 9h10a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V10a1 1 0 0 1 1-1z", "M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1") }
    val Share by lazy { icon("share", "M12 3v12", "M7.5 7.5L12 3l4.5 4.5", "M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7") }
    val Pause by lazy { icon("pause", "M9 6v12", "M15 6v12", width = 2.4f) }
    val Play by lazy { icon("play", "M8 5.5v13l10.5-6.5z") }
    val Scan by lazy { icon("scan", "M4 8V6a2 2 0 0 1 2-2h2", "M16 4h2a2 2 0 0 1 2 2v2", "M20 16v2a2 2 0 0 1-2 2h-2", "M8 20H6a2 2 0 0 1-2-2v-2", "M8 12h8") }
    val Paste by lazy { icon("paste", "M9 4h6v3H9z", "M15 5h2a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2") }
    val Laptop by lazy { icon("laptop", "M5 6a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v9H5z", "M2.5 19h19") }
    val Settings by lazy { icon("settings", "M4 7h10", "M18 7h2", "M4 17h2", "M10 17h10", "M16 5v4", "M8 15v4") }
    val Devices by lazy { icon("devices", "M3 6a1 1 0 0 1 1-1h11a1 1 0 0 1 1 1v8H3z", "M1.5 18h13", "M19 9h2.5a.5.5 0 0 1 .5.5v9a.5.5 0 0 1-.5.5H19a.5.5 0 0 1-.5-.5v-9A.5.5 0 0 1 19 9z") }
    val History by lazy { icon("history", "M3.5 12a8.5 8.5 0 1 0 2.5-6", "M3 4v4h4", "M12 8v4l3 2") }
    val Open by lazy { icon("open", "M14 4h6v6", "M20 4l-9 9", "M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4") }
    val Retry by lazy { icon("retry", "M20 12a8 8 0 1 1-2.3-5.6", "M20 4v4h-4") }
    val Link by lazy { icon("link", "M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1", "M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1") }
    val Wifi by lazy { icon("wifi", "M2.5 9a14 14 0 0 1 19 0", "M5.5 12.5a9.5 9.5 0 0 1 13 0", "M8.8 16a4.8 4.8 0 0 1 6.4 0", "M12 19.5h.01") }
    val Relay by lazy { icon("relay", "M7 18a4.5 4.5 0 0 1-.5-9 6 6 0 0 1 11.5 1.5A3.75 3.75 0 0 1 17.5 18z") }
    val Bolt by lazy { icon("bolt", "M13 3L5 13.5h6L10 21l8-10.5h-6z") }
    val File by lazy { icon("file", "M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z", "M14 3v5h5") }
    val Terminal by lazy { icon("terminal", "M4 6l5 5-5 5", "M11 18h9") }
    val Battery by lazy { icon("battery", "M3 8a2 2 0 0 1 2-2h11a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z", "M21 10.5v3", "M7 10l-1.5 2h3L7 14") }
    val Signal by lazy { icon("signal", "M4 20v-3", "M9 20v-7", "M14 20v-11", "M19 20V5") }
    val Bell by lazy { icon("bell", "M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15z", "M10 20.5a2 2 0 0 0 4 0") }
    val Shield by lazy { icon("shield", "M12 3l7.5 3v5.5c0 4.5-3.2 8.2-7.5 9.5-4.3-1.3-7.5-5-7.5-9.5V6z", "M9 12l2 2 4-4") }
}

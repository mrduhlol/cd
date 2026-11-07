package `in`.yash0.cd.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.background
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawWithCache
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.geometry.RoundRect
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import com.google.zxing.BarcodeFormat
import com.google.zxing.EncodeHintType
import com.google.zxing.common.BitMatrix
import com.google.zxing.qrcode.QRCodeWriter
import com.google.zxing.qrcode.decoder.ErrorCorrectionLevel

/**
 * QR of [content] in the website's colors: #0d0503 modules on a #e4d4b6 card (see renderQr in src/main.js).
 * The matrix is encoded once per [content] and the module path is built once per size, so scrolling,
 * progress ticks and recomposition only replay a cached path instead of re-encoding or redrawing ~1500 shapes.
 */
@Composable
fun QrCode(content: String, modifier: Modifier = Modifier) {
    val matrix: BitMatrix? = remember(content) {
        runCatching { QRCodeWriter().encode(content, BarcodeFormat.QR_CODE, 0, 0, mapOf(EncodeHintType.MARGIN to 0, EncodeHintType.ERROR_CORRECTION to ErrorCorrectionLevel.M)) }.getOrNull()
    }
    // Remembered per matrix so the draw cache survives recomposition and is rebuilt only on resize or a new link.
    val modules = remember(matrix) {
        Modifier.fillMaxSize().drawWithCache {
            val path = Path()
            val m = matrix
            if (m != null && m.width > 0) {
                val cell = size.minDimension / m.width
                // Rounded modules read softer and still scan; finder patterns stay square for reliability.
                val r = CornerRadius(cell * 0.28f)
                for (y in 0 until m.height) for (x in 0 until m.width) if (m.get(x, y)) {
                    val finder = (x < 7 && y < 7) || (x >= m.width - 7 && y < 7) || (x < 7 && y >= m.height - 7)
                    if (finder) path.addRect(Rect(x * cell, y * cell, x * cell + cell + 0.5f, y * cell + cell + 0.5f))
                    else path.addRoundRect(RoundRect(x * cell + cell * 0.04f, y * cell + cell * 0.04f, x * cell + cell * 0.96f, y * cell + cell * 0.96f, r))
                }
            }
            onDrawBehind { drawPath(path, Cd.bg) }
        }
    }
    Box(modifier.clip(RoundedCornerShape(14.dp)).background(Cd.text).padding(14.dp).semantics { contentDescription = "QR code that opens this transfer" }) {
        Box(modules)
    }
}

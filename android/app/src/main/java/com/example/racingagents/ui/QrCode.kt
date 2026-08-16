package com.example.racingagents.ui

import android.graphics.Bitmap
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import com.google.zxing.BarcodeFormat
import com.google.zxing.EncodeHintType
import com.google.zxing.qrcode.QRCodeWriter

/** Renders [text] as a QR code bitmap, or null if encoding fails (e.g. empty/malformed input) —
 * callers should fall back to an error message rather than crash. */
fun textToQrCodeBitmap(text: String, size: Int): ImageBitmap? = runCatching {
    val matrix = QRCodeWriter().encode(text, BarcodeFormat.QR_CODE, size, size, mapOf(EncodeHintType.MARGIN to 1))
    val bitmap = Bitmap.createBitmap(matrix.width, matrix.height, Bitmap.Config.ARGB_8888)
    for (x in 0 until matrix.width) {
        for (y in 0 until matrix.height) {
            bitmap.setPixel(x, y, if (matrix.get(x, y)) android.graphics.Color.BLACK else android.graphics.Color.WHITE)
        }
    }
    bitmap.asImageBitmap()
}.getOrNull()

/** Remembers the QR bitmap for [text]/[size], regenerating only when either changes rather than
 * on every recomposition (encoding is cheap but not free enough to redo per-frame). */
@Composable
fun rememberQrCodeBitmap(text: String, size: Int): ImageBitmap? =
    remember(text, size) { textToQrCodeBitmap(text, size) }

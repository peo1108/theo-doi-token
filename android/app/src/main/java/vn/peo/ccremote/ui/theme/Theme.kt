package vn.peo.ccremote.ui.theme

import android.os.Build
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.dynamicDarkColorScheme
import androidx.compose.material3.dynamicLightColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext

// Màu cam đất của icon (#DE7D5C -> #B0523A) làm màu chủ đạo khi máy không có màu động (Android < 12).
private val LightFallback = lightColorScheme(
    primary = Color(0xFFB0523A),
    onPrimary = Color(0xFFFFFFFF),
    primaryContainer = Color(0xFFFFDBD0),
    onPrimaryContainer = Color(0xFF3B0A00),
    secondary = Color(0xFF77574D),
    onSecondary = Color(0xFFFFFFFF),
    secondaryContainer = Color(0xFFFFDBD0),
    onSecondaryContainer = Color(0xFF2C150E),
    tertiary = Color(0xFF6B5E2F),
    background = Color(0xFFFFFBF8),
    onBackground = Color(0xFF211A18),
    surface = Color(0xFFFFFBF8),
    onSurface = Color(0xFF211A18),
    surfaceVariant = Color(0xFFF5DED7),
    onSurfaceVariant = Color(0xFF53433F),
    outline = Color(0xFF85736E),
    outlineVariant = Color(0xFFD8C2BC),
    error = Color(0xFFBA1A1A),
)

private val DarkFallback = darkColorScheme(
    primary = Color(0xFFFFB5A0),
    onPrimary = Color(0xFF5F1500),
    primaryContainer = Color(0xFF8A3A24),
    onPrimaryContainer = Color(0xFFFFDBD0),
    secondary = Color(0xFFE7BDB1),
    onSecondary = Color(0xFF442A21),
    secondaryContainer = Color(0xFF5D4037),
    onSecondaryContainer = Color(0xFFFFDBD0),
    tertiary = Color(0xFFD7C68D),
    background = Color(0xFF1A1614),
    onBackground = Color(0xFFEDE0DC),
    surface = Color(0xFF1A1614),
    onSurface = Color(0xFFEDE0DC),
    surfaceVariant = Color(0xFF53433F),
    onSurfaceVariant = Color(0xFFD8C2BC),
    outline = Color(0xFFA08C87),
    outlineVariant = Color(0xFF53433F),
    error = Color(0xFFFFB4AB),
)

@Composable
fun CCRemoteTheme(dark: Boolean = isSystemInDarkTheme(), content: @Composable () -> Unit) {
    val ctx = LocalContext.current
    val scheme = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        if (dark) dynamicDarkColorScheme(ctx) else dynamicLightColorScheme(ctx)
    } else if (dark) DarkFallback else LightFallback
    MaterialTheme(colorScheme = scheme, content = content)
}

/** Màu trạng thái (xanh dương / cam / xanh lá / xám) giống iOS, chỉnh theo sáng / tối. */
object Semantic {
    @Composable @ReadOnlyComposable
    fun blue(): Color = if (isSystemInDarkTheme()) Color(0xFF8AB4F8) else Color(0xFF1A73E8)

    @Composable @ReadOnlyComposable
    fun orange(): Color = if (isSystemInDarkTheme()) Color(0xFFFFB74D) else Color(0xFFE65100)

    @Composable @ReadOnlyComposable
    fun green(): Color = if (isSystemInDarkTheme()) Color(0xFF81C995) else Color(0xFF1E8E3E)

    @Composable @ReadOnlyComposable
    fun red(): Color = if (isSystemInDarkTheme()) Color(0xFFF28B82) else Color(0xFFD93025)

    @Composable @ReadOnlyComposable
    fun gray(): Color = MaterialTheme.colorScheme.onSurfaceVariant

    /** màu chữ `code` inline như VS Code */
    @Composable @ReadOnlyComposable
    fun code(): Color = if (isSystemInDarkTheme()) Color(0xFFE8956F) else Color(0xFFB9532E)
}


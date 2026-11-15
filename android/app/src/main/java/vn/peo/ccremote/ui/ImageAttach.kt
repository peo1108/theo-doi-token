package vn.peo.ccremote.ui

import android.content.ClipboardManager
import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.ImageDecoder
import android.graphics.Matrix
import android.media.ExifInterface
import android.net.Uri
import android.os.Build
import android.util.Base64
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AttachFile
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.outlined.ContentPaste
import androidx.compose.material.icons.outlined.PhotoCamera
import androidx.compose.material.icons.outlined.PhotoLibrary
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshots.SnapshotStateList
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.core.content.FileProvider
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonObject
import vn.peo.ccremote.data.Prefs
import vn.peo.ccremote.data.jsonOf
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.UUID

/** Ảnh đang đính kèm trong ô nhắn (chưa gửi): file đã chép vào cache + ảnh xem trước nhỏ. */
@Stable
class PickedImage(val file: File, val preview: Bitmap) {
    val id: String = UUID.randomUUID().toString()
}

object ImagePrep {
    const val MAX_SIDE = 2000
    const val THUMB_SIDE = 256
    const val MAX_COUNT = 10

    /** Chép ảnh từ uri vào cache (uri của clipboard / picker có thể hết quyền) rồi dựng ảnh xem trước. */
    suspend fun fromUri(ctx: Context, uri: Uri): PickedImage? = withContext(Dispatchers.IO) {
        try {
            val dir = File(ctx.cacheDir, "picks").apply { mkdirs() }
            val f = File(dir, UUID.randomUUID().toString())
            ctx.contentResolver.openInputStream(uri)?.use { i -> f.outputStream().use { o -> i.copyTo(o) } } ?: return@withContext null
            fromFile(f)
        } catch (_: Exception) {
            null
        }
    }

    fun fromFile(f: File): PickedImage? {
        val prev = decode(f, THUMB_SIDE * 2) ?: return null
        return PickedImage(f, prev)
    }

    /**
     * Ảnh -> bitmap đã xoay đúng chiều EXIF, cạnh dài ≤ maxSide (maxSide = 0: giữ nguyên cỡ).
     * Nặng (vài trăm ms mỗi ảnh lớn): gọi từ luồng nền.
     */
    fun decode(f: File, maxSide: Int): Bitmap? = try {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            ImageDecoder.decodeBitmap(ImageDecoder.createSource(f)) { decoder, info, _ ->
                decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
                val w = info.size.width
                val h = info.size.height
                val scale = if (maxSide > 0) minOf(1.0, maxSide.toDouble() / maxOf(w, h, 1)) else 1.0
                if (scale < 1.0) decoder.setTargetSize((w * scale).toInt().coerceAtLeast(1), (h * scale).toInt().coerceAtLeast(1))
            }
        } else {
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeFile(f.path, bounds)
            var sample = 1
            if (maxSide > 0) while (maxOf(bounds.outWidth, bounds.outHeight) / (sample * 2) >= maxSide) sample *= 2
            val raw = BitmapFactory.decodeFile(f.path, BitmapFactory.Options().apply { inSampleSize = sample })
            if (raw == null) null else {
                val rot = when (ExifInterface(f.path).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)) {
                    ExifInterface.ORIENTATION_ROTATE_90 -> 90f
                    ExifInterface.ORIENTATION_ROTATE_180 -> 180f
                    ExifInterface.ORIENTATION_ROTATE_270 -> 270f
                    else -> 0f
                }
                val scale = if (maxSide > 0) minOf(1.0, maxSide.toDouble() / maxOf(raw.width, raw.height)) else 1.0
                val m = Matrix().apply { if (rot != 0f) postRotate(rot); if (scale < 1.0) postScale(scale.toFloat(), scale.toFloat()) }
                if (rot == 0f && scale >= 1.0) raw else Bitmap.createBitmap(raw, 0, 0, raw.width, raw.height, m, true)
            }
        }
    } catch (_: Throwable) {
        null
    }

    private fun flatten(b: Bitmap): Bitmap {
        if (!b.hasAlpha()) return b
        val out = Bitmap.createBitmap(b.width, b.height, Bitmap.Config.ARGB_8888)
        Canvas(out).apply { drawColor(android.graphics.Color.WHITE); drawBitmap(b, 0f, 0f, null) }
        return out
    }

    private fun jpegBase64(b: Bitmap, quality: Int): String {
        val bos = ByteArrayOutputStream()
        flatten(b).compress(Bitmap.CompressFormat.JPEG, quality, bos)
        return Base64.encodeToString(bos.toByteArray(), Base64.NO_WRAP)
    }

    /** Ảnh -> JPEG base64 + ảnh nhỏ (cạnh dài ≤ 2000 px trừ khi bật "Gửi ảnh gốc"): {mime, data, name, thumb}. */
    fun payload(f: File, index: Int): JsonObject? {
        val original = Prefs.sendOriginal
        val full = decode(f, if (original) 0 else MAX_SIDE) ?: return null
        val thumbBmp = if (maxOf(full.width, full.height) <= THUMB_SIDE) full else {
            val s = THUMB_SIDE.toDouble() / maxOf(full.width, full.height)
            Bitmap.createScaledBitmap(full, (full.width * s).toInt().coerceAtLeast(1), (full.height * s).toInt().coerceAtLeast(1), true)
        }
        return jsonOf(
            "mime" to "image/jpeg",
            "data" to jpegBase64(full, if (original) 95 else 85),
            "name" to "anh-${index + 1}.jpg",
            "thumb" to jpegBase64(thumbBmp, 60),
        )
    }

    /** Nén ở luồng nền: ảnh chụp 12 MP nén trên luồng giao diện làm app khựng cả giây. */
    suspend fun payloads(ctx: Context, picks: List<PickedImage>): List<JsonObject> = withContext(Dispatchers.Default) {
        picks.mapIndexedNotNull { i, p -> payload(p.file, i) }
    }
}

/** Ba nguồn ảnh: thư viện (Photo Picker), chụp ảnh (TakePicture + FileProvider), dán từ clipboard. */
@Stable
class ImagePickers(
    private val ctx: Context,
    private val picks: SnapshotStateList<PickedImage>,
    val openGallery: () -> Unit,
    val openCamera: () -> Unit,
    private val scopeLaunch: (suspend () -> Unit) -> Unit,
) {
    fun hasClipImage(): Boolean {
        val cm = ctx.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager ?: return false
        val d = cm.primaryClipDescription ?: return false
        return d.hasMimeType("image/*")
    }

    fun paste() {
        val cm = ctx.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager ?: return
        val clip = cm.primaryClip ?: return
        val uris = (0 until clip.itemCount).mapNotNull { clip.getItemAt(it).uri }
        scopeLaunch {
            for (u in uris) if (picks.size < ImagePrep.MAX_COUNT) ImagePrep.fromUri(ctx, u)?.let { picks.add(it) }
        }
    }
}

@Composable
fun rememberImagePickers(picks: SnapshotStateList<PickedImage>): ImagePickers {
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    val gallery = rememberLauncherForActivityResult(ActivityResultContracts.PickMultipleVisualMedia(ImagePrep.MAX_COUNT)) { uris ->
        scope.launch {
            for (u in uris) if (picks.size < ImagePrep.MAX_COUNT) ImagePrep.fromUri(ctx, u)?.let { picks.add(it) }
        }
    }
    var cameraFile by remember { mutableStateOf<File?>(null) }
    val camera = rememberLauncherForActivityResult(ActivityResultContracts.TakePicture()) { ok ->
        val f = cameraFile
        cameraFile = null
        if (f != null) {
            if (ok) scope.launch { withContext(Dispatchers.IO) { ImagePrep.fromFile(f) }?.let { if (picks.size < ImagePrep.MAX_COUNT) picks.add(it) } }
        }
    }
    return remember(ctx, picks) {
        ImagePickers(
            ctx, picks,
            openGallery = { gallery.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)) },
            openCamera = {
                val dir = File(ctx.cacheDir, "camera").apply { mkdirs() }
                val f = File(dir, "${UUID.randomUUID()}.jpg")
                cameraFile = f
                camera.launch(FileProvider.getUriForFile(ctx, ctx.packageName + ".files", f))
            },
            scopeLaunch = { block -> scope.launch { block() } },
        )
    }
}

/** Nút 📎: thư viện ảnh, chụp ảnh, dán ảnh. */
@Composable
fun AttachButton(pickers: ImagePickers, picks: List<PickedImage>, enabled: Boolean = true) {
    var open by remember { mutableStateOf(false) }
    Box {
        IconButton(onClick = { open = true }, enabled = enabled && picks.size < ImagePrep.MAX_COUNT) {
            Icon(Icons.Filled.AttachFile, contentDescription = "Đính kèm ảnh")
        }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            DropdownMenuItem(
                text = { androidx.compose.material3.Text("Thư viện ảnh") }, leadingIcon = { Icon(Icons.Outlined.PhotoLibrary, null) },
                onClick = { open = false; pickers.openGallery() },
            )
            DropdownMenuItem(
                text = { androidx.compose.material3.Text("Chụp ảnh") }, leadingIcon = { Icon(Icons.Outlined.PhotoCamera, null) },
                onClick = { open = false; pickers.openCamera() },
            )
            if (pickers.hasClipImage()) {
                DropdownMenuItem(
                    text = { androidx.compose.material3.Text("Dán ảnh") }, leadingIcon = { Icon(Icons.Outlined.ContentPaste, null) },
                    onClick = { open = false; pickers.paste() },
                )
            }
        }
    }
}

/** Dải ảnh đã chọn phía trên ô nhắn (bấm × để bỏ). */
@Composable
fun AttachmentStrip(picks: SnapshotStateList<PickedImage>, modifier: Modifier = Modifier) {
    if (picks.isEmpty()) return
    LazyRow(modifier.padding(horizontal = 14.dp, vertical = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        items(picks.toList(), key = { it.id }) { p ->
            Box {
                Image(
                    p.preview.asImageBitmap(), contentDescription = "Ảnh đính kèm", contentScale = ContentScale.Crop,
                    modifier = Modifier.size(58.dp).clip(RoundedCornerShape(8.dp)),
                )
                Box(
                    Modifier.align(Alignment.TopEnd).padding(2.dp).size(20.dp).clip(CircleShape).background(Color.Black.copy(alpha = 0.6f)),
                    contentAlignment = Alignment.Center,
                ) {
                    IconButton(onClick = { picks.remove(p) }, Modifier.size(20.dp)) {
                        Icon(Icons.Filled.Close, contentDescription = "Bỏ ảnh", tint = Color.White, modifier = Modifier.size(14.dp))
                    }
                }
            }
        }
    }
}

/** Dải ảnh + nút đính kèm dùng trong form (phiên mới). */
@Composable
fun AttachmentBar(picks: SnapshotStateList<PickedImage>, enabled: Boolean = true) {
    val pickers = rememberImagePickers(picks)
    Row(verticalAlignment = Alignment.CenterVertically) {
        AttachButton(pickers, picks, enabled)
        androidx.compose.material3.Text(
            if (picks.isEmpty()) "Đính kèm ảnh (tối đa ${ImagePrep.MAX_COUNT})" else "${picks.size}/${ImagePrep.MAX_COUNT} ảnh",
            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
    AttachmentStrip(picks, Modifier.padding(horizontal = 0.dp))
}

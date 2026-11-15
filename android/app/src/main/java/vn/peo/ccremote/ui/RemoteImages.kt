package vn.peo.ccremote.ui

import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.util.Base64
import android.util.LruCache
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.detectTransformGestures
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Share
import androidx.compose.material.icons.outlined.Image
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.core.content.FileProvider
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import vn.peo.ccremote.AppModel
import vn.peo.ccremote.data.ApiClient
import vn.peo.ccremote.data.EventImage
import vn.peo.ccremote.data.ImageData
import vn.peo.ccremote.data.jsonOf
import java.io.File

/**
 * Ảnh lấy từ máy tính (sessions.image). Giữ dữ liệu nén và ảnh thu nhỏ, mỗi loại tối đa 40 MB; ảnh cỡ gốc chỉ giải mã khi
 * mở xem. Nhiều nơi cùng hỏi một ảnh thì chỉ tải một lần. Phần giải mã nặng chạy ngoài luồng chính -> cuộn không giật.
 */
object RemoteImages {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val blobs = object : LruCache<String, ByteArray>(40 shl 20) {
        override fun sizeOf(key: String, value: ByteArray) = value.size
    }
    private val thumbs = object : LruCache<String, Bitmap>(40 shl 20) {
        override fun sizeOf(key: String, value: Bitmap) = value.byteCount
    }
    private val inflight = HashMap<String, Deferred<ByteArray?>>()

    /** ảnh nhỏ kèm sự kiện không giải mã được -> nhớ để không giải mã lại mỗi lần vẽ */
    private val badThumbs = HashSet<String>()

    private suspend fun data(api: ApiClient, sessionId: String, name: String): ByteArray? {
        val key = "$sessionId/$name"
        blobs.get(key)?.let { return it }
        val d = inflight.getOrPut(key) {
            scope.async {
                try {
                    val r: ImageData = api.call("sessions.image", jsonOf("id" to sessionId, "name" to name))
                    withContext(Dispatchers.Default) { Base64.decode(r.data, Base64.DEFAULT) }
                } catch (e: kotlinx.coroutines.CancellationException) {
                    throw e
                } catch (_: Exception) {
                    null
                }
            }
        }
        val bytes = d.await()
        inflight.remove(key)
        if (bytes != null) blobs.put(key, bytes)
        return bytes
    }

    private fun thumbKey(sessionId: String, name: String, maxPixel: Int) = "$sessionId/$name@$maxPixel"

    fun cachedThumb(sessionId: String, name: String, maxPixel: Int): Bitmap? = thumbs.get(thumbKey(sessionId, name, maxPixel))

    /** Ảnh nhỏ có sẵn trong sự kiện (điện thoại gửi): giải mã một lần rồi nhớ. Rỗng / hỏng -> null (nhớ luôn lần hỏng). */
    fun inlineThumb(sessionId: String, name: String, base64: String): Bitmap? {
        val key = thumbKey(sessionId, name, 0)
        thumbs.get(key)?.let { return it }
        if (base64.isEmpty() || key in badThumbs) return null
        val bytes = try { Base64.decode(base64, Base64.DEFAULT) } catch (_: Exception) { null }
        val bmp = bytes?.let { BitmapFactory.decodeByteArray(it, 0, it.size) }
        if (bmp == null) {
            badThumbs.add(key)
            return null
        }
        thumbs.put(key, bmp)
        return bmp
    }

    /** Ảnh thu nhỏ (cạnh dài ≤ maxPixel px), giải mã thẳng ở cỡ nhỏ -> không bung cả bitmap gốc. */
    suspend fun thumb(api: ApiClient, sessionId: String, name: String, maxPixel: Int): Bitmap? {
        cachedThumb(sessionId, name, maxPixel)?.let { return it }
        val d = data(api, sessionId, name) ?: return null
        val bmp = withContext(Dispatchers.Default) { downsample(d, maxPixel) } ?: return null
        thumbs.put(thumbKey(sessionId, name, maxPixel), bmp)
        return bmp
    }

    suspend fun full(api: ApiClient, sessionId: String, name: String): Bitmap? {
        val d = data(api, sessionId, name) ?: return null
        return withContext(Dispatchers.Default) { downsample(d, 4096) }
    }

    fun decodeBase64Thumb(b64: String?): Bitmap? {
        if (b64.isNullOrEmpty()) return null
        return try {
            val bytes = Base64.decode(b64, Base64.DEFAULT)
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
        } catch (_: Exception) {
            null
        }
    }

    private fun downsample(data: ByteArray, maxPixel: Int): Bitmap? {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(data, 0, data.size, bounds)
        if (bounds.outWidth <= 0) return null
        var sample = 1
        while (maxOf(bounds.outWidth, bounds.outHeight) / (sample * 2) >= maxPixel) sample *= 2
        return BitmapFactory.decodeByteArray(data, 0, data.size, BitmapFactory.Options().apply { inSampleSize = sample })
    }
}

/** Khung ô ảnh dùng chung: ảnh phủ kín khung, hoặc vòng quay khi đang tải / biểu tượng ảnh khi lỗi. */
@Composable
private fun ImageTile(image: Bitmap?, loading: Boolean, width: Int, height: Int) {
    Box(
        Modifier.size(width.dp, height.dp).clip(RoundedCornerShape(8.dp)).background(MaterialTheme.colorScheme.surfaceVariant),
        contentAlignment = Alignment.Center,
    ) {
        if (image != null) {
            Image(image.asImageBitmap(), contentDescription = "Ảnh", contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
        } else if (loading) {
            CircularProgressIndicator(Modifier.size(22.dp), strokeWidth = 2.dp)
        } else {
            Icon(Icons.Outlined.Image, null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

/**
 * Ảnh trong lời nhắn hoặc kết quả tool; bấm để xem ảnh đầy đủ.
 * Ảnh gửi từ điện thoại có sẵn ảnh nhỏ; ảnh Claude xem trên máy (Read, chụp màn hình…) và ảnh dán trong VS Code
 * thì không -> tải khi hiện ra.
 */
@Composable
fun EventImages(app: AppModel, images: List<EventImage>, sessionId: String, large: Boolean = false) {
    var shown by remember { mutableStateOf<Bitmap?>(null) }
    var loading by remember { mutableStateOf(false) }
    /** ảnh đang mở: đóng (hoặc mở ảnh khác) trước khi tải xong thì không bật lại */
    var opening by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()

    fun open(im: EventImage) {
        val api = app.api ?: return
        opening = im.name
        // mở ngay bằng ảnh nhỏ đang có; ảnh đầy đủ (ảnh chụp màn hình vài MB, tải vài giây) xong thì thay vào
        shown = im.thumb?.let { RemoteImages.inlineThumb(sessionId, im.name, it) }
            ?: RemoteImages.cachedThumb(sessionId, im.name, 600) ?: RemoteImages.cachedThumb(sessionId, im.name, 216)
        loading = true
        scope.launch {
            val full = RemoteImages.full(api, sessionId, im.name) ?: RemoteImages.decodeBase64Thumb(im.thumb)
            loading = false
            if (opening == im.name && full != null) shown = full
        }
    }

    Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        // cùng một ảnh có thể xuất hiện hai lần (trùng tên) -> định danh theo vị trí
        images.forEachIndexed { idx, im ->
            Box(Modifier.clickable { open(im) }) {
                val inline = im.thumb?.let { RemoteImages.inlineThumb(sessionId, im.name, it) }
                if (inline != null) ImageTile(inline, false, 72, 72)
                else RemoteImageTile(app, im.name, sessionId, large, key = "$idx/${im.name}")
            }
        }
        if (loading && shown == null) CircularProgressIndicator(Modifier.size(24.dp), strokeWidth = 2.dp)
    }

    shown?.let { bmp ->
        ImageViewer(bmp, loading) { shown = null; opening = null }
    }
}

/** Ảnh chưa có ảnh nhỏ sẵn: tải khi hiện ra (ảnh nhỏ còn trong RemoteImages, có giới hạn) -> phiên nhiều ảnh không phình bộ nhớ. */
@Composable
private fun RemoteImageTile(app: AppModel, name: String, sessionId: String, large: Boolean, key: String) {
    val maxPixel = if (large) 600 else 216
    var img by remember(key) { mutableStateOf<Bitmap?>(null) }
    var failed by remember(key) { mutableStateOf(false) }
    // nối được hub và máy tính đang online; đổi thì tải lại -> ô lỗi tự tải lại khi có mạng trở lại
    val reachable = app.api != null && app.hub?.connected == true && app.currentMachine?.online != false
    val shown = img ?: RemoteImages.cachedThumb(sessionId, name, maxPixel)
    // ô lớn cao cố định 140, tải xong chỉ đổi chiều rộng -> danh sách không bị đẩy lên xuống
    val w = if (large) shown?.let { (140f * it.width / maxOf(it.height, 1)).coerceIn(60f, 260f).toInt() } ?: 140 else 72
    ImageTile(shown, !failed, w, if (large) 140 else 72)
    LaunchedEffect(key, reachable) {
        val api = app.api
        if (img == null && reachable && api != null) {
            failed = false
            val r = RemoteImages.thumb(api, sessionId, name, maxPixel)
            img = r
            failed = r == null
        }
    }
}

/**
 * Xem ảnh cỡ đầy đủ như app Ảnh: nền đen, mở ra vừa khung, chụm hai ngón để phóng to / thu nhỏ, kéo để di chuyển,
 * chạm hai lần để phóng chỗ chạm / trả về vừa khung; ✕ hoặc nút Back để đóng; nút chia sẻ để lưu / gửi đi.
 */
@Composable
fun ImageViewer(image: Bitmap, loading: Boolean, onClose: () -> Unit) {
    val ctx = LocalContext.current
    Dialog(
        onDismissRequest = onClose,
        properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false),
    ) {
        var scale by remember { mutableFloatStateOf(1f) }
        var offset by remember { mutableStateOf(Offset.Zero) }
        var box by remember { mutableStateOf(IntSize.Zero) }

        fun clamp(o: Offset, s: Float): Offset {
            val mx = (box.width * (s - 1f) / 2f).coerceAtLeast(0f)
            val my = (box.height * (s - 1f) / 2f).coerceAtLeast(0f)
            return Offset(o.x.coerceIn(-mx, mx), o.y.coerceIn(-my, my))
        }

        Box(
            Modifier.fillMaxSize().background(Color.Black).onSizeChanged { box = it }
                .pointerInput(Unit) {
                    detectTransformGestures { centroid, pan, zoom, _ ->
                        val ns = (scale * zoom).coerceIn(1f, 8f)
                        val c = Offset(centroid.x - box.width / 2f, centroid.y - box.height / 2f)
                        val o = c - (c - offset) * (ns / scale) + pan
                        scale = ns
                        offset = clamp(o, ns)
                    }
                }
                .pointerInput(Unit) {
                    detectTapGestures(onDoubleTap = { p ->
                        if (scale > 1.01f) {
                            scale = 1f
                            offset = Offset.Zero
                        } else {
                            val ns = 3f
                            val c = Offset(p.x - box.width / 2f, p.y - box.height / 2f)
                            scale = ns
                            offset = clamp(c - c * ns, ns)
                        }
                    })
                },
        ) {
            Image(
                image.asImageBitmap(), contentDescription = "Ảnh", contentScale = ContentScale.Fit,
                modifier = Modifier.fillMaxSize().graphicsLayer(scaleX = scale, scaleY = scale, translationX = offset.x, translationY = offset.y),
            )
            if (loading) CircularProgressIndicator(Modifier.align(Alignment.Center).size(40.dp), color = Color.White)
            Row(Modifier.fillMaxSize().statusBarsPadding().padding(horizontal = 12.dp, vertical = 10.dp), verticalAlignment = Alignment.Top) {
                IconButton(onClick = onClose, Modifier.clip(CircleShape).background(Color.White.copy(alpha = 0.22f))) {
                    Icon(Icons.Filled.Close, contentDescription = "Đóng", tint = Color.White)
                }
                Box(Modifier.weight(1f))
                IconButton(onClick = { shareBitmap(ctx, image) }, Modifier.clip(CircleShape).background(Color.White.copy(alpha = 0.22f))) {
                    Icon(Icons.Filled.Share, contentDescription = "Lưu / chia sẻ", tint = Color.White)
                }
            }
        }
    }
}

private fun shareBitmap(ctx: Context, bmp: Bitmap) {
    try {
        val dir = File(ctx.cacheDir, "share").apply { mkdirs() }
        dir.listFiles()?.forEach { if (System.currentTimeMillis() - it.lastModified() > 3600_000) it.delete() }
        val f = File(dir, "ccremote-${System.currentTimeMillis()}.png")
        f.outputStream().use { bmp.compress(Bitmap.CompressFormat.PNG, 100, it) }
        val uri = FileProvider.getUriForFile(ctx, ctx.packageName + ".files", f)
        val send = Intent(Intent.ACTION_SEND).setType("image/png").putExtra(Intent.EXTRA_STREAM, uri).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        ctx.startActivity(Intent.createChooser(send, "Lưu / chia sẻ ảnh").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    } catch (_: Exception) {}
}

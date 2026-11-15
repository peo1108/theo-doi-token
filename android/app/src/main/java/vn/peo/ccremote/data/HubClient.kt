package vn.peo.ccremote.data

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.channels.SendChannel
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.buffer
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okio.ByteString.Companion.toByteString
import java.util.UUID
import java.util.concurrent.TimeUnit
import kotlin.random.Random

/** Dựng JsonObject từ cặp khoá–giá trị thường (String, Number, Boolean, JsonElement, List, Map, null). */
fun jsonOf(vararg kv: Pair<String, Any?>): JsonObject = JsonObject(kv.associate { it.first to toJson(it.second) })

fun toJson(v: Any?): JsonElement = when (v) {
    null -> JsonNull
    is JsonElement -> v
    is String -> JsonPrimitive(v)
    is Boolean -> JsonPrimitive(v)
    is Number -> JsonPrimitive(v)
    is Map<*, *> -> JsonObject(v.entries.associate { it.key.toString() to toJson(it.value) })
    is Iterable<*> -> JsonArray(v.map { toJson(it) })
    else -> JsonPrimitive(v.toString())
}

/**
 * Kết nối WebSocket tới CC Remote Hub (VPS): hỏi–đáp (req/res) tới máy tính, theo dõi phiên (sub/event),
 * tự nối lại 1 → 30 giây. Tin lớn hơn 256 KB được chia mảnh (khung nhị phân "part"), giống hub/proto.js.
 * (= ios/CCRemote/HubClient.swift)
 *
 * Mọi trạng thái bên trong chỉ đổi trên một luồng tuần tự (`ser`); các biến hiện cho giao diện là Compose state.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class HubClient(
    base: String,
    private val token: String,
    private val http: OkHttpClient,
    private val clientVersion: String = "",
    private val scope: CoroutineScope = CoroutineScope(Dispatchers.Default),
) {
    companion object {
        const val PROTO = 1

        fun apiError(code: String, message: String?): ApiError = ApiError(
            code,
            message ?: mapOf(
                "NOT_FOUND" to "Không tìm thấy (máy đang tắt?)",
                "TIMEOUT" to "Máy tính không phản hồi",
                "OFFLINE" to "Máy tính vừa mất kết nối",
                "TOO_LARGE" to "Tin nhắn quá lớn (tối đa 50 MB)",
            )[code] ?: "Lỗi $code",
        )

        fun machineOf(m: JsonObject): HubMachine? {
            val id = m["id"]?.jsonPrimitive?.contentOrNull ?: return null
            return HubMachine(
                id = id,
                name = m["name"]?.jsonPrimitive?.contentOrNull ?: "PC",
                online = m["online"]?.jsonPrimitive?.booleanOrNull ?: false,
                lastSeen = m["lastSeen"]?.jsonPrimitive?.doubleOrNull,
            )
        }

        /** "https://hub" -> "https://hub/v1/ws" (OkHttp tự đổi sang ws/wss khi nâng cấp kết nối). */
        fun wsUrl(base: String): String = base.trimEnd('/') + "/v1/ws"
    }

    var machines by mutableStateOf<List<HubMachine>>(emptyList()); private set
    var connected by mutableStateOf(false); private set
    var username by mutableStateOf<String?>(null); private set
    var ntfySubscribe by mutableStateOf<String?>(null); private set
    var lastError by mutableStateOf<String?>(null); private set

    /** gọi khi token không còn hiệu lực (thu hồi, khoá, đăng xuất ở thiết bị khác) */
    @Volatile var onUnauthorized: (() -> Unit)? = null

    /** gọi khi danh sách phiên trên một máy đổi (để làm mới màn hình chính) */
    @Volatile var onSessionsChanged: ((String) -> Unit)? = null

    private val url = wsUrl(base)
    private val ser: CoroutineDispatcher = Dispatchers.Default.limitedParallelism(1)
    private var ws: WebSocket? = null
    private var stopped = false
    private var attempt = 0
    private var foreground = true

    /** app chạy nền và tự báo được (thông báo local) -> hub thôi đẩy ntfy cho sự kiện của phiên, khỏi báo trùng */
    private var notifies = false
    private val pending = HashMap<String, CompletableDeferred<JsonElement>>()
    private class Sub(val token: Any, val ch: SendChannel<JsonObject>)

    /** "machine:session" -> luồng đang xem; token phân biệt luồng cũ / mới của cùng một phiên */
    private val subs = HashMap<String, Sub>()
    private val assembler = Assembler()
    private val connectedFlow = MutableStateFlow(false)
    private val stoppedFlow = MutableStateFlow(false)
    private var retryJob: Job? = null

    // ---------- kết nối ----------

    fun start() {
        scope.launch(ser) {
            stopped = false
            stoppedFlow.value = false
            if (ws == null) connect()
        }
    }

    fun stop() {
        scope.launch(ser) {
            stopped = true
            stoppedFlow.value = true
            retryJob?.cancel()
            val w = ws
            ws = null
            try { w?.close(1001, "going away") } catch (_: Exception) {}
            failAll(ApiError("STOPPED", "Đã ngắt kết nối hub"))
            updateConnected(false)
        }
    }

    fun setForeground(fg: Boolean, notifies: Boolean = false) {
        scope.launch(ser) {
            foreground = fg
            this@HubClient.notifies = notifies
            sendJSON(jsonOf("type" to "presence", "foreground" to fg, "notifies" to notifies))
            if (fg && ws == null && !stopped) {
                attempt = 0
                retryJob?.cancel()
                connect()
            }
        }
    }

    /** Chờ bắt tay xong (tối đa vài giây) — dùng trước lời gọi đầu tiên sau khi mở app. */
    suspend fun ready(timeoutMs: Long = 6000) {
        if (connected) return
        withTimeoutOrNull(timeoutMs) { combine(connectedFlow, stoppedFlow) { c, s -> c || s }.first { it } }
    }

    private fun updateConnected(v: Boolean) {
        connected = v
        connectedFlow.value = v
    }

    private fun connect() {
        if (stopped) return
        val req = try {
            Request.Builder().url(url).build()
        } catch (_: IllegalArgumentException) {
            lastError = "Địa chỉ hub không hợp lệ"
            return
        }
        ws = http.newWebSocket(req, Listener())
    }

    private inner class Listener : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) {
            scope.launch(ser) {
                if (ws !== webSocket) return@launch
                sendJSON(
                    jsonOf(
                        "type" to "hello", "proto" to PROTO, "role" to "app", "token" to token,
                        "client" to jsonOf("name" to "android", "version" to clientVersion),
                    ),
                )
            }
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            scope.launch(ser) {
                if (ws !== webSocket) return@launch
                val m = try { Json.parseToJsonElement(text).jsonObject } catch (_: Exception) { return@launch }
                handle(m)
            }
        }

        override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
            val b = bytes.toByteArray()
            scope.launch(ser) {
                if (ws !== webSocket) return@launch
                handlePart(b)
            }
        }

        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
            try { webSocket.close(1000, null) } catch (_: Exception) {}
            scope.launch(ser) { closed(webSocket, code) }
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
            scope.launch(ser) { closed(webSocket, code) }
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            scope.launch(ser) { closed(webSocket, 1006) }
        }
    }

    private fun closed(w: WebSocket, code: Int) {
        if (ws !== w) return
        ws = null
        updateConnected(false)
        failAll(ApiError("NETWORK", "Mất kết nối tới hub"))
        if (code == 4001) {
            stopped = true
            stoppedFlow.value = true
            lastError = "Đăng nhập không còn hiệu lực"
            onUnauthorized?.invoke()
            return
        }
        if (code == 4002) {
            stopped = true
            stoppedFlow.value = true
            lastError = "Cần cập nhật app để dùng hub này"
            return
        }
        if (stopped) return
        val delaySec = backoffDelay(attempt, Random.nextDouble())
        attempt++
        retryJob?.cancel()
        retryJob = scope.launch(ser) {
            delay((delaySec * 1000).toLong())
            if (ws == null && !stopped) connect()
        }
    }

    private fun failAll(e: ApiError) {
        val p = pending.values.toList()
        pending.clear()
        p.forEach { it.completeExceptionally(e) }
        val s = subs.values.toList()
        subs.clear()
        s.forEach { it.ch.close(e) }
        assembler.clear()
    }

    // ---------- nhận tin ----------

    private fun handle(m: JsonObject) {
        val type = m["type"]?.jsonPrimitive?.contentOrNull ?: return
        when (type) {
            "welcome" -> {
                attempt = 0
                lastError = null
                m["user"]?.let { u -> (u as? JsonObject)?.get("username")?.jsonPrimitive?.contentOrNull?.let { username = it } }
                (m["ntfy"] as? JsonObject)?.get("subscribe")?.jsonPrimitive?.contentOrNull?.let { ntfySubscribe = it }
                machines = (m["machines"] as? JsonArray)?.mapNotNull { (it as? JsonObject)?.let(::machineOf) } ?: emptyList()
                updateConnected(true)
                sendJSON(jsonOf("type" to "presence", "foreground" to foreground, "notifies" to notifies))
            }
            "res" -> {
                val id = m["id"]?.jsonPrimitive?.contentOrNull ?: return
                val c = pending.remove(id) ?: return
                if (m["ok"]?.jsonPrimitive?.booleanOrNull == true) {
                    c.complete(m["result"] ?: JsonNull)
                } else {
                    val e = m["error"] as? JsonObject
                    c.completeExceptionally(
                        apiError(e?.get("code")?.jsonPrimitive?.contentOrNull ?: "ERROR", e?.get("message")?.jsonPrimitive?.contentOrNull),
                    )
                }
            }
            "event" -> {
                val machine = m["machine"]?.jsonPrimitive?.contentOrNull ?: ""
                val sessionId = m["session"]?.jsonPrimitive?.contentOrNull ?: ""
                val d = m["data"] as? JsonObject ?: return
                if (d["kind"]?.jsonPrimitive?.contentOrNull == "sessions") {
                    onSessionsChanged?.invoke(machine)
                    return
                }
                subs["$machine:$sessionId"]?.ch?.trySend(d)
            }
            "machine" -> {
                val id = m["id"]?.jsonPrimitive?.contentOrNull ?: return
                if (m["removed"]?.jsonPrimitive?.booleanOrNull == true) {
                    machines = machines.filterNot { it.id == id }
                    return
                }
                machineOf(m)?.let { mm ->
                    machines = if (machines.any { it.id == id }) machines.map { if (it.id == id) mm else it } else machines + mm
                }
                if (m["online"]?.jsonPrimitive?.booleanOrNull == false) {
                    // máy rớt: kết thúc các luồng phiên của máy đó -> SessionModel tự nối lại khi máy online
                    for (k in subs.keys.filter { it.startsWith("$id:") }) {
                        subs.remove(k)?.ch?.close(ApiError("OFFLINE", "Máy tính đang tắt hoặc mất mạng"))
                    }
                }
            }
            "error" -> {
                val code = m["code"]?.jsonPrimitive?.contentOrNull
                val pid = m["pid"]?.jsonPrimitive?.contentOrNull
                val machine = m["machine"]?.jsonPrimitive?.contentOrNull
                val session = m["session"]?.jsonPrimitive?.contentOrNull
                val message = m["message"]?.jsonPrimitive?.contentOrNull
                if (code != null && pid != null) {
                    // tin lớn bị từ chối: báo cho lời gọi đang chờ (id nằm trong pid)
                    pending.remove(pid)?.completeExceptionally(apiError(code, message))
                } else if (machine != null && session != null && subs.containsKey("$machine:$session")) {
                    subs.remove("$machine:$session")?.ch?.close(apiError(code ?: "ERROR", message))
                } else {
                    lastError = message
                }
            }
        }
    }

    /** Khung nhị phân: [4 byte độ dài phần đầu][phần đầu JSON][dữ liệu]. */
    private fun handlePart(buf: ByteArray) {
        val part = Chunking.decodePart(buf) ?: return
        val msg = assembler.push(part) ?: return
        handle(msg)
    }

    // ---------- gửi ----------

    /** Gửi một tin; tin lớn chia mảnh (gửi dần, chờ hàng đợi OkHttp vơi để không vượt trần 16 MiB). */
    private fun sendJSON(obj: JsonObject): Boolean {
        val w = ws ?: return false
        val parts = try {
            Chunking.split(obj)
        } catch (_: ApiError) {
            return false
        }
        if (parts == null) {
            return w.send(Json.encodeToString(JsonObject.serializer(), obj))
        }
        val pid = obj["id"]?.jsonPrimitive?.contentOrNull
        scope.launch(ser) {
            for (p in parts) {
                while (ws === w && w.queueSize() > 6L * 1024 * 1024) delay(15)
                if (ws !== w || !w.send(p.toByteString())) {
                    if (pid != null) pending.remove(pid)?.completeExceptionally(ApiError("NETWORK", "Mất kết nối tới hub"))
                    return@launch
                }
            }
        }
        return true
    }

    /** Gọi một hàm trên máy tính (`machine`) hoặc của hub (`machine == "hub"`); trả JSON kết quả. */
    suspend fun call(machine: String, method: String, params: JsonObject = JsonObject(emptyMap()), timeoutMs: Long = 40_000): JsonElement {
        if (!connected) ready()
        if (!connected) throw ApiError("NETWORK", lastError ?: "Chưa kết nối được hub")
        val id = UUID.randomUUID().toString()
        val d = CompletableDeferred<JsonElement>()
        val ok = withContext(ser) {
            pending[id] = d
            val sent = sendJSON(jsonOf("type" to "req", "id" to id, "machine" to machine, "method" to method, "params" to params))
            if (!sent) pending.remove(id)
            sent
        }
        if (!ok) throw ApiError("NETWORK", "Chưa kết nối được hub")
        try {
            return withTimeout(timeoutMs) { d.await() }
        } catch (e: TimeoutCancellationException) {
            withContext(ser) { pending.remove(id) }
            throw ApiError("TIMEOUT", "Máy tính không phản hồi")
        } finally {
            if (!d.isCompleted) withContext(kotlinx.coroutines.NonCancellable + ser) { pending.remove(id) }
        }
    }

    /**
     * Theo dõi một phiên: phát lại sự kiện sau `after` rồi sự kiện mới (giống SSE của đường cũ).
     * Mỗi luồng có token riêng: luồng cũ của cùng phiên kết thúc muộn (mở lại phiên, bấm thông báo khi đang xem)
     * không được gỡ nhầm luồng mới — không thì màn phiên đứng im, không nhận sự kiện nữa.
     */
    fun subscribe(machine: String, session: String, after: Int, epoch: String): Flow<JsonObject> = callbackFlow {
        val key = "$machine:$session"
        val tok = Any()
        withContext(ser) {
            subs[key]?.ch?.close()
            subs[key] = Sub(tok, this@callbackFlow)   // ghi trước khi chờ nối: thôi xem trong lúc chờ thì awaitClose gỡ được
        }
        if (!connected) ready()
        val own = withContext(ser) { subs[key]?.token === tok }
        if (!own) {
            // đã thôi xem / bị luồng mới thay trong lúc chờ
            close()
            awaitClose { }
            return@callbackFlow
        }
        if (!connected) {
            withContext(ser) { subs.remove(key) }
            close(ApiError("NETWORK", lastError ?: "Chưa kết nối được hub"))
        } else if (machines.none { it.id == machine && it.online }) {
            withContext(ser) { subs.remove(key) }
            close(ApiError("OFFLINE", "Máy tính đang tắt hoặc mất mạng"))
        } else {
            withContext(ser) {
                sendJSON(jsonOf("type" to "sub", "machine" to machine, "session" to session, "after" to after, "epoch" to epoch))
            }
        }
        awaitClose {
            scope.launch(ser) {
                if (subs[key]?.token === tok) {
                    subs.remove(key)
                    sendJSON(jsonOf("type" to "unsub", "machine" to machine, "session" to session))
                }
            }
        }
    }.buffer(Channel.UNLIMITED)
}

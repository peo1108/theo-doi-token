package vn.peo.ccremote.session

import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonPrimitive
import vn.peo.ccremote.data.ApiClient
import vn.peo.ccremote.data.ApiError
import vn.peo.ccremote.data.AppJson
import vn.peo.ccremote.data.Event
import vn.peo.ccremote.data.EventHead
import vn.peo.ccremote.data.SessionSummary
import vn.peo.ccremote.data.jsonOf

enum class Haptic { Warning, Success }

/**
 * Một phiên đang mở trên màn hình: giữ danh sách sự kiện và luồng sub (tự nối lại khi rớt). (= SessionModel.swift)
 * Cơ chế seq/epoch: nối lại thì `sub` với `after` = seq cuối đã nhận và `epoch` hiện có -> không mất, không lặp.
 */
class SessionModel(val id: String, private val haptic: (Haptic) -> Unit = {}) {
    val events = mutableStateListOf<Event>()
    var summary by mutableStateOf<SessionSummary?>(null)
    val toolResults = mutableStateMapOf<String, Event>()
    val decisions = mutableStateMapOf<String, String>()

    /** lời người dùng nhắn kèm khi từ chối (requestId -> chữ) */
    val decisionTexts = mutableStateMapOf<String, String>()
    var connected by mutableStateOf(false)
    var lastError by mutableStateOf<String?>(null)
    var sending by mutableStateOf(false)
    var scrollTick by mutableIntStateOf(0)

    /** Claude đang nghĩ: số token ước lượng (null = không nghĩ) */
    var thinkingTokens by mutableStateOf<Int?>(null)

    /** chữ chạy khi Claude đang làm, như "Vibing…" trong VS Code */
    var spinnerVerb by mutableStateOf("Vibing")

    companion object {
        val verbs = listOf(
            "Vibing", "Pondering", "Cooking", "Brewing", "Manifesting", "Noodling", "Percolating", "Conjuring",
            "Crafting", "Musing", "Simmering", "Tinkering", "Wrangling", "Computing", "Synthesizing", "Clauding",
        )
    }

    var epoch = ""
        private set
    var lastSeq = 0
        private set

    /**
     * Sự kiện hiện trên màn hình (kết quả tool và quyết định được gộp vào thẻ tương ứng).
     * Tool đã có thẻ duyệt quyền riêng (câu hỏi, kế hoạch, lệnh chờ duyệt) thì không hiện thêm dòng tool.
     */
    val visible: List<Event> by derivedStateOf {
        val asked = events.mapNotNull { if (it.kind == "permission") it.toolUseId else null }.toSet()
        events.filter { it.kind != "tool_result" && it.kind != "decided" && !(it.kind == "tool" && (it.toolId ?: "") in asked) }
    }

    val status: String get() = summary?.status ?: "off"
    val isBusy: Boolean get() = status == "running" || status == "waiting" || status == "starting"

    suspend fun run(api: ApiClient) {
        var delaySec = 1.0
        while (currentCoroutineContext().isActive) {
            try {
                connected = true
                lastError = null
                api.events(id, lastSeq, epoch).collect { d ->
                    handle(d)
                    delaySec = 1.0
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                lastError = (e as? ApiError)?.message ?: e.message
            }
            connected = false
            delay((delaySec * 1000).toLong())
            delaySec = minOf(delaySec * 2, 10.0)
        }
        connected = false
    }

    fun handle(text: String) {
        val el = try { AppJson.parseToJsonElement(text) } catch (_: Exception) { return }
        (el as? JsonObject)?.let { handle(it) }
    }

    fun handle(data: JsonObject) {
        val head = try { AppJson.decodeFromJsonElement(EventHead.serializer(), data) } catch (_: Exception) { return }
        when (head.kind) {
            "reset" -> {
                events.clear()
                toolResults.clear()
                decisions.clear()
                decisionTexts.clear()
                lastSeq = 0
                epoch = head.epoch ?: ""
            }
            "state" -> {
                val s = try { AppJson.decodeFromJsonElement(SessionSummary.serializer(), data) } catch (_: Exception) { return }
                val wasRunning = summary?.status == "running"
                summary = s
                epoch = s.epoch
                val t = s.thinking
                if (t != null) thinkingTokens = t.tokens else if (s.status != "running") thinkingTokens = null
                if (s.status == "running" && !wasRunning) spinnerVerb = verbs.random()
            }
            "progress" -> {
                // tức thời, không lưu: "Thinking… · N tokens"
                val phase = data["phase"]?.jsonPrimitive?.contentOrNull
                thinkingTokens = if (phase == "thinking") data["tokens"]?.jsonPrimitive?.intOrNull else null
            }
            else -> {
                val e = try { AppJson.decodeFromJsonElement(Event.serializer(), data) } catch (_: Exception) { return }
                if (e.seq > lastSeq) append(e)
            }
        }
    }

    private fun append(e: Event) {
        events.add(e)
        lastSeq = e.seq
        when (e.kind) {
            "tool_result" -> e.toolId?.let { toolResults[it] = e }
            "decided" -> {
                val rid = e.requestId
                if (rid != null && e.decision != null) decisions[rid] = e.decision
                if (rid != null && !e.text.isNullOrEmpty()) decisionTexts[rid] = e.text
            }
            "permission", "limit" -> haptic(Haptic.Warning)
            "result" -> if (e.ok == true) haptic(Haptic.Success)
        }
        scrollTick += 1
    }

    private suspend fun post(api: ApiClient, action: String, body: Map<String, Any?> = emptyMap()) {
        try {
            val params = jsonOf("id" to id, *body.map { it.key to it.value }.toTypedArray())
            val s: SessionSummary = api.call("sessions.$action", params)
            summary = s
            lastError = null
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            lastError = (e as? ApiError)?.message ?: e.message
        }
    }

    /** images: [{mime, data, name, thumb}] đã nén; trả true nếu gửi được. */
    suspend fun send(text: String, images: List<JsonElement> = emptyList(), api: ApiClient): Boolean {
        sending = true
        try {
            val body = LinkedHashMap<String, Any?>()
            body["text"] = text
            if (images.isNotEmpty()) body["images"] = images
            post(api, "send", body)
            return lastError == null
        } finally {
            sending = false
        }
    }

    /** feedback: lời nhắn kèm khi từ chối / chưa duyệt kế hoạch (Claude đọc được để làm khác đi) */
    suspend fun decide(requestId: String, decision: String, answers: Map<String, String>? = null, feedback: String? = null, api: ApiClient) {
        val body = LinkedHashMap<String, Any?>()
        body["requestId"] = requestId
        body["decision"] = decision
        if (answers != null) body["answers"] = answers
        if (!feedback.isNullOrEmpty()) body["feedback"] = feedback
        post(api, "permission", body)
    }

    suspend fun applySettings(body: Map<String, Any?>, api: ApiClient) = post(api, "settings", body)
    suspend fun interrupt(api: ApiClient) = post(api, "interrupt")
    suspend fun setMode(mode: String, api: ApiClient) = post(api, "mode", mapOf("mode" to mode))
    suspend fun setModel(model: String, api: ApiClient) = post(api, "model", mapOf("model" to model))
    suspend fun close(api: ApiClient) = post(api, "close")
    suspend fun attach(on: Boolean, api: ApiClient) = post(api, "attach", mapOf("on" to on))
}

/** Lấy requestId của yêu cầu quyền đang chờ (sự kiện permission chưa có decided) từ danh sách sự kiện. */
fun pendingPermission(events: List<Event>): Event? {
    val decided = events.filter { it.kind == "decided" }.mapNotNull { it.requestId }.toSet()
    return events.lastOrNull { it.kind == "permission" && it.requestId != null && it.requestId !in decided }
}

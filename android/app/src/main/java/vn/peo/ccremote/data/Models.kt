package vn.peo.ccremote.data

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale

// Dữ liệu từ remote.js (máy tính) — tương ứng ios/CCRemote/Models.swift.
// Mọi trường đều có giá trị mặc định: server thêm / bớt trường thì app không vỡ.

val AppJson = Json {
    ignoreUnknownKeys = true
    explicitNulls = false
    coerceInputValues = true
    isLenient = true
}

class ApiError(val code: String, override val message: String) : Exception(message)

@Serializable
data class UsageBucket(val pct: Double = 0.0, val resetsAt: Double? = null)

@Serializable
data class Account(
    val id: String,
    val name: String = "",
    val email: String? = null,
    val plan: String? = null,
    val active: Boolean = false,
    val suggested: Boolean = false,
    val loginState: String? = null,
    val stale: Boolean? = null,
    val error: String? = null,
    val fiveHour: UsageBucket? = null,
    val sevenDay: UsageBucket? = null,
    val costToday: Double? = null,
)

@Serializable
data class AccountsInfo(
    val active: String? = null,
    val conflict: Boolean = false,
    val list: List<Account> = emptyList(),
)

@Serializable
data class Rate(
    val status: String? = null,
    val type: String? = null,
    val resetsAt: Double? = null,
    val fiveHour: Double? = null,
    val sevenDay: Double? = null,
)

@Serializable
data class SessionSettings(
    val model: String? = null,
    val modelValue: String? = null,
    val modelLabel: String = "",
    val effort: String? = null,
    val thinking: Boolean = true,
    val flagSwitch: Boolean = true,
    val fast: Boolean = false,
    val outputStyle: String = "default",
)

@Serializable
data class ModelInfo(
    val value: String,
    val label: String = "",
    val description: String = "",
    val resolved: String = "",
    val efforts: List<String> = emptyList(),
    val thinking: Boolean = true,
    val fast: Boolean = false,
)

@Serializable
data class CommandInfo(
    val name: String,
    val description: String = "",
    val hint: String = "",
)

@Serializable
data class CapsAccount(val email: String = "", val plan: String = "")

/** Danh sách model, lệnh /, output style mà Claude Code trên máy hỗ trợ (từ initialize). */
@Serializable
data class Capabilities(
    val models: List<ModelInfo> = emptyList(),
    val commands: List<CommandInfo> = emptyList(),
    val outputStyles: List<String> = listOf("default"),
    val account: CapsAccount? = null,
    val efforts: List<String> = emptyList(),
    val defaults: SessionSettings = SessionSettings(),
)

fun effortLabel(e: String?): String = when (e) {
    "low" -> "Low"
    "medium" -> "Medium"
    "high" -> "High"
    "xhigh" -> "XHigh"
    "max" -> "Max"
    else -> "Mặc định"
}

@Serializable
data class AskInfo(val tool: String = "", val summary: String = "")

@Serializable
data class ThinkingInfo(val tokens: Int = 0, val since: Double = 0.0)

@Serializable
data class SessionSummary(
    val id: String = "",
    val settings: SessionSettings? = null,
    val account: String? = null,
    val external: Boolean? = null,
    val source: String? = null,
    val attached: Boolean? = null,
    val ready: Boolean? = null,
    val pcAway: Boolean? = null,
    val mirror: Boolean? = null,
    val thinking: ThinkingInfo? = null,
    val ask: AskInfo? = null,
    val cwd: String? = null,
    val project: String? = null,
    val title: String? = null,
    val status: String = "off",
    val live: Boolean = false,
    val pending: Int = 0,
    val mode: String = "default",
    val model: String? = null,
    val rate: Rate? = null,
    val cost: Double? = null,
    val lastText: String? = null,
    val updatedAt: Double = 0.0,
    val epoch: String = "",
    val lastSeq: Int = 0,
    val watching: Int? = null,
)

@Serializable
data class RecentSession(
    val id: String,
    val cwd: String = "",
    val project: String = "",
    val title: String = "",
    val updatedAt: Double = 0.0,
)

@Serializable
data class NtfyConfig(val server: String = "", val topic: String = "")

/** Một cảnh báo của tracker trên máy tính. */
@Serializable
data class PCAlert(
    val id: Double,
    val t: Double = 0.0,
    val level: String = "info",
    val title: String = "",
    val body: String? = null,
)

@Serializable
data class Project(
    val cwd: String,
    val name: String = "",
    val lastUsed: Double = 0.0,
    val count: Int? = null,
    val lastTitle: String? = null,
    val live: Int? = null,
)

@Serializable
data class RemoteState(
    val version: Int = 0,
    val host: String = "",
    val now: Double = 0.0,
    val live: List<SessionSummary> = emptyList(),
    val recent: List<RecentSession> = emptyList(),
    val accounts: AccountsInfo? = null,
    val ntfy: NtfyConfig? = null,
    val projects: List<Project>? = null,
    val alwaysOn: Boolean? = null,
    val pcAway: Boolean? = null,
    /** cảnh báo gần đây của máy (ngân sách, hạn mức, đăng nhập…) — tracker cũ không gửi */
    val alerts: List<PCAlert>? = null,
)

@Serializable
data class QuestionOption(val label: String = "", val description: String = "")

@Serializable
data class Question(
    val question: String = "",
    val header: String = "",
    val multiSelect: Boolean = false,
    val options: List<QuestionOption> = emptyList(),
)

@Serializable
data class Suggest(val id: String = "", val name: String = "")

/** ảnh gửi từ điện thoại (ảnh nhỏ base64) hoặc ảnh Claude xem trên máy (không có ảnh nhỏ); ảnh đầy đủ lấy bằng sessions.image */
@Serializable
data class EventImage(val name: String = "", val thumb: String? = null)

/**
 * Một sự kiện trong phiên (đã được server chuẩn hoá).
 * kind: user | assistant | tool | tool_result | permission | decided | result | note | error | limit | output | thought
 */
@Serializable
data class Event(
    val kind: String = "",
    val seq: Int = 0,
    val t: Double? = null,
    val text: String? = null,
    @SerialName("id") val toolId: String? = null,
    val name: String? = null,
    val summary: String? = null,
    val input: String? = null,
    val error: Boolean? = null,
    val requestId: String? = null,
    val tool: String? = null,
    val canAlways: Boolean? = null,
    val reason: String? = null,
    val questions: List<Question>? = null,
    val plan: String? = null,
    val decision: String? = null,
    val ok: Boolean? = null,
    val aborted: Boolean? = null,
    val cost: Double? = null,
    val ms: Double? = null,
    val turns: Int? = null,
    val suggest: Suggest? = null,
    val toolUseId: String? = null,
    val title: String? = null,
    val path: String? = null,
    val code: String? = null,
    @SerialName("old") val oldText: String? = null,
    @SerialName("new") val newText: String? = null,
    val via: String? = null,
    val seconds: Double? = null,
    val tokens: Int? = null,
    val images: List<EventImage>? = null,
)

/** Chỉ đọc `kind` (và `epoch` của sự kiện reset) trước khi giải mã đầy đủ. */
@Serializable
data class EventHead(val kind: String = "", val epoch: String? = null)

@Serializable
data class SwitchResponse(
    val ok: Boolean = true,
    val to: String? = null,
    val restarted: List<String>? = null,
    val running: Int? = null,
)

@Serializable
data class HubUser(val id: Int = 0, val username: String = "", val admin: Boolean = false)

@Serializable
data class HubLoginResponse(val token: String, val user: HubUser = HubUser())

@Serializable
data class HubDevice(
    val id: String,
    val name: String = "",
    val lastSeen: Double? = null,
    val current: Boolean? = null,
)

@Serializable
data class ImageData(val mime: String = "", val data: String = "")

/** Máy tính (PC) của người dùng trên hub. */
data class HubMachine(val id: String, val name: String, val online: Boolean, val lastSeen: Double?)

sealed class Route {
    data class Session(val id: String) : Route()
    data class Project(val cwd: String) : Route()
    data class NewSession(val presetCwd: String? = null) : Route()
    data object Settings : Route()
}

enum class PermissionMode(val raw: String, val label: String) {
    Default("default", "Hỏi trước khi làm"),
    AcceptEdits("acceptEdits", "Tự sửa file"),
    Plan("plan", "Lập kế hoạch"),
    Bypass("bypassPermissions", "Bỏ qua mọi quyền");

    companion object {
        fun of(raw: String?): PermissionMode = entries.firstOrNull { it.raw == raw } ?: Default
    }
}

data class ModelChoice(val id: String, val label: String)

val modelChoices = listOf(
    ModelChoice("", "Mặc định"),
    ModelChoice("opus", "Opus"),
    ModelChoice("sonnet", "Sonnet"),
    ModelChoice("haiku", "Haiku"),
)

enum class StatusColor { Blue, Orange, Green, Gray }

data class StatusInfo(val label: String, val color: StatusColor)

fun statusInfo(status: String): StatusInfo = when (status) {
    "running" -> StatusInfo("Đang chạy", StatusColor.Blue)
    "waiting" -> StatusInfo("Cần duyệt", StatusColor.Orange)
    "idle" -> StatusInfo("Rảnh", StatusColor.Green)
    "starting" -> StatusInfo("Đang mở", StatusColor.Blue)
    else -> StatusInfo("Đã tắt", StatusColor.Gray)
}

/** "5 phút trước", "2 giờ trước"… (iOS dùng RelativeDateTimeFormatter vi_VN, kiểu ngắn). */
fun relativeTime(ms: Double, now: Long = System.currentTimeMillis()): String {
    val sec = ((now - ms) / 1000).toLong()
    val a = kotlin.math.abs(sec)
    val future = sec < 0
    val (n, unit) = when {
        a < 45 -> return if (future) "sắp tới" else "vừa xong"
        a < 3600 -> (a / 60).coerceAtLeast(1) to "phút"
        a < 86400 -> (a / 3600) to "giờ"
        a < 86400 * 30 -> (a / 86400) to "ngày"
        a < 86400 * 365 -> (a / (86400 * 30)) to "tháng"
        else -> (a / (86400 * 365)) to "năm"
    }
    return if (future) "$n $unit nữa" else "$n $unit trước"
}

/** Giờ trong ngày ("14:05"), hôm khác thì kèm thứ ("T2 14:05"). */
fun clockTime(ms: Double): String {
    val d = Date(ms.toLong())
    val cal = Calendar.getInstance().apply { time = d }
    val today = Calendar.getInstance()
    val same = cal.get(Calendar.YEAR) == today.get(Calendar.YEAR) && cal.get(Calendar.DAY_OF_YEAR) == today.get(Calendar.DAY_OF_YEAR)
    val hm = SimpleDateFormat("HH:mm", Locale.US).format(d)
    if (same) return hm
    val dow = when (cal.get(Calendar.DAY_OF_WEEK)) {
        Calendar.MONDAY -> "T2"
        Calendar.TUESDAY -> "T3"
        Calendar.WEDNESDAY -> "T4"
        Calendar.THURSDAY -> "T5"
        Calendar.FRIDAY -> "T6"
        Calendar.SATURDAY -> "T7"
        else -> "CN"
    }
    return "$dow $hm"
}

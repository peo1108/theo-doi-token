package vn.peo.ccremote

import android.app.Application
import android.net.Uri
import android.os.Build
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import okhttp3.OkHttpClient
import vn.peo.ccremote.data.ApiClient
import vn.peo.ccremote.data.ApiError
import vn.peo.ccremote.data.AppJson
import vn.peo.ccremote.data.Capabilities
import vn.peo.ccremote.data.HubClient
import vn.peo.ccremote.data.HubHttp
import vn.peo.ccremote.data.HubLoginResponse
import vn.peo.ccremote.data.HubMachine
import vn.peo.ccremote.data.PCAlert
import vn.peo.ccremote.data.Prefs
import vn.peo.ccremote.data.Project
import vn.peo.ccremote.data.RecentSession
import vn.peo.ccremote.data.RemoteState
import vn.peo.ccremote.data.Route
import vn.peo.ccremote.data.SecureStore
import vn.peo.ccremote.data.SessionSummary
import vn.peo.ccremote.data.SwitchResponse
import vn.peo.ccremote.data.jsonOf
import vn.peo.ccremote.notify.HubServiceControl
import vn.peo.ccremote.notify.Notifier
import vn.peo.ccremote.data.normalizeHubUrl
import java.util.concurrent.TimeUnit

/**
 * Trạng thái app: đăng nhập hub trên VPS, chọn máy tính, gọi lõi trên máy qua hub. (= AppModel.swift)
 * Một đối tượng duy nhất cho cả tiến trình (do AppGraph dựng): giao diện, dịch vụ nền và thông báo dùng chung một kết nối hub.
 */
class AppModel(val application: Application, val http: OkHttpClient) {
    companion object {
        const val DEFAULT_HUB = Prefs.DEFAULT_HUB
    }

    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    val hubHttp = HubHttp(http.newBuilder().callTimeout(20, TimeUnit.SECONDS).build())

    var state by mutableStateOf<RemoteState?>(null)
    var lastError by mutableStateOf<String?>(null)
    var lastOK by mutableStateOf<Long?>(null)
    val path = mutableStateListOf<Route>()
    var caps by mutableStateOf<Capabilities?>(null)

    var hubURL by mutableStateOf(Prefs.hubUrl)
    var hubToken by mutableStateOf<String?>(SecureStore.get("hubToken"))
    var machineId by mutableStateOf(Prefs.machineId)
    var hub by mutableStateOf<HubClient?>(null)

    /** app đang hiện trên màn hình (ProcessLifecycle STARTED) */
    var inForeground by mutableStateOf(false)

    /** dịch vụ foreground đang chạy (HubService) -> app giữ kết nối khi ở nền */
    var serviceRunning by mutableStateOf(false)

    /** phiên đang mở trên màn hình: Notifier không báo phiên này khi app đang hiện */
    var activeSessionId: String? = null

    /** mỗi lần có trạng thái mới từ máy (Notifier gắn vào) */
    var onState: ((RemoteState) -> Unit)? = null

    /** thứ tự các lần gọi state: chỉ nhận kết quả mới hơn lần đã hiện */
    private var refreshSeq = 0
    private var appliedSeq = 0
    private var pollJob: Job? = null

    /** cảnh báo của máy đã vuốt ẩn ở trang chủ (nhớ qua các lần mở app) */
    var dismissedAlerts by mutableStateOf(Prefs.doubles("dismissedAlerts"))

    /** Cảnh báo của máy còn hiện ở trang chủ. */
    val visibleAlerts: List<PCAlert> get() = (state?.alerts ?: emptyList()).filter { it.id !in dismissedAlerts }

    fun dismissAlert(id: Double) {
        // chỉ nhớ những cái máy còn gửi (khỏi phình mãi)
        val live = (state?.alerts ?: emptyList()).map { it.id }.toSet()
        dismissedAlerts = (dismissedAlerts + id).filter { it in live || it == id }.toSet()
        Prefs.putDoubles("dismissedAlerts", dismissedAlerts)
    }

    val isPaired: Boolean get() = hubToken != null
    val machines: List<HubMachine> get() = hub?.machines ?: emptyList()
    val currentMachine: HubMachine? get() = machines.firstOrNull { it.id == machineId }
    val api: ApiClient? get() {
        val h = hub ?: return null
        return if (machineId.isEmpty()) null else ApiClient(h, machineId)
    }

    init {
        hubToken?.let { startHub(it) }
    }

    // ---------- kết nối hub ----------

    private fun startHub(token: String) {
        hub?.stop()
        pollJob?.cancel()
        val h = HubClient(hubURL, token, http, BuildConfig.VERSION_NAME)
        h.onUnauthorized = { scope.launch { logout(remote = false) } }
        h.onSessionsChanged = { m -> scope.launch { if (m == machineId) refresh() } }
        hub = h
        h.start()
        h.setForeground(inForeground, notifies = notifiesInBackground())
        pollJob = scope.launch { poll() }
    }

    /** hub chỉ đẩy ntfy khi không app nào đang mở; dịch vụ nền chạy và tự báo được thì hub thôi đẩy sự kiện của phiên (khỏi báo trùng) */
    fun notifiesInBackground(): Boolean = !inForeground && serviceRunning && Notifier.canNotify(application)

    /** Gọi khi app lên / xuống nền (ProcessLifecycleOwner) hoặc dịch vụ nền bật / tắt: cập nhật presence và kết nối. */
    fun applyPresence() {
        val h = hub ?: return
        if (inForeground) {
            h.start()
            h.setForeground(true, notifies = false)
            scope.launch { refresh() }
        } else if (serviceRunning) {
            h.start()
            h.setForeground(false, notifies = notifiesInBackground())
        } else {
            // không có dịch vụ nền: ngắt kết nối khi vào nền (ntfy lo phần còn lại), nối lại khi mở app
            h.stop()
        }
    }

    /** Chọn máy: giữ máy đã chọn nếu còn; không thì máy online đầu tiên. */
    fun pickMachine() {
        if (currentMachine?.online == true) return
        val m = machines.firstOrNull { it.online } ?: if (currentMachine == null) machines.firstOrNull() else null
        if (m != null) selectMachine(m.id)
    }

    fun selectMachine(id: String) {
        if (id == machineId) return
        machineId = id
        Prefs.machineId = id
        state = null
        caps = null
        path.clear()
        scope.launch { refresh() }
    }

    /** Đăng nhập hub (tài khoản do admin tạo trên trang web của hub). Đăng nhập dùng mãi tới khi tự đăng xuất. */
    suspend fun login(url: String, username: String, password: String) {
        val base = normalizeHubUrl(url.ifBlank { DEFAULT_HUB })
        val r: HubLoginResponse = hubHttp.post(
            base, "/v1/auth/login",
            jsonOf("username" to username.trim(), "password" to password, "deviceName" to deviceName()),
        )
        hubURL = base
        hubToken = r.token
        Prefs.hubUrl = base
        SecureStore.set("hubToken", r.token)
        lastError = null
        startHub(r.token)
        HubServiceControl.sync(application)
        hub?.ready()
        pickMachine()
        refresh()
    }

    private fun deviceName(): String {
        val m = Build.MANUFACTURER.orEmpty().replaceFirstChar { it.uppercase() }
        val model = Build.MODEL.orEmpty()
        return (if (model.startsWith(m, ignoreCase = true)) model else "$m $model").trim().ifEmpty { "Android" }
    }

    /** Đăng xuất khỏi hub (chỉ khi người dùng bấm, hoặc hub báo đăng nhập đã bị thu hồi). */
    fun logout(remote: Boolean = true) {
        val t = hubToken
        val base = hubURL
        if (remote && t != null) {
            scope.launch { try { hubHttp.postRaw(base, "/v1/auth/logout", null, t) } catch (_: Exception) {} }
        }
        pollJob?.cancel()
        hub?.stop()
        hub = null
        hubToken = null
        state = null
        caps = null
        SecureStore.set("hubToken", null)
        path.clear()
        onLoggedOut?.invoke()
    }

    /** dịch vụ nền / thông báo dọn dẹp sau khi đăng xuất */
    var onLoggedOut: (() -> Unit)? = null

    /** Hàm của chính hub: thiết bị, máy, đổi mật khẩu, ntfy... */
    suspend inline fun <reified T> hubCall(method: String, params: JsonObject = JsonObject(emptyMap())): T {
        val h = hub ?: throw ApiError("UNPAIRED", "Chưa đăng nhập hub")
        val d = h.call("hub", method, params)
        return AppJson.decodeFromJsonElement(kotlinx.serialization.serializer<T>(), d)
    }

    /** Đổi tên máy đang chọn (hub báo lại cho mọi app đang mở). */
    suspend fun renameMachine(name: String) {
        val n = name.trim()
        if (n.isEmpty() || machineId.isEmpty()) return
        try {
            hubCall<JsonObject>("machines.rename", jsonOf("id" to machineId, "name" to n))
        } catch (e: Exception) {
            lastError = (e as? ApiError)?.message ?: e.message
        }
    }

    // ---------- làm mới ----------

    suspend fun refresh() {
        pickMachine()
        val api = api
        if (api == null) {
            state = null
            lastError = hub?.lastError
            return
        }
        if (currentMachine?.online == false) {
            lastError = "Máy ${currentMachine?.name ?: ""} đang tắt hoặc chưa chạy tracker"
            return
        }
        val machine = machineId
        refreshSeq += 1
        val seq = refreshSeq
        try {
            val st: RemoteState = api.call("state")
            // các lần làm mới chạy chồng nhau (poll, sự kiện "sessions", thao tác): kết quả về muộn của máy vừa bỏ chọn,
            // hoặc cũ hơn cái đã hiện, thì bỏ — không lùi trạng thái (Notifier sẽ báo lặp "Xong việc")
            if (machine != machineId || seq <= appliedSeq) return
            appliedSeq = seq
            state = st
            onState?.invoke(st)
            lastError = null
            lastOK = System.currentTimeMillis()
        } catch (e: Exception) {
            if (e is kotlinx.coroutines.CancellationException) throw e
            if (machine != machineId) return
            lastError = (e as? ApiError)?.message ?: e.message
        }
    }

    private suspend fun poll() {
        while (true) {
            if (hub != null && (inForeground || serviceRunning)) refresh()
            // chạy nền: máy tính đã đẩy sự kiện "sessions" mỗi khi phiên đổi trạng thái (xin quyền, xong việc…) và app làm mới
            // ngay lúc đó -> chỉ cần hỏi thưa để bù; mỗi lần ~10 KB, 4 giây một lần cả ngày thì tốn pin và dữ liệu di động
            delay(if (inForeground) 4000 else 30000)
        }
    }

    private var capsAt = 0L

    /** Model, lệnh /, output style: tải một lần, làm mới sau 10 phút. */
    suspend fun loadCaps(force: Boolean = false) {
        val api = api ?: return
        if (!force && caps != null && System.currentTimeMillis() - capsAt < 600_000) return
        try {
            caps = api.call<Capabilities>("capabilities")
            capsAt = System.currentTimeMillis()
        } catch (e: Exception) {
            if (e is kotlinx.coroutines.CancellationException) throw e
        }
    }

    suspend fun projectSessions(cwd: String): List<RecentSession> {
        val api = api ?: return emptyList()
        return api.call("projects.sessions", jsonOf("cwd" to cwd))
    }

    suspend fun projects(): List<Project> {
        val api = api ?: return emptyList()
        return api.call("projects")
    }

    suspend fun createSession(
        cwd: String,
        text: String,
        mode: String,
        model: String,
        options: Map<String, Any?> = emptyMap(),
        images: List<JsonObject> = emptyList(),
    ): SessionSummary {
        val api = api ?: throw ApiError("UNPAIRED", "Chưa chọn máy tính")
        val body = LinkedHashMap<String, Any?>()
        body["cwd"] = cwd
        body["text"] = text
        body["mode"] = mode
        body["model"] = model
        body.putAll(options)
        if (images.isNotEmpty()) body["images"] = images
        val s: SessionSummary = api.call("sessions.create", jsonOf(*body.map { it.key to it.value }.toTypedArray()))
        refresh()
        return s
    }

    suspend fun switchAccount(id: String, sessionId: String? = null, text: String? = null): SwitchResponse {
        val api = api ?: throw ApiError("UNPAIRED", "Chưa chọn máy tính")
        val body = LinkedHashMap<String, Any?>()
        body["id"] = id
        if (sessionId != null) body["sessionId"] = sessionId
        if (text != null) body["text"] = text
        val r: SwitchResponse = api.call("accounts.switch", jsonOf(*body.map { it.key to it.value }.toTypedArray()))
        refresh()
        return r
    }

    suspend fun setAlwaysOn(on: Boolean) {
        val api = api ?: return
        api.call<JsonObject>("alwaysOn", jsonOf("on" to on))
        refresh()
    }

    /** ccremote://session/<máy>/<phiên> (thông báo của hub) hoặc ccremote://session/<phiên> */
    fun open(uri: Uri) {
        if (uri.scheme != "ccremote" || uri.host != "session") return
        val parts = uri.pathSegments.filter { it.isNotEmpty() }
        val id = parts.lastOrNull() ?: return
        if (id.length != 36) return
        if (parts.size == 2 && parts[0] != machineId) selectMachine(parts[0])
        path.clear()
        path.add(Route.Session(id))
    }

    fun openSession(id: String, machine: String? = null) {
        if (machine != null && machine.isNotEmpty() && machine != machineId) selectMachine(machine)
        path.clear()
        path.add(Route.Session(id))
    }

    fun title(id: String): String {
        state?.live?.firstOrNull { it.id == id }?.title?.takeIf { it.isNotEmpty() }?.let { return it }
        state?.recent?.firstOrNull { it.id == id }?.let { return it.title }
        return "Phiên"
    }

    /** Quay lại một màn (nút Back). */
    fun pop(): Boolean {
        if (path.isEmpty()) return false
        path.removeAt(path.size - 1)
        return true
    }
}

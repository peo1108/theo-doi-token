package vn.peo.ccremote.notify

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.RemoteInput
import androidx.core.content.ContextCompat
import kotlinx.coroutines.flow.transformWhile
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive
import vn.peo.ccremote.AppGraph
import vn.peo.ccremote.AppModel
import vn.peo.ccremote.MainActivity
import vn.peo.ccremote.R
import vn.peo.ccremote.data.ApiClient
import vn.peo.ccremote.data.ApiError
import vn.peo.ccremote.data.AppJson
import vn.peo.ccremote.data.Event
import vn.peo.ccremote.data.PCAlert
import vn.peo.ccremote.data.Prefs
import vn.peo.ccremote.data.RemoteState
import vn.peo.ccremote.data.SessionSummary
import vn.peo.ccremote.data.jsonOf
import vn.peo.ccremote.session.pendingPermission

/**
 * Thông báo khi Claude hỏi, xong việc, bị dừng hoặc hết hạn mức. (= Notifier.swift, cùng luật)
 * Khác iOS: có dịch vụ nền (HubService) giữ kết nối nên báo tức thì; xin quyền có nút Cho phép / Từ chối,
 * xong lượt có ô Trả lời ngay trên thông báo.
 */
object Notifier {
    const val CH_PERM = "perm"
    const val CH_DONE = "done"
    const val CH_ALERT = "pcalert"
    const val CH_CONN = "conn"

    const val ACTION_ALLOW = "vn.peo.ccremote.action.ALLOW"
    const val ACTION_DENY = "vn.peo.ccremote.action.DENY"
    const val ACTION_ANSWER = "vn.peo.ccremote.action.ANSWER"
    const val ACTION_REPLY = "vn.peo.ccremote.action.REPLY"
    const val ACTION_STOP_SERVICE = "vn.peo.ccremote.action.STOP_SERVICE"
    const val EXTRA_SID = "sid"
    const val EXTRA_MACHINE = "machine"
    const val EXTRA_REQUEST = "requestId"
    const val EXTRA_QUESTION = "question"
    const val EXTRA_TITLE = "title"
    const val KEY_REPLY = "reply_text"

    private var app: AppModel? = null
    private val last = HashMap<String, Snap>()
    private var primed = false
    private val seenAlerts = HashSet<Double>()

    fun setup(model: AppModel) {
        app = model
        createChannels(model.application)
        model.onState = { process(it) }
        model.onLoggedOut = {
            cancelAll(model.application)
            last.clear()
            primed = false
            seenAlerts.clear()
            HubServiceControl.sync(model.application)
        }
    }

    fun createChannels(ctx: Context) {
        if (Build.VERSION.SDK_INT < 26) return
        val nm = ctx.getSystemService(NotificationManager::class.java) ?: return
        nm.createNotificationChannel(NotificationChannel(CH_PERM, "Xin quyền / câu hỏi", NotificationManager.IMPORTANCE_HIGH).apply {
            description = "Claude cần bạn duyệt một việc hoặc đang hỏi bạn"
        })
        nm.createNotificationChannel(NotificationChannel(CH_DONE, "Xong lượt", NotificationManager.IMPORTANCE_DEFAULT).apply {
            description = "Claude xong việc, bị dừng hoặc hết hạn mức"
        })
        nm.createNotificationChannel(NotificationChannel(CH_ALERT, "Cảnh báo máy", NotificationManager.IMPORTANCE_DEFAULT).apply {
            description = "Cảnh báo của tracker trên máy tính (hạn mức, ngân sách, đăng nhập)"
        })
        nm.createNotificationChannel(NotificationChannel(CH_CONN, "Kết nối nền", NotificationManager.IMPORTANCE_LOW).apply {
            description = "Thông báo nhỏ thường trực khi app giữ kết nối với hub"
            setShowBadge(false)
        })
    }

    /** Android cho phép hiện thông báo của app (cấp quyền POST_NOTIFICATIONS trên Android 13+, không tắt thông báo của app). */
    fun permissionGranted(ctx: Context): Boolean {
        if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(ctx, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return false
        return NotificationManagerCompat.from(ctx).areNotificationsEnabled()
    }

    /** bật trong app và được Android cho phép -> app tự báo được khi chạy nền */
    fun canNotify(ctx: Context): Boolean = Prefs.notifyOn && permissionGranted(ctx)

    // ---------- so trạng thái, báo thay đổi ----------

    /** So trạng thái mới với lần trước, báo các thay đổi đáng chú ý. */
    fun process(state: RemoteState) {
        val model = app ?: return
        val ctx = model.application
        val enabled = Prefs.notifyOn
        val next = HashMap<String, Snap>()
        for (s in state.live) {
            val remote = s.external != true || s.attached == true || s.pcAway == true
            val snap = Snap(s.status, s.pending, s.rate?.status == "rejected", remote)
            next[s.id] = snap
            val old = last[s.id]
            if (old != null && old.pending > 0 && snap.pending == 0) cancel(ctx, tagPerm(s.id))   // đã trả lời ở nơi khác (thiết bị khác / máy tính)
            val kind = NotifyRules.decide(primed, enabled, old, snap, watching(model, s.id)) ?: continue
            val title = s.title?.takeIf { it.isNotEmpty() } ?: (s.project ?: "Phiên Claude")
            when (kind) {
                NotifyKind.Permission -> {
                    val tool = s.ask?.tool ?: ""
                    val head = when (tool) {
                        "AskUserQuestion" -> "🙋 Claude đang hỏi m"
                        "ExitPlanMode" -> "📋 Kế hoạch chờ duyệt"
                        else -> "✋ Claude cần m duyệt $tool"
                    }
                    postPermission(model, s, head, "$title\n${s.ask?.summary ?: ""}", title)
                }
                NotifyKind.Limit -> postDone(model, s, "⚠️ Hết hạn mức", "$title — mở app để đổi tài khoản và chạy tiếp", false)
                NotifyKind.Done -> postDone(model, s, "✅ Xong việc", "$title\n${s.lastText ?: ""}", true)
                NotifyKind.Stopped -> postDone(model, s, "⏹ Claude đã dừng", title, false)
            }
        }
        // phiên không còn trong danh sách đang chạy: gỡ thông báo xin quyền của nó
        for (id in last.keys) if (id !in next) cancel(ctx, tagPerm(id))
        last.clear()
        last.putAll(next)

        // cảnh báo của máy (ngân sách, hạn mức, đăng nhập…): mới xuất hiện từ lần trước thì báo khi app không hiện
        val alerts = state.alerts ?: emptyList()
        if (primed && enabled && !model.inForeground) {
            for (a in alerts) if (a.id !in seenAlerts && a.id !in model.dismissedAlerts) postAlert(ctx, a)
        }
        seenAlerts.addAll(alerts.map { it.id })
        primed = true
    }

    private fun watching(model: AppModel, id: String) = model.activeSessionId == id && model.inForeground

    private fun tagPerm(sid: String) = "perm:$sid"
    private fun tagDone(sid: String) = "done:$sid"

    private fun openIntent(ctx: Context, machine: String, sid: String): PendingIntent {
        val i = Intent(Intent.ACTION_VIEW, Uri.parse("ccremote://session/$machine/$sid"))
            .setComponent(ComponentName(ctx, MainActivity::class.java))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        return PendingIntent.getActivity(ctx, ("open:$sid").hashCode(), i, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }

    private fun actionPending(ctx: Context, action: String, machine: String, sid: String, rid: String?, extra: Map<String, String> = emptyMap(), mutable: Boolean = false): PendingIntent {
        val i = Intent(ctx, NotificationActionReceiver::class.java).setAction(action)
            .putExtra(EXTRA_SID, sid).putExtra(EXTRA_MACHINE, machine).apply {
                if (rid != null) putExtra(EXTRA_REQUEST, rid)
                for ((k, v) in extra) putExtra(k, v)
            }
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or (if (mutable && Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else if (mutable) 0 else PendingIntent.FLAG_IMMUTABLE)
        return PendingIntent.getBroadcast(ctx, (action + sid + (rid ?: "")).hashCode(), i, flags)
    }

    private fun notify(ctx: Context, tag: String, n: android.app.Notification) {
        if (!permissionGranted(ctx)) return
        try {
            @Suppress("MissingPermission")
            NotificationManagerCompat.from(ctx).notify(tag, 1, n)
        } catch (_: SecurityException) {}
    }

    fun cancel(ctx: Context, tag: String) {
        NotificationManagerCompat.from(ctx).cancel(tag, 1)
    }

    /** Mở phiên rồi thì gỡ thông báo của phiên đó. */
    fun cancelFor(ctx: Context, sid: String) {
        cancel(ctx, tagPerm(sid))
        cancel(ctx, tagDone(sid))
    }

    fun cancelAll(ctx: Context) {
        NotificationManagerCompat.from(ctx).cancelAll()
    }

    /** Thông báo xin quyền / câu hỏi; lấy requestId của yêu cầu đang chờ để gắn nút Cho phép / Từ chối. */
    private fun postPermission(model: AppModel, s: SessionSummary, head: String, body: String, title: String) {
        val ctx = model.application
        val machine = model.machineId
        model.scope.launch {
            val req = try { fetchPending(model, machine, s.id) } catch (_: Exception) { null }
            val b = NotificationCompat.Builder(ctx, CH_PERM)
                .setSmallIcon(R.drawable.ic_notify).setContentTitle(head).setContentText(body.lineSequence().firstOrNull { it.isNotBlank() } ?: head)
                .setStyle(NotificationCompat.BigTextStyle().bigText(body.take(500)))
                .setContentIntent(openIntent(ctx, machine, s.id)).setAutoCancel(true)
                .setCategory(NotificationCompat.CATEGORY_MESSAGE).setPriority(NotificationCompat.PRIORITY_HIGH)
                .setOnlyAlertOnce(true)
            val rid = req?.requestId
            if (req != null && rid != null) {
                val qs = req.questions
                if (req.tool == "AskUserQuestion") {
                    // một câu hỏi: trả lời bằng chữ ngay trên thông báo (như ô "Khác" trong app)
                    if (qs != null && qs.size == 1) {
                        val ri = RemoteInput.Builder(KEY_REPLY).setLabel("Câu trả lời").build()
                        b.addAction(
                            NotificationCompat.Action.Builder(0, "Trả lời", actionPending(ctx, ACTION_ANSWER, machine, s.id, rid, mapOf(EXTRA_QUESTION to qs[0].question, EXTRA_TITLE to title), mutable = true))
                                .addRemoteInput(ri).setAllowGeneratedReplies(false).build(),
                        )
                    }
                } else {
                    val plan = req.tool == "ExitPlanMode"
                    b.addAction(0, if (plan) "Duyệt" else "Cho phép", actionPending(ctx, ACTION_ALLOW, machine, s.id, rid, mapOf(EXTRA_TITLE to title)))
                    b.addAction(0, if (plan) "Chưa" else "Từ chối", actionPending(ctx, ACTION_DENY, machine, s.id, rid, mapOf(EXTRA_TITLE to title)))
                }
            }
            notify(ctx, tagPerm(s.id), b.build())
        }
    }

    /** Xong lượt (có ô Trả lời → sessions.send) / bị dừng / hết hạn mức. */
    private fun postDone(model: AppModel, s: SessionSummary, head: String, body: String, canReply: Boolean) {
        val ctx = model.application
        val machine = model.machineId
        val b = NotificationCompat.Builder(ctx, CH_DONE)
            .setSmallIcon(R.drawable.ic_notify).setContentTitle(head).setContentText(body.lineSequence().firstOrNull { it.isNotBlank() } ?: head)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body.take(500)))
            .setContentIntent(openIntent(ctx, machine, s.id)).setAutoCancel(true).setCategory(NotificationCompat.CATEGORY_MESSAGE)
        if (canReply) {
            val ri = RemoteInput.Builder(KEY_REPLY).setLabel("Nhắn cho Claude").build()
            b.addAction(
                NotificationCompat.Action.Builder(0, "Trả lời", actionPending(ctx, ACTION_REPLY, machine, s.id, null, mapOf(EXTRA_TITLE to (s.title ?: "")), mutable = true))
                    .addRemoteInput(ri).setAllowGeneratedReplies(false).build(),
            )
        }
        notify(ctx, tagDone(s.id), b.build())
    }

    private fun postAlert(ctx: Context, a: PCAlert) {
        val i = Intent(ctx, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        val pi = PendingIntent.getActivity(ctx, 7001, i, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val icon = when (a.level) { "critical" -> "🛑 "; "warning" -> "⚠️ "; else -> "" }
        val n = NotificationCompat.Builder(ctx, CH_ALERT)
            .setSmallIcon(R.drawable.ic_notify).setContentTitle(icon + a.title).setContentText(a.body ?: "")
            .setStyle(NotificationCompat.BigTextStyle().bigText(a.body ?: "")).setContentIntent(pi).setAutoCancel(true)
            .setCategory(NotificationCompat.CATEGORY_STATUS).build()
        notify(ctx, "alert:${a.id.toLong()}", n)
    }

    // ---------- lấy yêu cầu đang chờ / trả lời từ thông báo ----------

    /**
     * Sự kiện `permission` đang chờ của phiên: `sub` một lần (after=0, epoch rỗng -> phát lại toàn bộ), đọc tới sự kiện `state`
     * (hết phần phát lại) rồi thôi theo dõi. Hub chỉ có `sessions.get` trả tóm tắt, không có requestId.
     */
    suspend fun fetchPending(model: AppModel, machine: String, sid: String): Event? {
        val hub = model.hub ?: return null
        val api = ApiClient(hub, machine)
        val events = ArrayList<Event>()
        withTimeoutOrNull(8000) {
            api.events(sid, 0, "").transformWhile { emit(it); it["kind"]?.jsonPrimitive?.contentOrNull != "state" }.collect { o: JsonObject ->
                val kind = o["kind"]?.jsonPrimitive?.contentOrNull
                if (kind == "permission" || kind == "decided") {
                    try { events.add(AppJson.decodeFromJsonElement(Event.serializer(), o)) } catch (_: Exception) {}
                }
            }
        }
        return pendingPermission(events)
    }

    /** Trả lời xin quyền từ thông báo. true nếu hub nhận. */
    suspend fun decide(model: AppModel, machine: String, sid: String, rid: String, decision: String, answers: Map<String, String>? = null): Boolean {
        val hub = model.hub ?: return false
        val body = LinkedHashMap<String, Any?>()
        body["id"] = sid
        body["requestId"] = rid
        body["decision"] = decision
        if (answers != null) body["answers"] = answers
        ApiClient(hub, machine).call<SessionSummary>("sessions.permission", jsonOf(*body.map { it.key to it.value }.toTypedArray()))
        return true
    }

    suspend fun reply(model: AppModel, machine: String, sid: String, text: String): Boolean {
        val hub = model.hub ?: return false
        ApiClient(hub, machine).call<SessionSummary>("sessions.send", jsonOf("id" to sid, "text" to text))
        return true
    }

    /** Thay thông báo bằng một dòng xác nhận ngắn (cũng dừng vòng quay của ô Trả lời), tự biến mất sau vài giây. */
    fun ack(ctx: Context, tag: String, channel: String, text: String, title: String) {
        val b = NotificationCompat.Builder(ctx, channel)
            .setSmallIcon(R.drawable.ic_notify).setContentTitle(text).setContentText(title).setTimeoutAfter(4000).setAutoCancel(true)
            .setOnlyAlertOnce(true).setSilent(true)
        notify(ctx, tag, b.build())
    }

    fun errorText(e: Exception): String = when {
        e is ApiError && e.code == "NOT_PENDING" -> "Đã được trả lời ở nơi khác"
        e is ApiError -> e.message
        else -> e.message ?: "Lỗi"
    }

    /** Dùng ở nơi chỉ có Context (Service, Receiver). */
    fun model(): AppModel = AppGraph.model
}

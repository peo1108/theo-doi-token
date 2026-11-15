package vn.peo.ccremote.notify

/** Luật "cái gì báo, khi nào" của Notifier.swift, tách ra thuần Kotlin để test. */
class Snap(val status: String, val pending: Int, val rejected: Boolean, val remote: Boolean)

enum class NotifyKind { Permission, Limit, Done, Stopped }

object NotifyRules {
    /**
     * @param old trạng thái lần trước của phiên (null: phiên mới xuất hiện -> không báo)
     * @param watching phiên đang mở trên màn hình khi app hiện
     */
    fun decide(primed: Boolean, enabled: Boolean, old: Snap?, now: Snap, watching: Boolean): NotifyKind? {
        if (!primed || !enabled || old == null) return null
        if (watching) return null
        // phiên VS Code / terminal trên máy: chỉ báo khi đang điều khiển từ điện thoại hoặc máy để yên (như hub);
        // ngồi máy làm việc thì không rung điện thoại, rời máy mà câu hỏi vẫn chờ thì báo lúc đó
        if (!now.remote) return null
        val wasBusy = old.status == "running" || old.status == "starting" || old.status == "waiting"
        return when {
            now.pending > 0 && (now.pending > old.pending || !old.remote) -> NotifyKind.Permission
            !old.rejected && now.rejected -> NotifyKind.Limit
            wasBusy && now.status == "idle" -> NotifyKind.Done
            wasBusy && now.status == "off" -> NotifyKind.Stopped
            else -> null
        }
    }
}

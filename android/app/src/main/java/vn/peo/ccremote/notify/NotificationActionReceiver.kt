package vn.peo.ccremote.notify

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.app.RemoteInput
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeout
import vn.peo.ccremote.AppGraph
import vn.peo.ccremote.data.Prefs

/**
 * Nút trên thông báo: Cho phép / Từ chối (sessions.permission), Trả lời (sessions.send hoặc trả lời câu hỏi),
 * "Tắt" của thông báo kết nối nền. Gọi hub qua kết nối của dịch vụ nền, không cần mở app.
 */
class NotificationActionReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        val action = intent.action ?: return
        if (action == Notifier.ACTION_STOP_SERVICE) {
            Prefs.keepAlive = false
            HubServiceControl.sync(ctx)
            return
        }
        val sid = intent.getStringExtra(Notifier.EXTRA_SID) ?: return
        val machine = intent.getStringExtra(Notifier.EXTRA_MACHINE) ?: return
        val rid = intent.getStringExtra(Notifier.EXTRA_REQUEST)
        val title = intent.getStringExtra(Notifier.EXTRA_TITLE) ?: ""
        val typed = RemoteInput.getResultsFromIntent(intent)?.getCharSequence(Notifier.KEY_REPLY)?.toString()?.trim()
        val model = AppGraph.model
        val pending = goAsync()
        model.scope.launch {
            try {
                withTimeout(9000) {
                    when (action) {
                        Notifier.ACTION_ALLOW -> {
                            Notifier.decide(model, machine, sid, rid ?: return@withTimeout, "allow")
                            Notifier.ack(ctx, "perm:$sid", Notifier.CH_DONE, "Đã cho phép", title)
                        }
                        Notifier.ACTION_DENY -> {
                            Notifier.decide(model, machine, sid, rid ?: return@withTimeout, "deny")
                            Notifier.ack(ctx, "perm:$sid", Notifier.CH_DONE, "Đã từ chối", title)
                        }
                        Notifier.ACTION_ANSWER -> {
                            val q = intent.getStringExtra(Notifier.EXTRA_QUESTION) ?: return@withTimeout
                            if (typed.isNullOrEmpty()) return@withTimeout
                            Notifier.decide(model, machine, sid, rid ?: return@withTimeout, "allow", mapOf(q to typed))
                            Notifier.ack(ctx, "perm:$sid", Notifier.CH_DONE, "Đã trả lời", title)
                        }
                        Notifier.ACTION_REPLY -> {
                            if (typed.isNullOrEmpty()) return@withTimeout
                            Notifier.reply(model, machine, sid, typed)
                            Notifier.ack(ctx, "done:$sid", Notifier.CH_DONE, "Đã gửi cho Claude", title)
                        }
                    }
                }
                model.refresh()
            } catch (e: Exception) {
                if (e is kotlinx.coroutines.CancellationException && e !is TimeoutCancellationException) throw e
                val tag = if (action == Notifier.ACTION_REPLY) "done:$sid" else "perm:$sid"
                Notifier.ack(ctx, tag, Notifier.CH_DONE, if (e is TimeoutCancellationException) "Máy không phản hồi" else Notifier.errorText(e), title)
            } finally {
                pending.finish()
            }
        }
    }
}

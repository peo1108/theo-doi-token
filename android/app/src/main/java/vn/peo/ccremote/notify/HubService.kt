package vn.peo.ccremote.notify

import android.app.Notification
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import vn.peo.ccremote.AppGraph
import vn.peo.ccremote.MainActivity
import vn.peo.ccremote.R
import vn.peo.ccremote.data.Prefs

/**
 * Dịch vụ foreground (loại remoteMessaging) giữ app chạy nền để có một kết nối hub duy nhất cho cả tiến trình:
 * thông báo tức thì khi Claude hỏi / xong việc, không cần ntfy. Bật mặc định sau khi đăng nhập, tắt trong Cài đặt.
 * Kết nối (HubClient) do AppModel giữ; dịch vụ báo cho AppModel biết đang chạy để nó gửi presence {foreground:false, notifies:true}.
 */
class HubService : Service() {
    companion object {
        const val NOTIF_ID = 4001

        @Volatile var running = false
            private set

        fun intent(ctx: Context) = Intent(ctx, HubService::class.java)
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        Notifier.createChannels(this)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val model = AppGraph.model
        val open = PendingIntent.getActivity(
            this, 1, Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val off = PendingIntent.getBroadcast(
            this, 2, Intent(this, NotificationActionReceiver::class.java).setAction(Notifier.ACTION_STOP_SERVICE),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val n: Notification = NotificationCompat.Builder(this, Notifier.CH_CONN)
            .setSmallIcon(R.drawable.ic_notify).setContentTitle("Đang giữ kết nối với hub")
            .setContentText("CC Remote báo ngay khi Claude hỏi hoặc xong việc")
            .setOngoing(true).setShowWhen(false).setSilent(true).setPriority(NotificationCompat.PRIORITY_LOW)
            .setCategory(NotificationCompat.CATEGORY_SERVICE).setContentIntent(open)
            .addAction(0, "Tắt", off).build()
        // phải gọi startForeground ngay (Android bắt buộc sau startForegroundService) rồi mới quyết định có chạy tiếp không
        if (Build.VERSION.SDK_INT >= 34) {
            ServiceCompat.startForeground(this, NOTIF_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING)
        } else {
            startForeground(NOTIF_ID, n)
        }
        if (!Prefs.keepAlive || !model.isPaired) {
            stopSelf()
            return START_NOT_STICKY
        }
        running = true
        model.serviceRunning = true
        model.applyPresence()
        return START_STICKY
    }

    override fun onDestroy() {
        running = false
        val model = AppGraph.model
        model.serviceRunning = false
        model.applyPresence()   // ở nền mà không còn dịch vụ: ngắt kết nối như iOS, ntfy lo phần còn lại
        super.onDestroy()
    }
}

/** Bật / tắt dịch vụ nền theo cài đặt "Giữ kết nối nền" và trạng thái đăng nhập. */
object HubServiceControl {
    fun sync(ctx: Context) {
        val want = Prefs.keepAlive && AppGraph.model.isPaired
        try {
            if (want) ContextCompat.startForegroundService(ctx, HubService.intent(ctx))
            else ctx.stopService(HubService.intent(ctx))
        } catch (_: Exception) {
            // Android 12+ không cho bật dịch vụ foreground khi app đang ở nền (trừ khởi động máy): bỏ qua, lần mở app sau bật lại
        }
    }
}

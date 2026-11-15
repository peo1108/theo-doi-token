package vn.peo.ccremote.notify

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import vn.peo.ccremote.data.Prefs
import vn.peo.ccremote.data.SecureStore

/** Khởi động máy (hoặc app vừa được cập nhật) -> bật lại kết nối nền nếu đang bật và còn đăng nhập. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        val a = intent.action
        if (a != Intent.ACTION_BOOT_COMPLETED && a != Intent.ACTION_MY_PACKAGE_REPLACED) return
        if (Prefs.keepAlive && SecureStore.get("hubToken") != null) HubServiceControl.sync(ctx)
    }
}

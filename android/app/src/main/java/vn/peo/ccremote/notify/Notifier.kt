package vn.peo.ccremote.notify

import android.content.Context

object Notifier {
    fun canNotify(ctx: Context): Boolean = false
    fun permissionGranted(ctx: Context): Boolean = true
}

object HubServiceControl {
    fun sync(ctx: Context) {}
}

package vn.peo.ccremote.ui

import android.Manifest
import android.os.Build
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.ui.platform.LocalContext
import vn.peo.ccremote.AppModel
import vn.peo.ccremote.data.Prefs
import vn.peo.ccremote.data.Route
import vn.peo.ccremote.notify.Notifier

/** Đăng nhập rồi vào ngăn xếp màn hình (= RootView + NavigationStack của iOS). */
@Composable
fun RootView(app: AppModel) {
    if (app.isPaired) PairedRoot(app) else LoginScreen(app)
}

@Composable
private fun PairedRoot(app: AppModel) {
    val ctx = LocalContext.current
    // Android 13+: xin quyền thông báo một lần khi bật kết nối nền (sau đó chỉnh trong Cài đặt)
    val permLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { app.applyPresence() }
    LaunchedEffect(Unit) {
        if (Build.VERSION.SDK_INT >= 33 && Prefs.notifyOn && Prefs.keepAlive && !Notifier.permissionGranted(ctx) && !Prefs.bool("askedNotif")) {
            Prefs.putBool("askedNotif", true)
            permLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
    }

    BackHandler(enabled = app.path.isNotEmpty()) { app.pop() }
    val holder = rememberSaveableStateHolder()
    val top = app.path.lastOrNull()
    val key = when (top) {
        null -> "home"
        is Route.Session -> "s:${top.id}"
        is Route.Project -> "p:${top.cwd}"
        is Route.NewSession -> "new:${top.presetCwd}"
        Route.Settings -> "settings"
    }
    holder.SaveableStateProvider(key) {
        when (top) {
            null -> HomeScreen(app)
            is Route.Session -> SessionScreen(app, top.id)
            is Route.Project -> ProjectScreen(app, top.cwd)
            is Route.NewSession -> NewSessionScreen(app, top.presetCwd)
            Route.Settings -> SettingsScreen(app)
        }
    }
}

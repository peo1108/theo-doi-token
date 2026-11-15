package vn.peo.ccremote.ui

import androidx.activity.compose.BackHandler
import androidx.compose.runtime.Composable
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import vn.peo.ccremote.AppModel
import vn.peo.ccremote.data.Route

/** Đăng nhập rồi vào ngăn xếp màn hình (= RootView + NavigationStack của iOS). */
@Composable
fun RootView(app: AppModel) {
    if (!app.isPaired) {
        LoginScreen(app)
        return
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

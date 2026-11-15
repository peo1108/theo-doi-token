package vn.peo.ccremote

import android.content.Intent
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import vn.peo.ccremote.data.Route

/**
 * Chỉ có trong bản debug (không tồn tại trong release). android/tools/smoke.sh gọi:
 *   am start -n vn.peo.ccremote/.MainActivity --es smoke_hub http://10.0.2.2:7790 --es smoke_token <token> --es smoke_machine <id>
 *   [--es smoke_open <phiên>] [--es smoke_screen settings|project|new|home] [--ez smoke_logout true]
 */
object DebugHooks {
    @JvmStatic
    fun handle(intent: Intent, app: AppModel) {
        if (intent.getBooleanExtra("smoke_logout", false)) {
            app.logout(remote = false)
            return
        }
        val hub = intent.getStringExtra("smoke_hub")
        val token = intent.getStringExtra("smoke_token")
        if (hub != null && token != null) app.adoptToken(hub, token, intent.getStringExtra("smoke_machine"))
        intent.getStringExtra("smoke_open")?.let { app.openSession(it) }
        when (val screen = intent.getStringExtra("smoke_screen")) {
            null -> {}
            "home" -> app.path.clear()
            "settings" -> { app.path.clear(); app.path.add(Route.Settings) }
            "new" -> { app.path.clear(); app.path.add(Route.NewSession()) }
            "project" -> app.scope.launch {   // dự án đầu tiên của máy (đợi state tải xong)
                while (app.state?.projects.isNullOrEmpty()) delay(300)
                app.path.clear()
                app.path.add(Route.Project(app.state!!.projects!!.first().cwd))
            }
        }
    }
}

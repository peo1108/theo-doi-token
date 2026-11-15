package vn.peo.ccremote

import android.app.Application
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import okhttp3.OkHttpClient
import vn.peo.ccremote.data.Prefs
import vn.peo.ccremote.data.SecureStore
import vn.peo.ccremote.notify.Notifier
import java.util.concurrent.TimeUnit

/** Dựng tay các đối tượng dùng chung (không Hilt). */
object AppGraph {
    lateinit var app: App
        internal set
    val http: OkHttpClient by lazy {
        OkHttpClient.Builder()
            .pingInterval(20, TimeUnit.SECONDS)
            .connectTimeout(15, TimeUnit.SECONDS)
            .build()
    }
    val model: AppModel by lazy { AppModel(app, http) }
}

class App : Application() {
    override fun onCreate() {
        super.onCreate()
        AppGraph.app = this
        Prefs.init(this)
        SecureStore.init(this)
        Notifier.setup(AppGraph.model)
        ProcessLifecycleOwner.get().lifecycle.addObserver(object : DefaultLifecycleObserver {
            override fun onStart(owner: LifecycleOwner) {
                val m = AppGraph.model
                m.inForeground = true
                m.applyPresence()
            }

            override fun onStop(owner: LifecycleOwner) {
                val m = AppGraph.model
                m.inForeground = false
                m.applyPresence()
            }
        })
    }
}

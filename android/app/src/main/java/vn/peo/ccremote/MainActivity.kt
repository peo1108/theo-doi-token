package vn.peo.ccremote

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import vn.peo.ccremote.ui.RootView
import vn.peo.ccremote.ui.theme.CCRemoteTheme

class MainActivity : ComponentActivity() {
    private val app get() = AppGraph.model

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        handleIntent(intent)
        setContent { CCRemoteTheme { RootView(app) } }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleIntent(intent)
    }

    /** Deep link ccremote://session/<máy>/<phiên> (ntfy, thông báo) -> mở thẳng phiên. */
    private fun handleIntent(intent: Intent?) {
        intent?.data?.let { app.open(it) }
    }
}

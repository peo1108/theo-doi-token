package vn.peo.ccremote.ui

import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import vn.peo.ccremote.AppModel

@Composable
fun SessionScreen(app: AppModel, id: String) {
    Text("Phiên $id")
}

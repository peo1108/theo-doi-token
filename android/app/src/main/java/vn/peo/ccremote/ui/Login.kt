package vn.peo.ccremote.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Terminal
import androidx.compose.material3.Button
import androidx.compose.material3.CenterAlignedTopAppBar
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusDirection
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import vn.peo.ccremote.AppModel
import vn.peo.ccremote.data.ApiError
import vn.peo.ccremote.data.Prefs

/** Đăng nhập hub trên VPS bằng tài khoản admin tạo trên trang web của hub. Đăng nhập một lần dùng mãi — chỉ mất khi tự đăng xuất. */
@Composable
fun LoginScreen(app: AppModel) {
    var url by remember { mutableStateOf(Prefs.hubUrl) }
    var username by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    val focus = LocalFocusManager.current

    fun go() {
        if (busy || username.trim().length < 3 || password.isEmpty()) return
        scope.launch {
            busy = true
            error = null
            try {
                app.login(url, username, password)
                password = ""
            } catch (e: Exception) {
                if (e is kotlinx.coroutines.CancellationException) throw e
                error = (e as? ApiError)?.message ?: e.message ?: "Lỗi không rõ"
            }
            busy = false
        }
    }

    Scaffold(
        topBar = { CenterAlignedTopAppBar(title = { Text("CC Remote") }, colors = TopAppBarDefaults.topAppBarColors()) },
    ) { pad ->
        Column(
            Modifier.fillMaxSize().padding(pad).imePadding().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 8.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            SectionCard {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Icon(Icons.Filled.Terminal, null, Modifier.size(38.dp), tint = MaterialTheme.colorScheme.primary)
                    Text("Điều khiển Claude Code trên máy tính từ điện thoại", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
                    Text(
                        "Đăng nhập tài khoản hub (admin tạo cho bạn trên trang web của hub). Máy tính đăng nhập cùng tài khoản " +
                            "(dashboard → thẻ Điện thoại → Kết nối hub) sẽ hiện ra ở đây.",
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }

            SectionCard("Tài khoản") {
                Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    OutlinedTextField(
                        value = username, onValueChange = { username = it }, label = { Text("Tên đăng nhập") }, singleLine = true,
                        modifier = Modifier.fillMaxWidth(),
                        keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false, imeAction = ImeAction.Next),
                        keyboardActions = KeyboardActions(onNext = { focus.moveFocus(FocusDirection.Down) }),
                    )
                    OutlinedTextField(
                        value = password, onValueChange = { password = it }, label = { Text("Mật khẩu") }, singleLine = true,
                        visualTransformation = PasswordVisualTransformation(), modifier = Modifier.fillMaxWidth(),
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, autoCorrectEnabled = false, imeAction = ImeAction.Done),
                        keyboardActions = KeyboardActions(onDone = { focus.clearFocus(); go() }),
                    )
                }
            }

            SectionCard("Hub") {
                Column(Modifier.padding(12.dp)) {
                    OutlinedTextField(
                        value = url, onValueChange = { url = it }, placeholder = { Text(AppModel.DEFAULT_HUB) }, singleLine = true,
                        modifier = Modifier.fillMaxWidth(),
                        textStyle = MaterialTheme.typography.bodyMedium,
                        keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false, keyboardType = KeyboardType.Uri),
                    )
                }
            }

            error?.let { e ->
                SectionCard { Column(Modifier.padding(16.dp)) { ErrorLabel(e) } }
            }

            Row(Modifier.padding(horizontal = 16.dp)) {
                Button(
                    onClick = { focus.clearFocus(); go() },
                    enabled = !busy && username.trim().length >= 3 && password.isNotEmpty(),
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    if (busy) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp, color = MaterialTheme.colorScheme.onPrimary)
                    else Text("Đăng nhập", fontWeight = FontWeight.Bold)
                }
            }
        }
    }
}

package vn.peo.ccremote.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Laptop
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CenterAlignedTopAppBar
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import vn.peo.ccremote.AppModel
import vn.peo.ccremote.data.ModelInfo
import vn.peo.ccremote.data.PermissionMode
import vn.peo.ccremote.data.effortLabel
import vn.peo.ccremote.session.SessionModel
import vn.peo.ccremote.ui.theme.Semantic

/**
 * Cài đặt của một phiên, giống menu Model trong VS Code: model, effort, thinking, fast mode,
 * tự đổi model khi bị flag, quyền, output style. Đổi xong áp dụng ngay (kể cả khi Claude đang chạy).
 */
@Composable
fun SessionSettingsScreen(app: AppModel, model: SessionModel, onClose: () -> Unit) {
    val scope = rememberCoroutineScope()
    var confirmClose by remember { mutableStateOf(false) }
    var pickModel by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) { app.loadCaps() }

    val s = model.summary?.settings
    val models: List<ModelInfo> = app.caps?.models ?: emptyList()
    val current = models.firstOrNull { it.value == s?.modelValue }
    val efforts = current?.efforts ?: app.caps?.efforts?.takeIf { it.isNotEmpty() } ?: listOf("low", "medium", "high", "xhigh", "max")

    fun send(body: Map<String, Any?>) {
        val api = app.api ?: return
        scope.launch { model.applySettings(body, api) }
    }

    Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
        Scaffold(
            topBar = {
                CenterAlignedTopAppBar(
                    title = { Text("Cài đặt phiên") },
                    navigationIcon = { BackButton(onClose) },
                    actions = { TextButton(onClick = onClose) { Text("Xong") } },
                )
            },
        ) { pad ->
            Column(Modifier.fillMaxSize().padding(pad).verticalScroll(rememberScrollState())) {
                if (model.summary?.external == true) {
                    SectionCard {
                        Row(Modifier.padding(16.dp), horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.Top) {
                            Icon(Icons.Outlined.Laptop, null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
                            Text(
                                "Phiên này đang chạy trên ${model.summary?.source ?: "máy tính"}. Model, effort, quyền đổi ngay trong VS Code; " +
                                    "ở đây chỉ áp dụng khi phiên được mở lại từ điện thoại.",
                                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                }

                SectionCard("Model") {
                    val curLabel = current?.label ?: s?.modelLabel ?: s?.modelValue ?: "Mặc định"
                    Row(
                        Modifier.fillMaxWidth().clickable { pickModel = true }.padding(horizontal = 16.dp, vertical = 12.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text("Đổi model", Modifier.weight(1f))
                        Text(curLabel, color = MaterialTheme.colorScheme.primary, maxLines = 1)
                    }
                    if (efforts.isNotEmpty()) {
                        RowDivider()
                        Column(Modifier.padding(horizontal = 16.dp, vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            Row {
                                Text("Effort")
                                Text(" (${effortLabel(s?.effort)})", color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                            SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
                                efforts.forEachIndexed { i, e ->
                                    SegmentedButton(
                                        selected = (s?.effort ?: "") == e, onClick = { send(mapOf("effort" to e)) },
                                        shape = SegmentedButtonDefaults.itemShape(i, efforts.size), label = { Text(effortLabel(e), maxLines = 1) },
                                    )
                                }
                            }
                        }
                    }
                    RowDivider()
                    ToggleRow("Thinking", null, s?.thinking ?: false, enabled = !(current != null && !current.thinking)) { send(mapOf("thinking" to it)) }
                    if (current?.fast == true) {
                        RowDivider()
                        ToggleRow("Fast mode", null, s?.fast ?: false) { send(mapOf("fast" to it)) }
                    }
                    RowDivider()
                    ToggleRow("Đổi model khi tin nhắn bị flag", "Tắt thì phiên sẽ dừng lại thay vì đổi model", s?.flagSwitch ?: false) { send(mapOf("flagSwitch" to it)) }
                }

                SectionCard("Quyền") {
                    val mode = PermissionMode.of(model.summary?.mode)
                    DropdownField("Chế độ", mode.label, PermissionMode.entries.map { it.label to it }, { send(mapOf("mode" to it.raw)) })
                }

                val styles = app.caps?.outputStyles
                if (styles != null && styles.size > 1) {
                    SectionCard("Kiểu trả lời") {
                        val cur = s?.outputStyle ?: "default"
                        DropdownField(
                            "Output style", if (cur == "default") "Mặc định" else cur,
                            styles.map { (if (it == "default") "Mặc định" else it) to it }, { send(mapOf("outputStyle" to it)) },
                        )
                    }
                }

                SectionCard("Phiên") {
                    var first = true
                    model.summary?.account?.let { acc ->
                        InfoRow("Tài khoản", acc)
                        first = false
                    }
                    model.summary?.cwd?.let { cwd ->
                        if (!first) RowDivider()
                        InfoRow("Thư mục", cwd, mono = true)
                        first = false
                    }
                    model.summary?.cost?.takeIf { it > 0 }?.let { c ->
                        if (!first) RowDivider()
                        InfoRow("Chi phí (quy đổi)", String.format(java.util.Locale.US, "$%.2f", c))
                        first = false
                    }
                    model.summary?.rate?.fiveHour?.let { h ->
                        if (!first) RowDivider()
                        InfoRow("Hạn mức 5 giờ", "${Math.round(h)}%")
                        first = false
                    }
                    model.summary?.rate?.sevenDay?.let { d ->
                        if (!first) RowDivider()
                        InfoRow("Hạn mức 7 ngày", "${Math.round(d)}%")
                        first = false
                    }
                    if (model.summary?.live == true) {
                        if (!first) RowDivider()
                        ClickRow({ confirmClose = true }) { Text("Tắt tiến trình Claude", color = Semantic.red()) }
                    }
                }
            }
        }
    }

    if (pickModel) {
        AlertDialog(
            onDismissRequest = { pickModel = false },
            title = { Text("Đổi model") },
            text = {
                Column(Modifier.verticalScroll(rememberScrollState())) {
                    if (models.isEmpty()) Text("Chưa tải được danh sách model từ máy.", color = MaterialTheme.colorScheme.onSurfaceVariant)
                    models.forEach { m ->
                        Row(
                            Modifier.fillMaxWidth().clickable { pickModel = false; send(mapOf("model" to m.value)) }.padding(vertical = 6.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            RadioButton(selected = m.value == s?.modelValue, onClick = { pickModel = false; send(mapOf("model" to m.value)) })
                            Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                                Text(m.label)
                                if (m.description.isNotEmpty()) Text(m.description, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                        }
                    }
                }
            },
            confirmButton = { TextButton(onClick = { pickModel = false }) { Text("Đóng") } },
        )
    }
    if (confirmClose) {
        AlertDialog(
            onDismissRequest = { confirmClose = false },
            title = { Text("Tắt tiến trình Claude của phiên này?") },
            text = { Text("Lịch sử vẫn giữ. Gửi tin nhắn mới sẽ mở lại phiên với cài đặt này.") },
            confirmButton = {
                TextButton(onClick = {
                    confirmClose = false
                    val api = app.api ?: return@TextButton
                    scope.launch { model.close(api) }
                }) { Text("Tắt", color = Semantic.red()) }
            },
            dismissButton = { TextButton(onClick = { confirmClose = false }) { Text("Huỷ") } },
        )
    }
}

@Composable
private fun ToggleRow(label: String, sub: String?, checked: Boolean, enabled: Boolean = true, onChange: (Boolean) -> Unit) {
    Row(
        Modifier.fillMaxWidth().then(if (enabled) Modifier.clickable { onChange(!checked) } else Modifier).padding(horizontal = 16.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(label, color = if (enabled) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.onSurface.copy(alpha = 0.4f))
            if (sub != null) Text(sub, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Switch(checked = checked, onCheckedChange = onChange, enabled = enabled)
    }
}

@Composable
private fun InfoRow(label: String, value: String, mono: Boolean = false) {
    Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Text(label)
        Text(
            value, Modifier.weight(1f), textAlign = TextAlign.End, color = MaterialTheme.colorScheme.onSurfaceVariant,
            style = if (mono) MaterialTheme.typography.bodySmall.copy(fontFamily = Mono) else MaterialTheme.typography.bodyMedium,
        )
    }
}

package vn.peo.ccremote.ui

import android.Manifest
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.clickable
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CenterAlignedTopAppBar
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import vn.peo.ccremote.AppModel
import vn.peo.ccremote.data.ApiError
import vn.peo.ccremote.data.HubDevice
import vn.peo.ccremote.data.Prefs
import vn.peo.ccremote.data.jsonOf
import vn.peo.ccremote.notify.HubServiceControl
import vn.peo.ccremote.notify.Notifier
import vn.peo.ccremote.ui.theme.Semantic
import java.text.DateFormat
import java.util.Date

@Composable
fun SettingsScreen(app: AppModel) {
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    var notifyOn by remember { mutableStateOf(Prefs.notifyOn) }
    var keepAlive by remember { mutableStateOf(Prefs.keepAlive) }
    var alwaysOnError by remember { mutableStateOf<String?>(null) }
    var notifyGranted by remember { mutableStateOf(Notifier.permissionGranted(ctx)) }
    var batteryOk by remember { mutableStateOf(isIgnoringBattery(ctx)) }

    // quay lại từ Cài đặt Android (cấp quyền thông báo / tắt tối ưu pin) -> đọc lại
    val owner = LocalLifecycleOwner.current
    DisposableEffect(owner) {
        val obs = LifecycleEventObserver { _, e ->
            if (e == Lifecycle.Event.ON_RESUME) {
                notifyGranted = Notifier.permissionGranted(ctx)
                batteryOk = isIgnoringBattery(ctx)
                app.applyPresence()
            }
        }
        owner.lifecycle.addObserver(obs)
        onDispose { owner.lifecycle.removeObserver(obs) }
    }

    val permLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        notifyGranted = granted || Notifier.permissionGranted(ctx)
        app.applyPresence()
    }

    Scaffold(
        topBar = {
            CenterAlignedTopAppBar(
                title = { Text("Cài đặt") },
                navigationIcon = { BackButton { app.pop() } },
                actions = { TextButton(onClick = { app.pop() }) { Text("Xong") } },
            )
        },
    ) { pad ->
        Column(Modifier.fillMaxSize().padding(pad).verticalScroll(rememberScrollState())) {
            HubSettingsSection(app)

            SectionCard(
                "Thông báo trên điện thoại",
                footer = "Báo khi Claude hỏi / xin quyền, xong việc, bị dừng hoặc hết hạn mức; bấm vào là mở đúng phiên, xin quyền có nút " +
                    "Cho phép / Từ chối ngay trên thông báo. \"Giữ kết nối nền\" chạy một dịch vụ (hiện một thông báo nhỏ thường trực) để vẫn báo " +
                    "khi tắt màn hình — tốn pin hơn một chút. Vuốt app khỏi đa nhiệm hoặc tắt hẳn dịch vụ thì dùng ntfy ở mục Hub.",
            ) {
                SwitchRow("Thông báo", notifyOn) { v ->
                    notifyOn = v
                    Prefs.notifyOn = v
                    if (v && !notifyGranted && Build.VERSION.SDK_INT >= 33) permLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
                    app.applyPresence()
                }
                RowDivider()
                SwitchRow("Giữ kết nối nền", keepAlive) { v ->
                    keepAlive = v
                    Prefs.keepAlive = v
                    if (v && !notifyGranted && Build.VERSION.SDK_INT >= 33) permLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
                    HubServiceControl.sync(ctx)
                }
                if (!notifyGranted) {
                    RowDivider()
                    ClickRow({ openNotificationSettings(ctx) }) {
                        Text("Mở Cài đặt Android để cho phép thông báo", color = MaterialTheme.colorScheme.primary)
                    }
                }
                if (keepAlive && !batteryOk) {
                    RowDivider()
                    ClickRow({ openBatterySettings(ctx) }) {
                        Text("Tắt tối ưu pin cho app (khuyên dùng)", color = MaterialTheme.colorScheme.primary)
                        Text(
                            "Android hay dừng app ở nền để tiết kiệm pin; tắt tối ưu để kết nối nền không bị cắt.",
                            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            }

            SectionCard(
                "Phiên VS Code / terminal",
                footer = "Bật: phiên Claude Code trên máy (đã cài hook) luôn chờ sau mỗi lượt, mở app là nhắn được, gõ ở máy vẫn bình thường. " +
                    "Rời máy quá 45 giây thì xin quyền hiện trên điện thoại. Tắt: phải gõ /phone trong VS Code trước.",
            ) {
                SwitchRow("Luôn sẵn sàng nhận lệnh", app.state?.alwaysOn ?: true) { v ->
                    scope.launch {
                        try {
                            app.setAlwaysOn(v)
                            alwaysOnError = null
                        } catch (e: Exception) {
                            if (e is kotlinx.coroutines.CancellationException) throw e
                            alwaysOnError = (e as? ApiError)?.message ?: e.message
                        }
                    }
                }
                alwaysOnError?.let { e ->
                    RowDivider()
                    ClickRow(null) { ErrorLabel(e) }
                }
            }
            Gap(24)
        }
    }
}

@Composable
private fun SwitchRow(label: String, checked: Boolean, onChange: (Boolean) -> Unit) {
    Row(
        Modifier.fillMaxWidth().clickable { onChange(!checked) }.padding(horizontal = 16.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(label, Modifier.weight(1f))
        Switch(checked = checked, onCheckedChange = onChange)
    }
}

@Composable
private fun LabeledRow(label: String, content: @Composable () -> Unit) {
    Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Text(label)
        Row(Modifier.weight(1f), horizontalArrangement = Arrangement.End) { content() }
    }
}

/** Cài đặt hub: tài khoản, máy, thông báo ntfy (topic do hub cấp), thiết bị, đăng xuất. */
@Composable
fun HubSettingsSection(app: AppModel) {
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    var devices by remember { mutableStateOf<List<HubDevice>>(emptyList()) }
    var message by remember { mutableStateOf<String?>(null) }
    var confirmLogout by remember { mutableStateOf(false) }
    var confirmAll by remember { mutableStateOf(false) }
    var passwordDialog by remember { mutableStateOf(false) }
    var sendOriginal by remember { mutableStateOf(Prefs.sendOriginal) }

    suspend fun loadDevices() {
        try {
            devices = app.hubCall("devices")
        } catch (e: Exception) {
            if (e is kotlinx.coroutines.CancellationException) throw e
            message = (e as? ApiError)?.message ?: e.message
        }
    }
    LaunchedEffect(Unit) { loadDevices() }

    SectionCard("Hub") {
        LabeledRow("Tài khoản") { Text(app.hub?.username ?: "—", color = MaterialTheme.colorScheme.onSurfaceVariant) }
        RowDivider()
        LabeledRow("Hub") {
            SelectionContainer {
                Text(app.hubURL, style = MaterialTheme.typography.bodySmall.copy(fontFamily = Mono), color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        RowDivider()
        LabeledRow("Máy tính") { Text(app.currentMachine?.name ?: "—", color = MaterialTheme.colorScheme.onSurfaceVariant) }
        RowDivider()
        LabeledRow("Kết nối") {
            Text(
                if (app.hub?.connected == true) "Đang kết nối" else (app.hub?.lastError ?: "Đang nối lại…"),
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }

    SectionCard(
        footer = "Mặc định ảnh được thu nhỏ còn cạnh dài 2000 px trước khi gửi (Claude cũng tự thu nhỏ ảnh quá cỡ). Bật khi cần soi chi tiết nhỏ.",
    ) {
        SwitchRow("Gửi ảnh gốc (không thu nhỏ)", sendOriginal) { sendOriginal = it; Prefs.sendOriginal = it }
    }

    SectionCard(
        "Thông báo khi app đóng",
        footer = "Hub tự cấp topic riêng cho tài khoản của bạn: bấm một lần để đăng ký trong app ntfy. Chỉ báo khi app không mở.",
    ) {
        app.hub?.ntfySubscribe?.let { s ->
            ClickRow({
                try {
                    ctx.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(s)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                } catch (_: ActivityNotFoundException) {
                    message = "Chưa cài app ntfy — bấm \"Tải app ntfy\" bên dưới"
                }
            }) { Text("Bật thông báo khi app đóng (mở app ntfy)", color = MaterialTheme.colorScheme.primary) }
            RowDivider()
        }
        ClickRow({
            try {
                ctx.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("https://docs.ntfy.sh/subscribe/phone/")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            } catch (_: ActivityNotFoundException) {}
        }) { Text("Tải app ntfy", color = MaterialTheme.colorScheme.primary) }
    }

    SectionCard("Thiết bị đã đăng nhập") {
        devices.forEachIndexed { i, d ->
            if (i > 0) RowDivider()
            Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(d.name + if (d.current == true) " (máy này)" else "")
                    d.lastSeen?.let {
                        Text(
                            "dùng lần cuối " + DateFormat.getDateTimeInstance(DateFormat.MEDIUM, DateFormat.SHORT).format(Date(it.toLong())),
                            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
                if (d.current != true) {
                    TextButton(onClick = {
                        scope.launch {
                            try {
                                app.hubCall<JsonObject>("devices.revoke", jsonOf("id" to d.id))
                                loadDevices()
                                message = "Đã thu hồi"
                            } catch (e: Exception) {
                                if (e is kotlinx.coroutines.CancellationException) throw e
                                message = (e as? ApiError)?.message ?: e.message
                            }
                        }
                    }) { Text("Thu hồi", color = Semantic.red()) }
                }
            }
        }
        message?.let { m ->
            if (devices.isNotEmpty()) RowDivider()
            ClickRow(null) { Text(m, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
        }
    }

    SectionCard(footer = "Đăng nhập dùng mãi — app không tự đăng xuất. Mất máy thì thu hồi thiết bị đó ở đây từ máy khác.") {
        ClickRow({ passwordDialog = true }) { Text("Đổi mật khẩu", color = MaterialTheme.colorScheme.primary) }
        RowDivider()
        ClickRow({ confirmLogout = true }) { Text("Đăng xuất", color = Semantic.red()) }
        RowDivider()
        ClickRow({ confirmAll = true }) { Text("Đăng xuất mọi nơi", color = Semantic.red()) }
    }

    if (confirmLogout) {
        AlertDialog(
            onDismissRequest = { confirmLogout = false },
            title = { Text("Đăng xuất khỏi hub?") },
            confirmButton = { TextButton(onClick = { confirmLogout = false; app.logout() }) { Text("Đăng xuất", color = Semantic.red()) } },
            dismissButton = { TextButton(onClick = { confirmLogout = false }) { Text("Huỷ") } },
        )
    }
    if (confirmAll) {
        AlertDialog(
            onDismissRequest = { confirmAll = false },
            title = { Text("Đăng xuất trên mọi thiết bị?") },
            confirmButton = {
                TextButton(onClick = {
                    confirmAll = false
                    scope.launch {
                        try { app.hubCall<JsonObject>("logoutAll") } catch (e: Exception) { if (e is kotlinx.coroutines.CancellationException) throw e }
                        app.logout(remote = false)
                    }
                }) { Text("Đăng xuất mọi nơi", color = Semantic.red()) }
            },
            dismissButton = { TextButton(onClick = { confirmAll = false }) { Text("Huỷ") } },
        )
    }
    if (passwordDialog) PasswordDialog(app) { passwordDialog = false }
}

@Composable
private fun PasswordDialog(app: AppModel, onClose: () -> Unit) {
    var old by remember { mutableStateOf("") }
    var new by remember { mutableStateOf("") }
    var err by remember { mutableStateOf<String?>(null) }
    var done by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    AlertDialog(
        onDismissRequest = { if (!busy) onClose() },
        title = { Text("Đổi mật khẩu") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                if (done) {
                    Text("Đã đổi mật khẩu. Các thiết bị đang đăng nhập không bị đăng xuất.")
                } else {
                    OutlinedTextField(old, { old = it }, label = { Text("Mật khẩu cũ") }, singleLine = true, visualTransformation = PasswordVisualTransformation())
                    OutlinedTextField(new, { new = it }, label = { Text("Mật khẩu mới (tối thiểu 8 ký tự)") }, singleLine = true, visualTransformation = PasswordVisualTransformation())
                    err?.let { ErrorLabel(it) }
                }
            }
        },
        confirmButton = {
            if (done) TextButton(onClick = onClose) { Text("Xong") } else TextButton(
                enabled = !busy && old.isNotEmpty() && new.length >= 8,
                onClick = {
                    scope.launch {
                        busy = true
                        err = null
                        try {
                            app.hubCall<JsonObject>("password", jsonOf("old" to old, "new" to new))
                            done = true
                        } catch (e: Exception) {
                            if (e is kotlinx.coroutines.CancellationException) throw e
                            err = (e as? ApiError)?.message ?: e.message
                        }
                        busy = false
                    }
                },
            ) { Text("Đổi") }
        },
        dismissButton = { if (!done) TextButton(onClick = onClose, enabled = !busy) { Text("Huỷ") } },
    )
}

private fun isIgnoringBattery(ctx: Context): Boolean =
    (ctx.getSystemService(Context.POWER_SERVICE) as? PowerManager)?.isIgnoringBatteryOptimizations(ctx.packageName) == true

private fun openBatterySettings(ctx: Context) {
    try {
        ctx.startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    } catch (_: Exception) {
        openAppSettings(ctx)
    }
}

fun openNotificationSettings(ctx: Context) {
    try {
        ctx.startActivity(
            Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, ctx.packageName).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
        )
    } catch (_: Exception) {
        openAppSettings(ctx)
    }
}

private fun openAppSettings(ctx: Context) {
    ctx.startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${ctx.packageName}")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
}

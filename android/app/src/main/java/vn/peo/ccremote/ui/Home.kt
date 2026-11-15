package vn.peo.ccremote.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.EditNote
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.outlined.Computer
import androidx.compose.material.icons.outlined.Edit
import androidx.compose.material.icons.outlined.Laptop
import androidx.compose.material.icons.outlined.NightsStay
import androidx.compose.material.icons.outlined.WifiOff
import androidx.compose.material.icons.filled.ErrorOutline
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.Schedule
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CenterAlignedTopAppBar
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SwipeToDismissBox
import androidx.compose.material3.SwipeToDismissBoxValue
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.material3.rememberSwipeToDismissBoxState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import vn.peo.ccremote.AppModel
import vn.peo.ccremote.data.Account
import vn.peo.ccremote.data.ApiError
import vn.peo.ccremote.data.PCAlert
import vn.peo.ccremote.data.RecentSession
import vn.peo.ccremote.data.Route
import vn.peo.ccremote.data.SessionSummary
import vn.peo.ccremote.data.relativeTime
import vn.peo.ccremote.ui.theme.Semantic

@Composable
fun HomeScreen(app: AppModel) {
    var confirmSwitch by remember { mutableStateOf<Account?>(null) }
    var switchMessage by remember { mutableStateOf<String?>(null) }
    var refreshing by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val state = app.state

    Scaffold(
        topBar = {
            CenterAlignedTopAppBar(
                // tên máy đã hiện ở nút chọn máy; tên Windows (DESKTOP-…) làm tiêu đề lớn thì vô nghĩa và bị cắt
                title = { MachinePicker(app) },
                navigationIcon = {
                    IconButton(onClick = { app.path.add(Route.Settings) }) { Icon(Icons.Filled.Settings, contentDescription = "Cài đặt") }
                },
                actions = {
                    IconButton(onClick = { app.path.add(Route.NewSession()) }) { Icon(Icons.Filled.EditNote, contentDescription = "Phiên mới") }
                },
            )
        },
    ) { pad ->
        PullToRefreshBox(
            isRefreshing = refreshing,
            onRefresh = { scope.launch { refreshing = true; app.refresh(); refreshing = false } },
            modifier = Modifier.padding(pad).fillMaxSize(),
        ) {
            LazyColumn(Modifier.fillMaxSize()) {
                app.lastError?.let { err ->
                    item("err") { SectionCard { Column(Modifier.padding(16.dp)) { ErrorLabel(err, icon = Icons.Outlined.WifiOff) } } }
                }

                // cảnh báo của máy (ngân sách, hạn mức 90%, cần /login lại…): vuốt để ẩn
                val alerts = app.visibleAlerts
                if (alerts.isNotEmpty()) {
                    item("alerts") {
                        SectionCard("Cảnh báo trên máy") {
                            alerts.forEachIndexed { i, a ->
                                if (i > 0) RowDivider()
                                DismissibleAlert(a) { app.dismissAlert(a.id) }
                            }
                        }
                    }
                }

                val info = state?.accounts
                if (info != null && info.list.isNotEmpty()) {
                    item("accounts") {
                        SectionCard(
                            "Tài khoản",
                            footer = if (info.conflict) "Đăng nhập trên máy đang khác tài khoản đã chọn — mở dashboard để xử lý." else null,
                        ) {
                            info.list.forEachIndexed { i, a ->
                                if (i > 0) RowDivider()
                                AccountRow(a) { confirmSwitch = a }
                            }
                            switchMessage?.let {
                                RowDivider()
                                Text(it, Modifier.padding(16.dp), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                        }
                    }
                }

                // tài khoản hub chưa có máy tính nào (người mới, máy vừa bị ngắt): chỉ cách ghép thay vì "Đang tải…" mãi
                if (app.hub?.connected == true && app.machines.isEmpty()) {
                    item("nomachine") {
                        SectionCard {
                            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                    Icon(Icons.Outlined.Computer, null)
                                    Text("Chưa có máy tính nào", style = MaterialTheme.typography.titleMedium)
                                }
                                Text(
                                    "Trên máy tính: mở dashboard (127.0.0.1:7788) → thẻ Điện thoại → Kết nối hub, đăng nhập cùng tài khoản này. Máy sẽ hiện ra ở đây.",
                                    style = MaterialTheme.typography.bodyMedium,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            }
                        }
                    }
                }

                item("live") {
                    SectionCard("Đang chạy") {
                        val live = state?.live ?: emptyList()
                        if (live.isEmpty()) {
                            ClickRow(null) {
                                Text(
                                    when {
                                        state != null -> "Không có phiên nào đang chạy"
                                        app.machines.isEmpty() && app.hub?.connected == true -> "Chưa ghép máy tính"
                                        app.currentMachine?.online == false -> "Máy tính đang tắt hoặc chưa chạy tracker"
                                        else -> "Đang tải…"
                                    },
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            }
                        } else {
                            live.forEachIndexed { i, s ->
                                if (i > 0) RowDivider()
                                ClickRow({ app.path.add(Route.Session(s.id)) }) { LiveRow(s) }
                            }
                        }
                    }
                }

                val projects = state?.projects
                val recent = state?.recent
                if (!projects.isNullOrEmpty()) {
                    item("projects") {
                        SectionCard("Dự án") {
                            projects.forEachIndexed { i, p ->
                                if (i > 0) RowDivider()
                                ClickRow({ app.path.add(Route.Project(p.cwd)) }) { ProjectRow(p) }
                            }
                        }
                    }
                } else if (!recent.isNullOrEmpty()) {
                    item("recent") {
                        SectionCard("Gần đây") {
                            recent.forEachIndexed { i, r ->
                                if (i > 0) RowDivider()
                                ClickRow({ app.path.add(Route.Session(r.id)) }) { RecentRow(r) }
                            }
                        }
                    }
                }
            }
        }
    }

    confirmSwitch?.let { a ->
        AlertDialog(
            onDismissRequest = { confirmSwitch = null },
            title = { Text("Đổi sang ${a.name}?") },
            text = { Text("Claude Code trên máy sẽ dùng tài khoản này. Phiên mở từ điện thoại tự khởi động lại khi rảnh; phiên mở trong terminal cần mở lại.") },
            confirmButton = {
                TextButton(onClick = {
                    confirmSwitch = null
                    scope.launch {
                        switchMessage = try {
                            val r = app.switchAccount(a.id)
                            val n = r.restarted?.size ?: 0
                            "Đã đổi sang ${a.name}" + if (n > 0) " · khởi động lại $n phiên" else ""
                        } catch (e: Exception) {
                            if (e is kotlinx.coroutines.CancellationException) throw e
                            (e as? ApiError)?.message ?: e.message
                        }
                    }
                }) { Text("Đổi sang ${a.name}") }
            },
            dismissButton = { TextButton(onClick = { confirmSwitch = null }) { Text("Huỷ") } },
        )
    }
}

/** Chọn máy tính khi tài khoản có nhiều máy (hiện trên thanh công cụ màn hình chính). */
@Composable
fun MachinePicker(app: AppModel) {
    var open by remember { mutableStateOf(false) }
    var renaming by remember { mutableStateOf(false) }
    var newName by remember { mutableStateOf("") }
    val scope = rememberCoroutineScope()
    val cur = app.currentMachine

    Box {
        Row(
            Modifier.clip(MaterialTheme.shapes.small).clickableNoRipple { open = true }.padding(horizontal = 10.dp, vertical = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Dot(if (cur?.online == true) Semantic.green() else MaterialTheme.colorScheme.outline)
            EllipsisText(cur?.name ?: "Chọn máy", style = MaterialTheme.typography.titleSmall, modifier = Modifier.weight(1f, fill = false))
            Icon(Icons.Filled.ExpandMore, null, Modifier.size(18.dp))
        }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            app.machines.forEach { m ->
                DropdownMenuItem(
                    text = { Text(m.name + if (m.online) "" else " · tắt") },
                    leadingIcon = {
                        Icon(
                            if (m.id == app.machineId) Icons.Filled.Check else if (m.online) Icons.Outlined.Computer else Icons.Outlined.NightsStay,
                            null,
                        )
                    },
                    onClick = { open = false; app.selectMachine(m.id) },
                )
            }
            if (app.machines.isEmpty()) {
                DropdownMenuItem(text = { Text("Chưa có máy nào — ghép máy trên dashboard của máy tính") }, onClick = { open = false })
            }
            if (cur != null) {
                androidx.compose.material3.HorizontalDivider()
                DropdownMenuItem(
                    text = { Text("Đổi tên máy này…") },
                    leadingIcon = { Icon(Icons.Outlined.Edit, null) },
                    onClick = { open = false; newName = cur.name; renaming = true },
                )
            }
        }
    }

    if (renaming) {
        AlertDialog(
            onDismissRequest = { renaming = false },
            title = { Text("Đổi tên máy") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Text("Tên hiện trên app và trang web của hub.")
                    OutlinedTextField(value = newName, onValueChange = { newName = it }, label = { Text("Tên máy") }, singleLine = true)
                }
            },
            confirmButton = { TextButton(onClick = { renaming = false; scope.launch { app.renameMachine(newName) } }) { Text("Lưu") } },
            dismissButton = { TextButton(onClick = { renaming = false }) { Text("Huỷ") } },
        )
    }
}

@Composable
private fun DismissibleAlert(alert: PCAlert, onDismiss: () -> Unit) {
    val st = rememberSwipeToDismissBoxState(confirmValueChange = { v ->
        if (v != SwipeToDismissBoxValue.Settled) onDismiss()
        true
    })
    SwipeToDismissBox(
        state = st,
        backgroundContent = {
            Box(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.surfaceContainerHighest).padding(horizontal = 20.dp), contentAlignment = Alignment.CenterEnd) {
                Text("Ẩn", fontWeight = FontWeight.SemiBold)
            }
        },
    ) {
        Box(Modifier.background(MaterialTheme.colorScheme.surfaceContainer)) { PCAlertRow(alert) }
    }
}

/** Một cảnh báo của tracker trên máy tính. */
@Composable
fun PCAlertRow(alert: PCAlert) {
    val (icon, color) = when (alert.level) {
        "critical" -> Icons.Filled.ErrorOutline to Semantic.red()
        "warning" -> Icons.Filled.Warning to Semantic.orange()
        else -> Icons.Filled.Info to MaterialTheme.colorScheme.primary
    }
    Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp), horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.Top) {
        Icon(icon, null, tint = color, modifier = Modifier.size(20.dp).padding(top = 2.dp))
        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(alert.title, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
            if (!alert.body.isNullOrEmpty()) Text(alert.body, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Text(relativeTime(alert.t), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

@Composable
fun UsageBar(label: String, pct: Double?, modifier: Modifier = Modifier) {
    val color = when {
        pct == null -> MaterialTheme.colorScheme.outline
        pct >= 90 -> Semantic.red()
        pct >= 70 -> Semantic.orange()
        else -> MaterialTheme.colorScheme.primary
    }
    Column(modifier, verticalArrangement = Arrangement.spacedBy(3.dp)) {
        Row(Modifier.fillMaxWidth()) {
            Text(label, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.weight(1f))
            Text(pct?.let { "${Math.round(it)}%" } ?: "—", style = MaterialTheme.typography.bodySmall, fontWeight = FontWeight.Bold)
        }
        LinearProgressIndicator(
            progress = { ((pct ?: 0.0) / 100).coerceIn(0.0, 1.0).toFloat() },
            modifier = Modifier.fillMaxWidth(),
            color = color,
        )
    }
}

@Composable
fun AccountRow(account: Account, onSwitch: () -> Unit) {
    Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text(account.name, style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.SemiBold, maxLines = 1)
                    if (account.active) Pill("Đang dùng", Semantic.green())
                    else if (account.suggested) Pill("Nên dùng", Semantic.blue())
                }
                if (!account.email.isNullOrEmpty()) {
                    Text(account.email, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
            if (!account.active && account.error == null) {
                OutlinedButton(onClick = onSwitch, contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 14.dp, vertical = 0.dp)) { Text("Dùng") }
            }
        }
        if (account.error != null) {
            Text(account.error, style = MaterialTheme.typography.bodySmall, color = Semantic.red())
        } else {
            Row(horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                UsageBar("5 giờ", account.fiveHour?.pct, Modifier.weight(1f))
                UsageBar("7 ngày", account.sevenDay?.pct, Modifier.weight(1f))
            }
            if (account.loginState == "expired") {
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                    Icon(Icons.Filled.Warning, null, Modifier.size(14.dp), tint = Semantic.red())
                    Text("Hết hạn đăng nhập — cần /login lại", style = MaterialTheme.typography.bodySmall, color = Semantic.red())
                }
            } else if (account.loginState == "soon") {
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                    Icon(Icons.Filled.Schedule, null, Modifier.size(14.dp), tint = Semantic.orange())
                    Text("Sắp hết hạn đăng nhập", style = MaterialTheme.typography.bodySmall, color = Semantic.orange())
                }
            }
        }
    }
}

@Composable
fun LiveRow(session: SessionSummary) {
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            EllipsisText(
                session.title?.takeIf { it.isNotEmpty() } ?: "Phiên mới",
                style = MaterialTheme.typography.bodyLarge.copy(fontWeight = FontWeight.Medium),
                modifier = Modifier.weight(1f),
            )
            StatusBadge(session.status)
        }
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            FolderIcon()
            EllipsisText(session.project ?: "", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.weight(1f, fill = false))
            if (session.external == true) {
                val attached = session.attached == true
                val c = if (attached) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant
                Icon(Icons.Outlined.Laptop, null, Modifier.size(14.dp), tint = c)
                EllipsisText(
                    if (attached) "${session.source ?: "Máy tính"} · đã gắn" else session.source ?: "Máy tính",
                    style = MaterialTheme.typography.bodySmall, color = c, modifier = Modifier.weight(1f, fill = false),
                )
            }
            if (session.pending > 0) {
                Text("· ${session.pending} chờ duyệt", style = MaterialTheme.typography.bodySmall, fontWeight = FontWeight.Bold, color = Semantic.orange(), maxLines = 1)
            }
        }
        if (!session.lastText.isNullOrEmpty()) {
            EllipsisText(session.lastText, lines = 2, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

@Composable
fun RecentRow(session: RecentSession) {
    Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
        EllipsisText(session.title, lines = 2)
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            FolderIcon()
            EllipsisText(session.project, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.weight(1f, fill = false))
            Text("·  " + relativeTime(session.updatedAt), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1)
        }
    }
}

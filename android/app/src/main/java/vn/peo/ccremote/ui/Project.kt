package vn.peo.ccremote.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.EditNote
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material3.CenterAlignedTopAppBar
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
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
import vn.peo.ccremote.data.ApiError
import vn.peo.ccremote.data.Project
import vn.peo.ccremote.data.RecentSession
import vn.peo.ccremote.data.Route
import vn.peo.ccremote.data.relativeTime
import vn.peo.ccremote.ui.theme.Semantic

/** Một dòng dự án ở trang chủ: tên, số phiên, lần dùng cuối, chấm xanh nếu đang có phiên chạy. */
@Composable
fun ProjectRow(project: Project) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Box(Modifier.size(32.dp), contentAlignment = Alignment.Center) {
            Icon(Icons.Filled.Folder, null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(26.dp))
            if ((project.live ?: 0) > 0) {
                Box(
                    Modifier.align(Alignment.TopEnd).size(11.dp).clip(CircleShape)
                        .background(MaterialTheme.colorScheme.surfaceContainer).padding(1.5.dp).clip(CircleShape).background(Semantic.green()),
                )
            }
        }
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
            EllipsisText(project.name, style = MaterialTheme.typography.bodyLarge.copy(fontWeight = FontWeight.Medium))
            Row(horizontalArrangement = Arrangement.spacedBy(5.dp)) {
                val c = MaterialTheme.colorScheme.onSurfaceVariant
                project.count?.let { Text("$it phiên", style = MaterialTheme.typography.bodySmall, color = c) }
                Text("·", style = MaterialTheme.typography.bodySmall, color = c)
                Text(relativeTime(project.lastUsed), style = MaterialTheme.typography.bodySmall, color = c)
                project.live?.takeIf { it > 0 }?.let { Text("· $it đang chạy", style = MaterialTheme.typography.bodySmall, color = Semantic.green()) }
            }
            if (!project.lastTitle.isNullOrEmpty()) {
                EllipsisText(project.lastTitle, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
}

/** Các phiên của một dự án: đang chạy ở trên, rồi tới phiên cũ (mới trước). Nút ✏️ mở phiên mới ngay trong dự án. */
@Composable
fun ProjectScreen(app: AppModel, cwd: String) {
    var sessions by remember { mutableStateOf<List<RecentSession>>(emptyList()) }
    var loaded by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var refreshing by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    val name = app.state?.projects?.firstOrNull { it.cwd == cwd }?.name ?: cwd.trimEnd('\\', '/').substringAfterLast('\\').substringAfterLast('/')
    val live = (app.state?.live ?: emptyList()).filter { (it.cwd ?: "").lowercase() == cwd.lowercase() }

    suspend fun load() {
        try {
            sessions = app.projectSessions(cwd)
            error = null
        } catch (e: Exception) {
            if (e is kotlinx.coroutines.CancellationException) throw e
            error = (e as? ApiError)?.message ?: e.message
        }
        loaded = true
        app.refresh()
    }
    LaunchedEffect(cwd) { load() }
    val listState = androidx.compose.foundation.lazy.rememberLazyListState()
    LaunchedEffect(loaded) { if (loaded) listState.scrollToItem(0) }

    Scaffold(
        topBar = {
            CenterAlignedTopAppBar(
                title = { EllipsisText(name, style = MaterialTheme.typography.titleMedium) },
                navigationIcon = { BackButton { app.pop() } },
                actions = { IconButton(onClick = { app.path.add(Route.NewSession(cwd)) }) { Icon(Icons.Filled.EditNote, contentDescription = "Phiên mới") } },
            )
        },
    ) { pad ->
        PullToRefreshBox(
            isRefreshing = refreshing,
            onRefresh = { scope.launch { refreshing = true; load(); refreshing = false } },
            modifier = Modifier.padding(pad).fillMaxSize(),
        ) {
            LazyColumn(Modifier.fillMaxSize(), state = listState) {
                item("new") {
                    SectionCard {
                        ClickRow({ app.path.add(Route.NewSession(cwd)) }) {
                            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                                Icon(Icons.Filled.EditNote, null, tint = MaterialTheme.colorScheme.primary)
                                Text("Phiên mới trong $name", color = MaterialTheme.colorScheme.primary)
                            }
                        }
                    }
                    Text(
                        cwd, Modifier.padding(horizontal = 28.dp),
                        style = MaterialTheme.typography.labelSmall.copy(fontFamily = Mono), color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                if (live.isNotEmpty()) {
                    item("live") {
                        SectionCard("Đang chạy") {
                            live.forEachIndexed { i, s ->
                                if (i > 0) RowDivider()
                                ClickRow({ app.path.add(Route.Session(s.id)) }) { LiveRow(s) }
                            }
                        }
                    }
                }
                item("older") {
                    val liveIds = live.map { it.id }.toSet()
                    val older = sessions.filter { it.id !in liveIds }
                    SectionCard(if (loaded) "Phiên trước (${older.size})" else "Phiên trước") {
                        val err = error
                        if (err != null) {
                            ClickRow(null) { ErrorLabel(err) }
                        } else if (!loaded) {
                            ClickRow(null) { LoadingRow() }
                        } else if (older.isEmpty()) {
                            ClickRow(null) {
                                Text(
                                    if (sessions.isEmpty()) "Chưa có phiên nào" else "Không có phiên cũ — tất cả đang chạy",
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            }
                        }
                        older.forEachIndexed { i, s ->
                            if (i > 0 || err != null || !loaded) RowDivider()
                            ClickRow({ app.path.add(Route.Session(s.id)) }) {
                                Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
                                    EllipsisText(s.title, lines = 2)
                                    Text(relativeTime(s.updatedAt), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

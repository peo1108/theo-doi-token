package vn.peo.ccremote.ui

import android.os.Build
import android.view.HapticFeedbackConstants
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.isImeVisible
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.ui.focus.focusRequester
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.ArrowDownward
import androidx.compose.material.icons.filled.CheckBox
import androidx.compose.material.icons.filled.CheckBoxOutlineBlank
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.RadioButtonChecked
import androidx.compose.material.icons.filled.RadioButtonUnchecked
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material.icons.filled.Tune
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.Computer
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material.icons.outlined.Laptop
import androidx.compose.material.icons.outlined.Cancel
import androidx.compose.material.icons.outlined.Terminal
import androidx.compose.material.icons.outlined.WifiOff
import androidx.compose.material.icons.outlined.Verified
import androidx.compose.material.icons.outlined.Warning
import androidx.compose.material.icons.outlined.Smartphone
import androidx.compose.material.icons.outlined.HelpOutline
import androidx.compose.material.icons.outlined.Checklist
import androidx.compose.material.icons.outlined.PanTool
import androidx.compose.material.icons.outlined.Speed
import androidx.compose.material3.Button
import androidx.compose.material3.CenterAlignedTopAppBar
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.FilledIconButton
import androidx.compose.material3.IconButtonDefaults
import androidx.compose.material3.SuggestionChip
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.launch
import vn.peo.ccremote.AppModel
import vn.peo.ccremote.data.ApiClient
import vn.peo.ccremote.data.ApiError
import vn.peo.ccremote.data.CommandInfo
import vn.peo.ccremote.data.Event
import vn.peo.ccremote.data.Question
import vn.peo.ccremote.data.clockTime
import vn.peo.ccremote.data.effortLabel
import vn.peo.ccremote.data.statusInfo
import vn.peo.ccremote.session.Haptic
import vn.peo.ccremote.session.SessionModel
import vn.peo.ccremote.ui.theme.Semantic

@OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
@Composable
fun SessionScreen(app: AppModel, id: String) {
    val view = LocalView.current
    val ctx = LocalContext.current
    val model = remember(id) {
        SessionModel(id) { h ->
            if (app.inForeground) {
                val c = if (Build.VERSION.SDK_INT >= 30) (if (h == Haptic.Success) HapticFeedbackConstants.CONFIRM else HapticFeedbackConstants.REJECT) else HapticFeedbackConstants.LONG_PRESS
                view.performHapticFeedback(c)
            }
        }
    }
    var draft by remember { mutableStateOf("") }
    var showSettings by remember { mutableStateOf(false) }
    val picks = remember { mutableStateListOf<PickedImage>() }
    val pickers = rememberImagePickers(picks)
    val listState = rememberLazyListState()
    val scope = rememberCoroutineScope()
    /** đang nhìn cuối cuộc trò chuyện (đã kéo lên đọc tin cũ thì false: tin mới không giật xuống) */
    var atBottom by remember { mutableStateOf(true) }
    /** có tin mới phía dưới trong lúc đang đọc tin cũ */
    var newBelow by remember { mutableStateOf(false) }
    var programmatic by remember { mutableStateOf(false) }
    val focusInput = remember { androidx.compose.ui.focus.FocusRequester() }

    // theo máy đang chọn: mở từ thông báo lúc app chưa kịp chọn máy thì chọn xong mới nối, không đứng "Đang kết nối…" mãi
    LaunchedEffect(app.machineId, app.hub) {
        val api = app.api ?: return@LaunchedEffect
        model.run(api)
    }
    LaunchedEffect(Unit) { app.loadCaps() }
    // đang xem phiên này thì không báo
    DisposableEffect(id) {
        app.activeSessionId = id
        onDispose { if (app.activeSessionId == id) app.activeSessionId = null }
    }

    val items = model.visible
    val running = model.status == "running" || model.status == "starting"
    val extra = (if (model.events.isEmpty()) 1 else 0) + (if (running) (if (model.thinkingTokens != null) 2 else 1) else 0)
    val itemCount = items.size + extra + 1   // +1: mốc "bottom"

    suspend fun scrollToBottom() {
        programmatic = true
        try { listState.scrollToItem((itemCount - 1).coerceAtLeast(0)) } finally { programmatic = false }
    }

    // chỉ đổi theo thao tác cuộn của người dùng (pha cuộn), không theo nội dung dài ra
    LaunchedEffect(listState) {
        androidx.compose.runtime.snapshotFlow { listState.isScrollInProgress }.collect { scrolling ->
            if (programmatic) return@collect
            atBottom = if (scrolling) false else !listState.canScrollForward
        }
    }
    LaunchedEffect(atBottom) { if (atBottom) newBelow = false }
    LaunchedEffect(model.scrollTick, itemCount) {
        // đang kéo lên đọc tin cũ thì không giật xuống cuối mỗi lần có sự kiện mới — hiện nút "Tin mới" thay vào
        if (atBottom) scrollToBottom() else if (model.scrollTick > 0) newBelow = true
    }
    val imeVisible = WindowInsets.isImeVisible
    LaunchedEffect(imeVisible) { if (atBottom) scrollToBottom() }

    val title = model.summary?.title?.takeIf { it.isNotEmpty() } ?: app.title(id)
    val subtitle = buildList {
        add(statusInfo(model.status).label)
        val st = model.summary?.settings
        if (st != null) add(if (st.effort != null) "${st.modelLabel} ${effortLabel(st.effort)}" else st.modelLabel)
        else model.summary?.project?.takeIf { it.isNotEmpty() }?.let { add(it) }
        model.summary?.rate?.fiveHour?.let { add("5h ${Math.round(it)}%") }
    }.joinToString(" · ")

    fun act(fn: suspend (ApiClient) -> Unit) {
        val api = app.api ?: return
        scope.launch { fn(api) }
    }

    fun send() {
        val text = draft.trim()
        if (text.isEmpty() && picks.isEmpty()) return
        val sending = picks.toList()
        draft = ""
        picks.clear()
        atBottom = true   // gửi xong thì xuống cuối xem tin của mình, kể cả đang đọc tin cũ
        act { api ->
            model.sending = true   // vòng quay hiện ngay cả lúc đang nén ảnh
            val encoded = ImagePrep.payloads(ctx, sending)
            if (!model.send(text, encoded, api)) {
                if (draft.isEmpty()) draft = text
                if (picks.isEmpty()) picks.addAll(sending)
            }
        }
    }

    Scaffold(
        topBar = {
            CenterAlignedTopAppBar(
                navigationIcon = { BackButton { app.pop() } },
                title = {
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        Text(title, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(5.dp)) {
                            Dot(if (model.connected) Semantic.green() else MaterialTheme.colorScheme.outline, 6)
                            Text(subtitle, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        }
                    }
                },
                actions = { IconButton(onClick = { showSettings = true }) { Icon(Icons.Filled.Tune, contentDescription = "Cài đặt phiên") } },
            )
        },
        bottomBar = {
            Column(Modifier.imePadding().navigationBarsPadding().background(MaterialTheme.colorScheme.surfaceContainer)) {
                val q = commandQuery(draft)
                val cmds = app.caps?.commands
                if (q != null && cmds != null) {
                    CommandSuggestions(cmds, q) { c ->
                        draft = "/" + c.name + " "
                        runCatching { focusInput.requestFocus() }
                    }
                    HorizontalDivider()
                }
                AttachmentStrip(picks)
                ComposerRow(
                    draft = draft, onDraft = { draft = it }, busy = model.isBusy, sending = model.sending, hasPicks = picks.isNotEmpty(),
                    pickers = pickers, picks = picks, focus = focusInput,
                    onSlash = { if (!draft.startsWith("/")) draft = "/$draft"; runCatching { focusInput.requestFocus() } },
                    onStop = { act { model.interrupt(it) } }, onSend = { send() },
                )
            }
        },
    ) { pad ->
        Column(Modifier.padding(pad).fillMaxSize()) {
            model.lastError?.let { err ->
                Row(
                    Modifier.fillMaxWidth().background(Semantic.red().copy(alpha = 0.85f)).padding(horizontal = 14.dp, vertical = 8.dp),
                    verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Icon(if (model.connected) Icons.Outlined.Warning else Icons.Outlined.WifiOff, null, tint = Color.White, modifier = Modifier.size(16.dp))
                    Text(err, color = Color.White, style = MaterialTheme.typography.bodySmall)
                }
            }
            ExternalBar(model) { on -> act { model.attach(on, it) } }

            Box(Modifier.weight(1f).fillMaxWidth()) {
                LazyColumn(
                    Modifier.fillMaxSize(), state = listState,
                    contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 14.dp, vertical = 12.dp),
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    if (model.events.isEmpty()) {
                        item("empty") {
                            Text(
                                if (model.connected) "Chưa có tin nhắn" else "Đang kết nối…", Modifier.fillMaxWidth().padding(top = 40.dp),
                                color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = androidx.compose.ui.text.style.TextAlign.Center,
                            )
                        }
                    }
                    items(items, key = { it.seq }) { ev -> EventRow(app, ev, model) }
                    if (running) {
                        // như VS Code: "Thinking… · N tokens" rồi dòng chữ chạy "Vibing…"
                        model.thinkingTokens?.let { tk ->
                            item("thinking") {
                                TimelineRow(MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.55f)) {
                                    Text("Thinking… · $tk tokens", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                                }
                            }
                        }
                        item("spinner") { SpinnerLine(if (model.status == "starting") "Đang mở Claude" else model.spinnerVerb) }
                    }
                    item("bottom") { Box(Modifier.height(1.dp)) }
                }
                if (newBelow && !atBottom) {
                    Surface(
                        Modifier.align(Alignment.BottomCenter).padding(bottom = 10.dp).clip(CircleShape).clickable { scope.launch { atBottom = true; scrollToBottom() } },
                        shape = CircleShape, shadowElevation = 6.dp, color = MaterialTheme.colorScheme.secondaryContainer,
                    ) {
                        Row(Modifier.padding(horizontal = 14.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            Icon(Icons.Filled.ArrowDownward, null, Modifier.size(16.dp))
                            Text("Tin mới", style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold)
                        }
                    }
                }
            }
        }
    }

    if (showSettings) {
        BackHandler { showSettings = false }
        SessionSettingsScreen(app, model) { showSettings = false }
    }
}

/** Đang gõ "/lệnh" (chưa có dấu cách) -> phần sau dấu / */
private fun commandQuery(draft: String): String? =
    if (draft.startsWith("/") && !draft.contains(' ') && !draft.contains('\n')) draft.drop(1) else null

@Composable
private fun ComposerRow(
    draft: String, onDraft: (String) -> Unit, busy: Boolean, sending: Boolean, hasPicks: Boolean,
    pickers: ImagePickers, picks: List<PickedImage>, focus: androidx.compose.ui.focus.FocusRequester,
    onSlash: () -> Unit, onStop: () -> Unit, onSend: () -> Unit,
) {
    Row(Modifier.fillMaxWidth().padding(horizontal = 6.dp, vertical = 8.dp), verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(2.dp)) {
        IconButton(onClick = onSlash) { Text("/", fontSize = 22.sp, fontWeight = FontWeight.Bold, color = MaterialTheme.colorScheme.onSurfaceVariant) }
        AttachButton(pickers, picks)
        OutlinedTextField(
            value = draft, onValueChange = onDraft, modifier = Modifier.weight(1f).focusRequester(focus),
            placeholder = { Text("Nhắn cho Claude…  (/ để xem lệnh)", maxLines = 1, overflow = TextOverflow.Ellipsis) },
            maxLines = 6, shape = RoundedCornerShape(22.dp),
            textStyle = MaterialTheme.typography.bodyMedium,
            keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences),
        )
        if (busy) {
            FilledIconButton(
                onClick = onStop,
                colors = IconButtonDefaults.filledIconButtonColors(containerColor = Semantic.red(), contentColor = Color.White),
            ) { Icon(Icons.Filled.Stop, contentDescription = "Dừng Claude") }
        }
        FilledIconButton(
            onClick = onSend,
            enabled = (draft.isNotBlank() || hasPicks) && !sending,
        ) {
            if (sending) CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp, color = MaterialTheme.colorScheme.onPrimary)
            else Icon(Icons.AutoMirrored.Filled.Send, contentDescription = "Gửi")
        }
    }
}

/** Phiên đang mở trên máy (VS Code / terminal): điều khiển qua hook. */
@Composable
private fun ExternalBar(model: SessionModel, onAttach: (Boolean) -> Unit) {
    val s = model.summary ?: return
    if (s.external != true) return
    val src = s.source ?: "Máy tính"
    val attached = s.attached == true
    val ready = s.ready == true
    val running = s.status == "running" || s.status == "waiting"
    var menu by remember { mutableStateOf(false) }
    Row(
        Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surfaceContainer).padding(horizontal = 14.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Icon(
            if (src == "Terminal") Icons.Outlined.Terminal else Icons.Outlined.Laptop, null,
            tint = if (ready || running) Semantic.green() else MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(1.dp)) {
            Text(
                if (ready) "$src · sẵn sàng nhận lệnh" else if (running) "$src · Claude đang làm…" else "$src · chưa sẵn sàng",
                style = MaterialTheme.typography.bodySmall, fontWeight = FontWeight.SemiBold,
            )
            Text(
                if (ready) "Nhắn là Claude trên máy làm tiếp ngay"
                else if (running) "Tin gửi lúc này sẽ vào ngay khi Claude xong lượt"
                else "Hook đã bị dừng (bấm Stop trong VS Code?) — gõ một tin bất kỳ trong VS Code để bật lại",
                style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            val accent = attached || s.pcAway == true || s.mirror == true
            Text(
                if (attached) "Duyệt quyền: trên điện thoại"
                else if (s.pcAway == true) "Duyệt quyền: trên điện thoại (máy đang để yên)"
                else if (s.mirror == true) "Duyệt quyền: máy tính hoặc điện thoại, bên nào trước"
                else "Duyệt quyền: trên máy tính (đang có người dùng máy)",
                style = MaterialTheme.typography.labelSmall, color = if (accent) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        Box {
            IconButton(onClick = { menu = true }) { Icon(Icons.Filled.MoreVert, contentDescription = "Thêm") }
            DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                DropdownMenuItem(
                    text = { Text(if (attached) "Trả duyệt quyền về máy tính" else "Luôn duyệt quyền trên điện thoại") },
                    onClick = { menu = false; onAttach(!attached) },
                )
            }
        }
    }
}

/** Gợi ý lệnh / khi lời nhắn bắt đầu bằng "/". */
@Composable
fun CommandSuggestions(commands: List<CommandInfo>, query: String, onPick: (CommandInfo) -> Unit) {
    val q = query.lowercase()
    val starts = commands.filter { it.name.lowercase().startsWith(q) }
    val contains = commands.filter { !it.name.lowercase().startsWith(q) && it.name.lowercase().contains(q) }
    val matches = (starts + contains).take(8)
    if (matches.isEmpty()) return
    val list = @Composable {
        Column(Modifier.fillMaxWidth()) {
            matches.forEach { c ->
                Column(Modifier.fillMaxWidth().clickable { onPick(c) }.padding(horizontal = 14.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                        Text("/" + c.name, style = MaterialTheme.typography.bodyMedium.copy(fontFamily = Mono, fontWeight = FontWeight.SemiBold))
                        if (c.hint.isNotEmpty()) Text(c.hint, style = MaterialTheme.typography.bodySmall.copy(fontFamily = Mono), color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                    if (c.description.isNotEmpty()) Text(c.description, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 2, overflow = TextOverflow.Ellipsis)
                }
                HorizontalDivider(Modifier.padding(start = 14.dp))
            }
        }
    }
    if (matches.size > 4) Box(Modifier.height(260.dp).verticalScroll(rememberScrollState())) { list() } else list()
}

// ---------- Từng sự kiện ----------

@Composable
fun EventRow(app: AppModel, event: Event, model: SessionModel) {
    val grey = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.55f)
    when (event.kind) {
        "user" -> Column(Modifier.padding(top = 8.dp), verticalArrangement = Arrangement.spacedBy(3.dp)) {
            if (event.via == "phone") {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    Icon(Icons.Outlined.Smartphone, null, Modifier.size(12.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                    Text("từ điện thoại", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
            if (!event.images.isNullOrEmpty()) EventImages(app, event.images, model.id)
            if (!event.text.isNullOrEmpty()) {
                // giống ô lời nhắn trong VS Code: khung viền, cả chiều ngang
                OutlineBox(Modifier.fillMaxWidth()) {
                    SelectionContainer {
                        Text(event.text, Modifier.padding(horizontal = 12.dp, vertical = 9.dp), style = TextStyle(fontSize = 15.sp, lineHeight = 21.sp))
                    }
                }
            }
        }
        "assistant" -> TimelineRow(grey) { MarkdownText(event.text ?: "") }
        "tool" -> {
            val result = event.toolId?.let { model.toolResults[it] }
            TimelineRow(
                if (result == null) (if (model.summary?.live == true) Semantic.blue() else Semantic.gray())
                else if (result.error == true) Semantic.red() else Semantic.green(),
            ) { ToolRow(app, event, result, model.summary?.live == true, model.id) }
        }
        "permission" -> TimelineRow(Semantic.orange()) {
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                PermissionCard(
                    event, decision = event.requestId?.let { model.decisions[it] }, decisionText = event.requestId?.let { model.decisionTexts[it] },
                ) { decision, answers, feedback ->
                    val api = app.api
                    val rid = event.requestId
                    if (api != null && rid != null) app.scope.launch { model.decide(rid, decision, answers, feedback, api) }
                }
                // tool phải duyệt quyền không có dòng tool riêng (visible ẩn đi) -> ảnh kết quả hiện ở đây
                val imgs = event.toolUseId?.let { model.toolResults[it] }?.images
                if (!imgs.isNullOrEmpty()) EventImages(app, imgs, model.id, large = true)
            }
        }
        "result" -> ResultRow(event, Modifier.padding(start = 20.dp))
        "limit" -> LimitCard(app, event, model.id)
        "error" -> TimelineRow(Semantic.red()) {
            SelectionContainer { Text(event.text ?: "Lỗi", style = MaterialTheme.typography.bodySmall, color = Semantic.red()) }
        }
        "output" -> TimelineRow(grey) { InOutBlock(null, event.text, event.error == true, null) }
        "thought" -> TimelineRow(grey) {
            Text("Thought for ${(event.seconds ?: 1.0).toInt()}s", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        "note" -> Text(
            event.text ?: "", Modifier.fillMaxWidth(), style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = androidx.compose.ui.text.style.TextAlign.Center,
        )
        else -> {}
    }
}

/** Một lần gọi tool, giống VS Code: "Bash  mô tả" + khung IN/OUT, "Edit  đường dẫn" + diff, bấm để xem đủ. */
@Composable
fun ToolRow(app: AppModel, event: Event, result: Event?, live: Boolean, sessionId: String) {
    var open by remember { mutableStateOf(false) }
    val name = event.name ?: "Tool"
    val headline = event.path ?: event.title?.takeIf { it.isNotEmpty() } ?: event.summary ?: ""
    val outText = result?.text?.takeIf { it.isNotEmpty() }

    // dòng phụ dưới tiêu đề (vd. "Thêm 3 dòng, bớt 1 dòng" cho Edit, mô tả khi đã có đường dẫn)
    val subline: String? = run {
        val n = event.newText
        if (n != null) {
            val o = event.oldText ?: ""
            val a = if (n.isEmpty()) 0 else n.split("\n").size
            val d = if (o.isEmpty()) 0 else o.split("\n").size
            val parts = ArrayList<String>()
            if (a > 0) parts.add("Thêm $a dòng")
            if (d > 0) parts.add("bớt $d dòng")
            event.title?.let { parts.add(it) }
            if (parts.isEmpty()) null else parts.joinToString(", ")
        } else if (event.path != null && !event.title.isNullOrEmpty()) event.title else null
    }

    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Row(
            Modifier.fillMaxWidth().clickable { open = !open },
            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(7.dp),
        ) {
            Text(name, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
            Text(
                headline,
                style = if (event.path != null) MaterialTheme.typography.bodySmall.copy(fontFamily = Mono) else MaterialTheme.typography.bodySmall,
                color = if (event.path != null) Semantic.blue() else MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = if (open) 4 else 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false),
            )
            if (result == null && live) CircularProgressIndicator(Modifier.size(12.dp), strokeWidth = 1.5.dp)
        }
        subline?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
        when (name) {
            "Edit", "MultiEdit" -> {
                if (event.oldText != null || event.newText != null) DiffBlock(event.oldText ?: "", event.newText ?: "", if (open) 200 else 10)
                if (result?.error == true && outText != null) ErrorText(outText, open)
            }
            "Bash", "PowerShell" -> InOutBlock(event.code ?: event.summary, outText, result?.error == true, if (open) null else 6)
            "Write" -> {
                event.code?.let { CodeBlock(it, maxLines = if (open) null else 8) }
                if (result?.error == true && outText != null) ErrorText(outText, open)
            }
            "TodoWrite" -> event.code?.let { CodeBlock(it) }
            else -> {
                if (open) event.code?.let { CodeBlock(it) }
                if (result?.error == true && outText != null) ErrorText(outText, open)
                else if (open && outText != null) InOutBlock(null, outText, false, null)
            }
        }
        // ảnh Claude xem trên máy (Read file ảnh, tool chụp màn hình…)
        val imgs = result?.images
        if (!imgs.isNullOrEmpty()) EventImages(app, imgs, sessionId, large = true)
    }
}

@Composable
private fun ErrorText(s: String, open: Boolean) {
    SelectionContainer {
        Text(s, style = MaterialTheme.typography.bodySmall.copy(fontFamily = Mono), color = Semantic.red(), maxLines = if (open) Int.MAX_VALUE else 4, overflow = TextOverflow.Ellipsis)
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun PermissionCard(
    event: Event,
    decision: String?,
    decisionText: String? = null,
    /** (quyết định, câu trả lời, lời nhắn kèm khi từ chối) */
    onDecide: (String, Map<String, String>?, String?) -> Unit,
) {
    var showInput by remember { mutableStateOf(false) }
    val picks = remember { mutableStateMapOf<Int, Set<String>>() }
    /** câu trả lời tự gõ ("Khác") của từng câu hỏi */
    val others = remember { mutableStateMapOf<Int, String>() }
    var feedback by remember { mutableStateOf("") }
    var showFeedback by remember { mutableStateOf(false) }
    val isQuestion = event.tool == "AskUserQuestion" && !event.questions.isNullOrEmpty()
    val isPlan = event.tool == "ExitPlanMode"
    val orange = Semantic.orange()
    val title = if (isQuestion) "Claude hỏi bạn" else if (isPlan) "Kế hoạch chờ duyệt" else "Cho phép ${event.tool ?: "công cụ"}?"
    val headerIcon = if (isQuestion) Icons.Outlined.HelpOutline else if (isPlan) Icons.Outlined.Checklist else Icons.Outlined.PanTool

    fun decidedText(d: String) = when (d) {
        "allow" -> if (isQuestion) "Đã trả lời" else if (isPlan) "Đã duyệt kế hoạch" else "Đã cho phép"
        "always" -> "Đã cho phép (cả phiên)"
        "deny" -> if (isQuestion) "Đã bỏ qua" else if (isPlan) "Chưa duyệt" else "Đã từ chối"
        "pc" -> "Đã trả lời trên máy tính"
        else -> "Đã huỷ"
    }

    Column(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).background(orange.copy(alpha = if (decision == null) 0.13f else 0.06f))
            .border(1.dp, orange.copy(alpha = if (decision == null) 0.5f else 0.15f), RoundedCornerShape(14.dp)).padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Icon(headerIcon, null, tint = orange)
            Text(title, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
        }

        val qs = event.questions
        if (event.plan != null) {
            Surface(shape = RoundedCornerShape(10.dp), color = MaterialTheme.colorScheme.surface) {
                MarkdownText(event.plan, Modifier.padding(10.dp))
            }
        } else if (!qs.isNullOrEmpty()) {
            qs.forEachIndexed { i, q -> QuestionView(i, q, picks, others, decision != null) }
        } else {
            SelectionContainer {
                Text(
                    event.summary ?: "", style = MaterialTheme.typography.bodyMedium.copy(fontFamily = Mono),
                    maxLines = if (showInput) Int.MAX_VALUE else 8, overflow = TextOverflow.Ellipsis,
                )
            }
            if (!event.input.isNullOrEmpty()) {
                Column {
                    Text(
                        if (showInput) "Chi tiết ▾" else "Chi tiết ▸", Modifier.clickable { showInput = !showInput }.padding(vertical = 2.dp),
                        style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.primary,
                    )
                    if (showInput) CodeBlock(event.input)
                }
            }
        }

        if (decision != null) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Icon(
                    if (decision == "pc") Icons.Outlined.Computer else if (decision == "deny" || decision == "cancel") Icons.Outlined.Cancel else Icons.Outlined.CheckCircle,
                    null, Modifier.size(16.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Text(decidedText(decision), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            if (!decisionText.isNullOrEmpty()) {
                SelectionContainer { Text("“$decisionText”", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
            }
        } else if (isQuestion) {
            val ready = qs!!.indices.all { !picks[it].isNullOrEmpty() || (others[it] ?: "").trim().isNotEmpty() }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(enabled = ready, onClick = {
                    val answers = LinkedHashMap<String, String>()
                    qs.forEachIndexed { i, q ->
                        val chosen = q.options.map { it.label }.filter { picks[i]?.contains(it) == true }.toMutableList()
                        val other = (others[i] ?: "").trim()
                        if (other.isNotEmpty()) chosen.add(other)
                        answers[q.question] = chosen.joinToString(", ")
                    }
                    onDecide("allow", answers, null)
                }) { Text("Gửi trả lời") }
                OutlinedButton(onClick = { onDecide("deny", null, null) }, colors = ButtonDefaults.outlinedButtonColors(contentColor = Semantic.red())) { Text("Bỏ qua") }
            }
        } else {
            val canAlways = event.canAlways == true && !isPlan
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                // ba nút một hàng; không đủ chỗ (máy hẹp / chữ to) thì tự xuống hàng, không gãy chữ
                FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button(onClick = { onDecide("allow", null, null) }) { Text(if (isPlan) "Duyệt" else "Cho phép", maxLines = 1, softWrap = false) }
                    if (canAlways) OutlinedButton(onClick = { onDecide("always", null, null) }) { Text("Luôn cho phép", maxLines = 1, softWrap = false) }
                    OutlinedButton(onClick = { onDecide("deny", null, null) }, colors = ButtonDefaults.outlinedButtonColors(contentColor = Semantic.red())) {
                        Text(if (isPlan) "Chưa" else "Từ chối", maxLines = 1, softWrap = false)
                    }
                }
                // như "No, and tell Claude what to do differently" của VS Code: từ chối kèm lời nhắn để Claude làm khác đi
                if (showFeedback) {
                    Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        OutlinedTextField(
                            feedback, { feedback = it }, Modifier.weight(1f), maxLines = 5, textStyle = MaterialTheme.typography.bodyMedium,
                            placeholder = { Text(if (isPlan) "Cần sửa gì trong kế hoạch?" else "Bảo Claude làm khác đi thế nào…") },
                        )
                        Button(enabled = feedback.trim().isNotEmpty(), onClick = { onDecide("deny", null, feedback.trim()) }) { Text("Gửi") }
                    }
                } else {
                    TextButton(onClick = { showFeedback = true }, contentPadding = androidx.compose.foundation.layout.PaddingValues(0.dp)) {
                        Text(if (isPlan) "Chưa — góp ý để Claude sửa kế hoạch…" else "Từ chối và nhắn Claude…", style = MaterialTheme.typography.bodySmall)
                    }
                }
            }
        }
    }
}

@Composable
private fun QuestionView(i: Int, q: Question, picks: MutableMap<Int, Set<String>>, others: MutableMap<Int, String>, locked: Boolean) {
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(q.question, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Medium)
        q.options.forEach { o ->
            val on = picks[i]?.contains(o.label) == true
            Row(
                Modifier.fillMaxWidth().clip(RoundedCornerShape(8.dp)).background(MaterialTheme.colorScheme.surface)
                    .then(if (locked) Modifier else Modifier.clickable {
                        var s = picks[i] ?: emptySet()
                        if (q.multiSelect) {
                            s = if (on) s - o.label else s + o.label
                        } else {
                            s = setOf(o.label)
                            others.remove(i)   // chỉ chọn một: bấm lựa chọn có sẵn thì bỏ câu tự gõ
                        }
                        picks[i] = s
                    }).padding(8.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Icon(
                    if (on) (if (q.multiSelect) Icons.Filled.CheckBox else Icons.Filled.RadioButtonChecked)
                    else (if (q.multiSelect) Icons.Filled.CheckBoxOutlineBlank else Icons.Filled.RadioButtonUnchecked),
                    null, tint = if (on) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Text(o.label, style = MaterialTheme.typography.bodyMedium)
                    if (o.description.isNotEmpty()) Text(o.description, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        }
        // như "Other" của VS Code: không lựa chọn nào hợp thì tự gõ câu trả lời
        if (!locked) {
            OutlinedTextField(
                value = others[i] ?: "",
                onValueChange = { v ->
                    others[i] = v
                    if (!q.multiSelect && v.trim().isNotEmpty()) picks[i] = emptySet()
                },
                placeholder = { Text(if (q.multiSelect) "Khác — thêm câu trả lời của bạn" else "Khác — tự gõ câu trả lời") },
                maxLines = 4, modifier = Modifier.fillMaxWidth(), textStyle = MaterialTheme.typography.bodyMedium,
            )
        }
    }
}

@Composable
fun ResultRow(event: Event, modifier: Modifier = Modifier) {
    val c = MaterialTheme.colorScheme.onSurfaceVariant
    Row(modifier.fillMaxWidth().padding(vertical = 2.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        if (event.aborted == true) {
            Icon(Icons.Filled.Stop, null, Modifier.size(14.dp), tint = c)
            Text("Đã dừng", style = MaterialTheme.typography.bodySmall, color = c)
        } else if (event.ok == true) {
            Icon(Icons.Outlined.Verified, null, Modifier.size(14.dp), tint = c)
            val parts = arrayListOf("Xong")
            event.ms?.takeIf { it > 0 }?.let { ms -> parts.add(if (ms >= 60000) "${(ms / 60000).toInt()} phút" else "${Math.round(ms / 1000)} giây") }
            event.cost?.takeIf { it > 0 }?.let { parts.add(String.format(java.util.Locale.US, "$%.2f", it)) }
            event.t?.let { parts.add(clockTime(it)) }
            Text(parts.joinToString(" · "), style = MaterialTheme.typography.bodySmall, color = c)
        } else {
            Icon(Icons.Outlined.Warning, null, Modifier.size(14.dp), tint = Semantic.red())
            Text(event.text?.takeIf { it.isNotEmpty() } ?: "Lỗi", style = MaterialTheme.typography.bodySmall, color = Semantic.red())
        }
    }
}

@Composable
fun LimitCard(app: AppModel, event: Event, sessionId: String) {
    var busy by remember { mutableStateOf(false) }
    var message by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    Column(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).background(Semantic.red().copy(alpha = 0.08f)).padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Icon(Icons.Outlined.Speed, null, tint = Semantic.red())
            Text("Hết hạn mức", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold, color = Semantic.red())
        }
        Text(event.text ?: "", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        val s = event.suggest
        if (s != null) {
            Button(enabled = !busy && message == null, onClick = {
                scope.launch {
                    busy = true
                    message = try {
                        app.switchAccount(s.id, sessionId, "tiếp tục")
                        "Đã đổi sang ${s.name} và gửi “tiếp tục”"
                    } catch (e: Exception) {
                        if (e is kotlinx.coroutines.CancellationException) throw e
                        (e as? ApiError)?.message ?: e.message
                    }
                    busy = false
                }
            }) {
                if (busy) CircularProgressIndicator(Modifier.size(16.dp).padding(end = 0.dp), strokeWidth = 2.dp, color = MaterialTheme.colorScheme.onPrimary)
                Text("Đổi sang ${s.name} & tiếp tục")
            }
        } else {
            Text("Không có tài khoản khác còn hạn mức.", style = MaterialTheme.typography.bodySmall)
        }
        message?.let { Text(it, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
    }
}

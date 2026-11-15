package vn.peo.ccremote.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CenterAlignedTopAppBar
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import vn.peo.ccremote.AppModel
import vn.peo.ccremote.data.ApiError
import vn.peo.ccremote.data.PermissionMode
import vn.peo.ccremote.data.Prefs
import vn.peo.ccremote.data.Project
import vn.peo.ccremote.data.Route
import vn.peo.ccremote.data.effortLabel
import vn.peo.ccremote.data.modelChoices

@Composable
fun NewSessionScreen(app: AppModel, presetCwd: String?) {
    var projects by remember { mutableStateOf<List<Project>>(emptyList()) }
    var cwd by remember { mutableStateOf(presetCwd ?: Prefs.string("lastCwd") ?: "") }
    var prompt by remember { mutableStateOf("") }
    var mode by remember { mutableStateOf(PermissionMode.Default) }
    var model by remember { mutableStateOf(Prefs.string("lastModel") ?: "") }
    var effort by remember { mutableStateOf("") }
    var thinking by remember { mutableStateOf(true) }
    var touched by remember { mutableStateOf(false) }   // đã chỉnh effort/thinking -> gửi kèm, không thì theo settings của máy
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val picks = remember { mutableStateListOf<PickedImage>() }
    val scope = rememberCoroutineScope()
    val promptFocus = remember { FocusRequester() }
    val caps = app.caps

    LaunchedEffect(Unit) {
        app.loadCaps()
        app.caps?.defaults?.let { d ->
            effort = d.effort ?: ""
            thinking = d.thinking
        }
        try {
            projects = app.projects()
            if (cwd.isEmpty()) projects.firstOrNull()?.let { cwd = it.cwd }
        } catch (e: Exception) {
            if (e is kotlinx.coroutines.CancellationException) throw e
            error = (e as? ApiError)?.message ?: e.message
        }
        runCatching { promptFocus.requestFocus() }
    }

    /** Mức effort của model đang chọn (model rỗng = model mặc định của máy). */
    val efforts: List<String> = run {
        if (caps == null) emptyList() else {
            val want = model.ifEmpty { caps.defaults.modelValue ?: "default" }
            caps.models.firstOrNull { it.value == want }?.efforts ?: caps.efforts
        }
    }

    fun start() {
        scope.launch {
            busy = true
            error = null
            try {
                val options = LinkedHashMap<String, Any?>()
                if (touched) {
                    if (effort.isNotEmpty()) options["effort"] = effort
                    options["thinking"] = thinking
                }
                val encoded = ImagePrep.payloads(app.application, picks.toList())
                val s = app.createSession(cwd.trim(), prompt, mode.raw, model, options, encoded)
                Prefs.putString("lastCwd", cwd)
                Prefs.putString("lastModel", model)
                app.pop()
                app.path.add(Route.Session(s.id))
            } catch (e: Exception) {
                if (e is kotlinx.coroutines.CancellationException) throw e
                error = (e as? ApiError)?.message ?: e.message
            }
            busy = false
        }
    }

    Scaffold(
        topBar = {
            CenterAlignedTopAppBar(
                title = { Text("Phiên mới") },
                navigationIcon = { TextButton(onClick = { app.pop() }) { Text("Huỷ") } },
                actions = {
                    if (busy) {
                        CircularProgressIndicator(Modifier.padding(end = 16.dp).size(22.dp), strokeWidth = 2.dp)
                    } else {
                        TextButton(onClick = { start() }, enabled = cwd.isNotBlank() && prompt.isNotBlank()) { Text("Bắt đầu") }
                    }
                },
            )
        },
    ) { pad ->
        Column(Modifier.fillMaxSize().padding(pad).imePadding().verticalScroll(rememberScrollState())) {
            SectionCard("Thư mục dự án") {
                Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedTextField(
                        value = cwd, onValueChange = { cwd = it }, placeholder = { Text("C:\\Users\\...\\du-an") }, singleLine = true,
                        textStyle = MaterialTheme.typography.bodyMedium.copy(fontFamily = Mono), modifier = Modifier.fillMaxWidth(),
                        keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false),
                    )
                    if (projects.isNotEmpty()) {
                        LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            items(projects, key = { it.cwd }) { p ->
                                FilterChip(selected = p.cwd == cwd, onClick = { cwd = p.cwd }, label = { Text(p.name) })
                            }
                        }
                    }
                }
            }

            SectionCard("Lời nhắn") {
                Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedTextField(
                        value = prompt, onValueChange = { prompt = it }, placeholder = { Text("Bạn muốn Claude làm gì?") },
                        minLines = 4, maxLines = 12, modifier = Modifier.fillMaxWidth().focusRequester(promptFocus),
                    )
                    AttachmentBar(picks, enabled = !busy)
                }
            }

            SectionCard("Tuỳ chọn") {
                DropdownField(
                    "Quyền", mode.label,
                    PermissionMode.entries.map { it.label to it },
                    { mode = it },
                )
                RowDivider()
                val modelOptions: List<Pair<String, String>> =
                    if (caps != null && caps.models.isNotEmpty()) {
                        listOf("Theo máy (${caps.defaults.modelLabel})" to "") + caps.models.filter { it.value != "default" }.map { it.label to it.value }
                    } else modelChoices.map { it.label to it.id }
                DropdownField("Model", modelOptions.firstOrNull { it.second == model }?.first ?: model.ifEmpty { "Mặc định" }, modelOptions, { model = it })
                if (efforts.isNotEmpty()) {
                    RowDivider()
                    Column(Modifier.padding(horizontal = 16.dp, vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text("Effort")
                        SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
                            efforts.forEachIndexed { i, e ->
                                SegmentedButton(
                                    selected = effort == e,
                                    onClick = { effort = e; touched = true },
                                    shape = SegmentedButtonDefaults.itemShape(i, efforts.size),
                                    label = { Text(effortLabel(e), maxLines = 1) },
                                )
                            }
                        }
                    }
                }
                RowDivider()
                Row(
                    Modifier.fillMaxWidth().clickable { thinking = !thinking; touched = true }.padding(horizontal = 16.dp, vertical = 8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text("Thinking", Modifier.weight(1f))
                    Switch(checked = thinking, onCheckedChange = { thinking = it; touched = true })
                }
            }

            error?.let { e -> SectionCard { Column(Modifier.padding(16.dp)) { ErrorLabel(e) } } }
        }
    }
}

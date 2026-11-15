package vn.peo.ccremote.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withLink
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.delay
import vn.peo.ccremote.ui.theme.Semantic
import kotlin.math.ceil
import kotlin.math.floor

private val Body = TextStyle(fontSize = 15.sp, lineHeight = 21.sp)
private val Foot = TextStyle(fontSize = 13.sp, lineHeight = 18.sp)

/** Markdown inline -> AnnotatedString; `code` tô màu và nền như VS Code. */
@Composable
fun rememberInline(s: String, codeSize: Float = 14f): AnnotatedString {
    val codeColor = Semantic.code()
    val codeBg = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.7f)
    val linkColor = MaterialTheme.colorScheme.primary
    return remember(s, codeColor, codeBg, linkColor, codeSize) {
        buildAnnotatedString {
            for (sp in InlineParser.spans(s)) {
                val st = SpanStyle(
                    fontWeight = if (sp.bold) FontWeight.Bold else null,
                    fontStyle = if (sp.italic) FontStyle.Italic else null,
                    textDecoration = if (sp.strike) TextDecoration.LineThrough else null,
                )
                val apply: AnnotatedString.Builder.() -> Unit = {
                    if (sp.code) {
                        withStyle(st.merge(SpanStyle(fontFamily = Mono, fontSize = codeSize.sp, color = codeColor, background = codeBg))) { append(sp.text) }
                    } else {
                        withStyle(st) { append(sp.text) }
                    }
                }
                if (sp.link != null) {
                    withLink(LinkAnnotation.Url(sp.link, TextLinkStyles(SpanStyle(color = linkColor, textDecoration = TextDecoration.Underline)))) { apply() }
                } else apply()
            }
        }
    }
}

/** Markdown giống khung chat trong VS Code: tiêu đề, danh sách, bảng, trích dẫn, khối code, `code` inline. */
@Composable
fun MarkdownText(text: String, modifier: Modifier = Modifier) {
    val blocks = remember(text) { MarkdownParser.parse(text) }
    SelectionContainer {
        Column(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            blocks.forEach { b -> BlockView(b) }
        }
    }
}

@Composable
private fun BlockView(b: MarkdownParser.Block) {
    when (b) {
        is MarkdownParser.Block.Heading -> Text(
            rememberInline(b.text),
            style = when {
                b.level <= 1 -> MaterialTheme.typography.titleLarge.copy(fontWeight = FontWeight.Bold, fontSize = 20.sp)
                b.level == 2 -> MaterialTheme.typography.titleMedium.copy(fontWeight = FontWeight.Bold, fontSize = 17.sp)
                else -> MaterialTheme.typography.titleSmall.copy(fontWeight = FontWeight.SemiBold, fontSize = 15.sp)
            },
            modifier = Modifier.padding(top = 4.dp),
        )
        is MarkdownParser.Block.Paragraph -> Text(rememberInline(b.text), style = Body)
        is MarkdownParser.Block.ListBlock -> Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
            b.items.forEach { it ->
                Row(Modifier.padding(start = (it.indent * 16).dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text(
                        it.marker, style = Body.copy(fontFeatureSettings = "tnum"), color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.widthIn(min = 14.dp), textAlign = TextAlign.End,
                    )
                    Text(rememberInline(it.text), style = Body, modifier = Modifier.weight(1f))
                }
            }
        }
        is MarkdownParser.Block.Code -> CodeBlock(b.text, label = b.lang.ifEmpty { null })
        is MarkdownParser.Block.Table -> TableBlock(b.aligns, b.rows)
        is MarkdownParser.Block.Quote -> Row(Modifier.height(IntrinsicSize.Min), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Box(Modifier.width(3.dp).fillMaxHeight().clip(RoundedCornerShape(1.5.dp)).background(MaterialTheme.colorScheme.outline.copy(alpha = 0.5f)))
            Text(rememberInline(b.text), style = Body, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        MarkdownParser.Block.Rule -> HorizontalDivider(Modifier.padding(vertical = 2.dp))
    }
}

// ---------- khối dùng chung ----------

@Composable
fun CodeBlock(text: String, modifier: Modifier = Modifier, tint: Color? = null, label: String? = null, maxLines: Int? = null) {
    Column(
        modifier.fillMaxWidth().clip(RoundedCornerShape(8.dp)).background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.6f)),
    ) {
        if (label != null) {
            Text(label, Modifier.padding(start = 10.dp, top = 6.dp), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, fontWeight = FontWeight.SemiBold)
        }
        Box(Modifier.horizontalScroll(rememberScrollState()).padding(10.dp)) {
            Text(
                text, style = TextStyle(fontFamily = Mono, fontSize = 12.sp, lineHeight = 17.sp),
                color = tint ?: MaterialTheme.colorScheme.onSurface,
                maxLines = maxLines ?: Int.MAX_VALUE, softWrap = false, overflow = TextOverflow.Clip,
            )
        }
    }
}

/**
 * Bảng markdown: hàng đầu là tiêu đề. Vừa màn hình thì cột dài được bóp lại cho chữ xuống dòng;
 * nhiều cột tới mức bóp vẫn không vừa mới cuộn ngang. Hàng cao bằng ô cao nhất *đo ở đúng bề rộng cột*
 * nên ô nhiều dòng không đè sang hàng khác.
 */
@Composable
fun TableBlock(aligns: List<MarkdownParser.Align>, rows: List<List<String>>) {
    val cols = rows.maxOfOrNull { it.size } ?: 0
    if (cols == 0) return
    val measurer = rememberTextMeasurer()
    val density = LocalDensity.current
    val cellStyle = Foot
    val headStyle = Foot.copy(fontWeight = FontWeight.SemiBold)
    // một ô: chữ + 8dp lề hai bên
    val cellPad = 8.dp
    BoxWithConstraints(Modifier.fillMaxWidth()) {
        val avail = maxWidth
        val natural: List<Dp> = remember(rows, cols, density) {
            (0 until cols).map { c ->
                var w = 0f
                rows.forEachIndexed { r, row ->
                    val raw = row.getOrNull(c) ?: ""
                    val plain = InlineParser.spans(raw).joinToString("") { it.text }
                    val m = measurer.measure(plain, style = if (r == 0) headStyle else cellStyle, softWrap = false)
                    w = maxOf(w, m.size.width.toFloat())
                }
                with(density) { (ceil(w).toInt().toDp()) + cellPad * 2 }
            }
        }
        val minWrap = 96.dp
        val maxCol = 240.dp
        val total = natural.fold(0.dp) { a, b -> a + b }
        val fits = natural.fold(0.dp) { a, b -> a + minOf(b, minWrap) } <= avail
        val widths: List<Dp> = if (fits) {
            if (total > avail) {
                // cột hẹp giữ nguyên, các cột dài chia đều phần còn lại
                var room = avail.value
                var left = cols
                var cap = avail.value
                for (w in natural.map { it.value }.sorted()) {
                    if (w > room / left) { cap = room / left; break }
                    room -= w
                    left -= 1
                }
                val capped = maxOf(floor(cap), minWrap.value)
                natural.map { minOf(it.value, capped).dp }
            } else natural
        } else natural.map { minOf(it, maxCol) }

        val grid: @Composable () -> Unit = {
            val line = MaterialTheme.colorScheme.outline.copy(alpha = 0.3f)
            Column(Modifier.clip(RoundedCornerShape(6.dp)).border(1.dp, MaterialTheme.colorScheme.outline.copy(alpha = 0.35f), RoundedCornerShape(6.dp))) {
                rows.forEachIndexed { r, row ->
                    Row(Modifier.height(IntrinsicSize.Min)) {
                        for (c in 0 until cols) {
                            val al = aligns.getOrNull(c) ?: MarkdownParser.Align.Leading
                            Box(
                                Modifier.width(widths[c]).fillMaxHeight()
                                    .background(if (r == 0) MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.6f) else Color.Transparent)
                                    .border(0.5.dp, line),
                                contentAlignment = when (al) {
                                    MarkdownParser.Align.Trailing -> Alignment.TopEnd
                                    MarkdownParser.Align.Center -> Alignment.TopCenter
                                    else -> Alignment.TopStart
                                },
                            ) {
                                Text(
                                    rememberInline(row.getOrNull(c) ?: "", codeSize = 12f),
                                    style = (if (r == 0) headStyle else cellStyle).copy(
                                        textAlign = when (al) {
                                            MarkdownParser.Align.Trailing -> TextAlign.End
                                            MarkdownParser.Align.Center -> TextAlign.Center
                                            else -> TextAlign.Start
                                        },
                                    ),
                                    modifier = Modifier.padding(horizontal = cellPad, vertical = 6.dp),
                                )
                            }
                        }
                    }
                }
            }
        }
        if (fits) grid() else Box(Modifier.horizontalScroll(rememberScrollState())) { grid() }
    }
}

/** Diff của Edit: dòng cũ đỏ (-), dòng mới xanh (+), như khung Edit trong VS Code. */
@Composable
fun DiffBlock(old: String, new: String, maxLines: Int = 14, modifier: Modifier = Modifier) {
    val olds = if (old.isEmpty()) emptyList() else old.split("\n")
    val news = if (new.isEmpty()) emptyList() else new.split("\n")
    val lines = olds.map { it to false } + news.map { it to true }
    val red = Semantic.red().copy(alpha = 0.14f)
    val green = Semantic.green().copy(alpha = 0.16f)
    Column(modifier.fillMaxWidth().clip(RoundedCornerShape(8.dp)).background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.6f)).padding(vertical = 4.dp)) {
        Column(Modifier.horizontalScroll(rememberScrollState())) {
            lines.take(maxLines).forEach { (l, add) ->
                Text(
                    (if (add) "+ " else "- ") + l,
                    style = TextStyle(fontFamily = Mono, fontSize = 12.sp, lineHeight = 17.sp),
                    softWrap = false,
                    modifier = Modifier.widthIn(min = 0.dp).fillMaxWidth().background(if (add) green else red).padding(horizontal = 8.dp, vertical = 1.dp),
                )
            }
        }
        if (lines.size > maxLines) {
            Text("… thêm ${lines.size - maxLines} dòng", Modifier.padding(6.dp), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

/** Khung IN / OUT như tool Bash trong VS Code. */
@Composable
fun InOutBlock(input: String?, output: String?, outputError: Boolean = false, outputLines: Int? = 8, modifier: Modifier = Modifier) {
    Column(modifier.fillMaxWidth().clip(RoundedCornerShape(8.dp)).background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.6f))) {
        if (!input.isNullOrEmpty()) IORow("IN", input, 6, null)
        if (!input.isNullOrEmpty() && !output.isNullOrEmpty()) HorizontalDivider()
        if (!output.isNullOrEmpty()) IORow("OUT", output, outputLines, if (outputError) Semantic.red() else null)
    }
}

@Composable
private fun IORow(label: String, text: String, lines: Int?, tint: Color?) {
    Row(Modifier.padding(horizontal = 10.dp, vertical = 8.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        Text(label, Modifier.width(28.dp), style = TextStyle(fontFamily = Mono, fontSize = 10.sp), color = MaterialTheme.colorScheme.onSurfaceVariant)
        Box(Modifier.weight(1f).horizontalScroll(rememberScrollState())) {
            Text(
                text, style = TextStyle(fontFamily = Mono, fontSize = 12.sp, lineHeight = 17.sp), color = tint ?: MaterialTheme.colorScheme.onSurface,
                maxLines = lines ?: Int.MAX_VALUE, softWrap = false, overflow = TextOverflow.Clip,
            )
        }
    }
}

/** Chấm + đường dọc bên trái như timeline của Claude Code trong VS Code. */
@Composable
fun TimelineRow(color: Color, modifier: Modifier = Modifier, content: @Composable () -> Unit) {
    val rail = MaterialTheme.colorScheme.outline.copy(alpha = 0.3f)
    Box(
        modifier.fillMaxWidth().drawBehind {
            drawLine(rail, Offset(5.dp.toPx(), 0f), Offset(5.dp.toPx(), size.height), strokeWidth = 1.5.dp.toPx())
            drawCircle(color, radius = 5.dp.toPx(), center = Offset(5.dp.toPx(), 10.dp.toPx()))
        }.padding(start = 20.dp),
    ) { content() }
}

/** Dòng chữ chạy khi Claude đang làm, như VS Code: ký hiệu cam nhấp nháy (· ✢ ✳ ✶ ✻ ✽) + "Vibing…". */
@Composable
fun SpinnerLine(verb: String) {
    val frames = remember { listOf("·", "✢", "✳", "✶", "✻", "✽", "✻", "✶", "✳", "✢") }
    var i by remember { mutableIntStateOf(0) }
    LaunchedEffect(Unit) {
        while (true) {
            delay(120)
            i = (i + 1) % frames.size
        }
    }
    Row(Modifier.padding(start = 2.dp, top = 2.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(frames[i], Modifier.width(16.dp), color = Color(0xFFD97857), fontWeight = FontWeight.Bold, fontSize = 17.sp, textAlign = TextAlign.Center)
        Text("$verb…", fontWeight = FontWeight.SemiBold, fontSize = 15.sp, color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.85f))
    }
}

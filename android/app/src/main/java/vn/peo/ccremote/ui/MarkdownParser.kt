package vn.peo.ccremote.ui

/**
 * Markdown tự viết, giống ios/CCRemote/Markdown.swift: tiêu đề, danh sách, bảng, trích dẫn, khối code, `code` inline.
 * Phần này thuần Kotlin (không phụ thuộc Compose) để chạy được unit test JVM.
 */
object MarkdownParser {
    enum class Align { Leading, Center, Trailing }

    data class Item(val indent: Int, val marker: String, val text: String)

    sealed class Block {
        data class Heading(val level: Int, val text: String) : Block()
        data class Paragraph(val text: String) : Block()
        data class ListBlock(val items: List<Item>) : Block()
        data class Code(val lang: String, val text: String) : Block()

        /** căn lề từng cột (từ dòng `|:--|--:|`), các hàng (hàng đầu là tiêu đề) */
        data class Table(val aligns: List<Align>, val rows: List<List<String>>) : Block()
        data class Quote(val text: String) : Block()
        data object Rule : Block()
    }

    /** Swift `.whitespaces`: khoảng trắng và tab, không gồm xuống dòng. */
    private fun String.trimWs(): String = trim { it == ' ' || it == '\t' || it == ' ' }

    fun parse(text: String): List<Block> {
        val lines = text.replace("\r\n", "\n").split("\n")
        val out = ArrayList<Block>()
        val para = ArrayList<String>()
        var i = 0
        fun flush() {
            val p = para.joinToString("\n").trim()
            if (p.isNotEmpty()) out.add(Block.Paragraph(p))
            para.clear()
        }
        while (i < lines.size) {
            val line = lines[i]
            val t = line.trimWs()

            if (t.startsWith("```") || t.startsWith("~~~")) {
                flush()
                val fence = t.take(3)
                val lang = t.drop(3).trimWs()
                val code = ArrayList<String>()
                i++
                while (i < lines.size && !lines[i].trimWs().startsWith(fence)) {
                    code.add(lines[i])
                    i++
                }
                out.add(Block.Code(lang, code.joinToString("\n")))
                i++
                continue
            }
            if (t.isEmpty()) { flush(); i++; continue }
            heading(t)?.let { h -> flush(); out.add(Block.Heading(h.first, h.second)); i++; continue }
            if (isRule(t)) { flush(); out.add(Block.Rule); i++; continue }
            if (t.startsWith("|") && i + 1 < lines.size && isTableSeparator(lines[i + 1])) {
                flush()
                val aligns = cells(lines[i + 1].trimWs()).map { alignment(it) }
                val rows = arrayListOf(cells(t))
                i += 2
                while (i < lines.size && lines[i].trimWs().startsWith("|")) {
                    rows.add(cells(lines[i].trimWs()))
                    i++
                }
                out.add(Block.Table(aligns, rows))
                continue
            }
            if (t.startsWith(">")) {
                flush()
                val q = ArrayList<String>()
                while (i < lines.size && lines[i].trimWs().startsWith(">")) {
                    q.add(lines[i].trimWs().drop(1).trimWs())
                    i++
                }
                out.add(Block.Quote(q.joinToString("\n")))
                continue
            }
            if (listItem(line) != null) {
                flush()
                val items = ArrayList<Item>()
                while (i < lines.size) {
                    val it = listItem(lines[i])
                    if (it != null) {
                        items.add(it)
                    } else if (lines[i].trimWs().isNotEmpty() && lines[i].startsWith("  ") && items.isNotEmpty()) {
                        // dòng tiếp nối của mục trước
                        val last = items.removeAt(items.size - 1)
                        items.add(Item(last.indent, last.marker, last.text + "\n" + lines[i].trimWs()))
                    } else {
                        break
                    }
                    i++
                }
                out.add(Block.ListBlock(items))
                continue
            }
            para.add(line)
            i++
        }
        flush()
        return out
    }

    private fun heading(t: String): Pair<Int, String>? {
        var level = 0
        for (ch in t) { if (ch == '#') level++ else break }
        if (level !in 1..6 || t.length <= level || t[level] != ' ') return null
        return level to t.drop(level + 1)
    }

    private fun isRule(t: String): Boolean {
        val s = t.replace(" ", "")
        val c = s.firstOrNull() ?: return false
        if (s.length < 3 || c !in "-*_") return false
        return s.all { it == c }
    }

    fun isTableSeparator(line: String): Boolean {
        val t = line.trimWs()
        if (!t.contains('-') || !t.contains('|')) return false
        return t.all { it in "|-: " }
    }

    /** Tách ô theo `|`, trừ `\|` (dấu | nằm trong ô, vd. `a \| b`); `<br>` thành xuống dòng như GitHub. */
    fun cells(t: String): List<String> {
        var s = t
        if (s.startsWith("|")) s = s.drop(1)
        if (s.endsWith("|") && !s.endsWith("\\|")) s = s.dropLast(1)
        val out = ArrayList<String>()
        val cur = StringBuilder()
        for (ch in s) {
            if (ch == '|' && cur.isNotEmpty() && cur.last() == '\\') {
                cur.setLength(cur.length - 1)
                cur.append('|')
            } else if (ch == '|') {
                out.add(cur.toString())
                cur.setLength(0)
            } else {
                cur.append(ch)
            }
        }
        out.add(cur.toString())
        val br = Regex("<br\\s*/?>", RegexOption.IGNORE_CASE)
        return out.map { br.replace(it, "\n").trim() }
    }

    private fun alignment(c: String): Align {
        val t = c.trim()
        return if (t.startsWith(":") && t.endsWith(":") && t.length > 1) Align.Center else if (t.endsWith(":")) Align.Trailing else Align.Leading
    }

    private fun listItem(line: String): Item? {
        val indent = line.takeWhile { it == ' ' }.length / 2
        val t = line.trimWs()
        for (m in listOf("- ", "* ", "+ ")) {
            if (t.startsWith(m)) {
                val rest = t.drop(2)
                if (rest.startsWith("[ ] ")) return Item(indent, "☐", rest.drop(4))
                if (rest.startsWith("[x] ") || rest.startsWith("[X] ")) return Item(indent, "☑", rest.drop(4))
                return Item(indent, "•", rest)
            }
        }
        val digits = t.takeWhile { it.isDigit() }
        if (digits.isNotEmpty() && digits.length <= 3) {
            val after = t.drop(digits.length)
            if (after.startsWith(". ") || after.startsWith(") ")) return Item(indent, "$digits.", after.drop(2))
        }
        return null
    }
}

/** Một đoạn chữ inline đã gỡ ký hiệu markdown. */
data class Span(
    val text: String,
    val bold: Boolean = false,
    val italic: Boolean = false,
    val strike: Boolean = false,
    val code: Boolean = false,
    val link: String? = null,
)

/** Markdown inline: **đậm**, *nghiêng* / _nghiêng_, ~~gạch~~, `code`, [chữ](url), `\` thoát ký tự. */
object InlineParser {
    fun spans(s: String): List<Span> {
        val out = ArrayList<Span>()
        parse(s, Span(""), out)
        // gộp các đoạn liền nhau cùng kiểu
        val merged = ArrayList<Span>()
        for (sp in out) {
            val last = merged.lastOrNull()
            if (last != null && last.copy(text = "") == sp.copy(text = "")) merged[merged.size - 1] = last.copy(text = last.text + sp.text)
            else if (sp.text.isNotEmpty()) merged.add(sp)
        }
        return merged
    }

    private fun emit(out: MutableList<Span>, style: Span, text: String) {
        if (text.isNotEmpty()) out.add(style.copy(text = text))
    }

    private fun isWord(c: Char?) = c != null && (c.isLetterOrDigit())

    private fun parse(s: String, style: Span, out: MutableList<Span>) {
        val buf = StringBuilder()
        fun flushBuf() { emit(out, style, buf.toString()); buf.setLength(0) }
        var i = 0
        while (i < s.length) {
            val c = s[i]
            // thoát ký tự
            if (c == '\\' && i + 1 < s.length && !s[i + 1].isLetterOrDigit() && s[i + 1] != ' ' && s[i + 1] != '\n') {
                buf.append(s[i + 1]); i += 2; continue
            }
            // `code` (n dấu ` mở, n dấu ` đóng)
            if (c == '`') {
                var n = 0
                while (i + n < s.length && s[i + n] == '`') n++
                val fence = "`".repeat(n)
                val close = findRun(s, fence, i + n)
                if (close >= 0) {
                    flushBuf()
                    var inner = s.substring(i + n, close)
                    if (inner.length > 1 && inner.startsWith(" ") && inner.endsWith(" ") && inner.isNotBlank()) inner = inner.substring(1, inner.length - 1)
                    out.add(style.copy(text = inner, code = true))
                    i = close + n
                    continue
                }
                buf.append(fence); i += n; continue
            }
            // [chữ](url)
            if (c == '[') {
                val rb = findBracketEnd(s, i)
                if (rb > 0 && rb + 1 < s.length && s[rb + 1] == '(') {
                    val rp = s.indexOf(')', rb + 2)
                    if (rp > 0) {
                        val url = s.substring(rb + 2, rp).trim().substringBefore(' ')
                        if (url.isNotEmpty()) {
                            flushBuf()
                            parse(s.substring(i + 1, rb), style.copy(link = url), out)
                            i = rp + 1
                            continue
                        }
                    }
                }
            }
            // **đậm** / __đậm__
            if ((c == '*' || c == '_') && i + 1 < s.length && s[i + 1] == c) {
                val d = "$c$c"
                val close = findDelim(s, d, i + 2, c == '_')
                if (close > i + 2 && !s[i + 2].isWhitespace()) {
                    if (c != '_' || !isWord(s.getOrNull(i - 1))) {
                        flushBuf()
                        parse(s.substring(i + 2, close), style.copy(bold = true), out)
                        i = close + 2
                        continue
                    }
                }
            }
            // ~~gạch~~
            if (c == '~' && i + 1 < s.length && s[i + 1] == '~') {
                val close = s.indexOf("~~", i + 2)
                if (close > i + 2) {
                    flushBuf()
                    parse(s.substring(i + 2, close), style.copy(strike = true), out)
                    i = close + 2
                    continue
                }
            }
            // *nghiêng* / _nghiêng_
            if (c == '*' || c == '_') {
                val d = c.toString()
                val close = findDelim(s, d, i + 1, c == '_')
                val opens = i + 1 < s.length && !s[i + 1].isWhitespace() && s[i + 1] != c
                if (close > i + 1 && opens && (c != '_' || !isWord(s.getOrNull(i - 1)))) {
                    flushBuf()
                    parse(s.substring(i + 1, close), style.copy(italic = true), out)
                    i = close + 1
                    continue
                }
            }
            buf.append(c)
            i++
        }
        flushBuf()
    }

    /** Vị trí chuỗi gồm đúng `fence` (không dính thêm dấu ` ở hai đầu) từ `from`; -1 nếu không có. */
    private fun findRun(s: String, fence: String, from: Int): Int {
        var i = from
        while (true) {
            val k = s.indexOf(fence, i)
            if (k < 0) return -1
            val before = s.getOrNull(k - 1)
            val after = s.getOrNull(k + fence.length)
            if (before != '`' && after != '`') return k
            i = k + 1
        }
    }

    /** Dấu đóng của `d` ở `from..`: không đứng sau khoảng trắng, không nằm trong `code`; `_` thì không dính chữ phía sau. */
    private fun findDelim(s: String, d: String, from: Int, underscore: Boolean): Int {
        var i = from
        while (i < s.length) {
            val c = s[i]
            if (c == '\\') { i += 2; continue }
            if (c == '`') {
                var n = 0
                while (i + n < s.length && s[i + n] == '`') n++
                val close = findRun(s, "`".repeat(n), i + n)
                i = if (close >= 0) close + n else i + n
                continue
            }
            if (s.startsWith(d, i) && i > from && !s[i - 1].isWhitespace()) {
                val after = s.getOrNull(i + d.length)
                if (d.length == 1 && after == d[0]) { i++; continue }   // "**" bên trong khi tìm "*"
                if (!underscore || !isWord(after)) return i
            }
            i++
        }
        return -1
    }

    private fun findBracketEnd(s: String, open: Int): Int {
        var depth = 0
        var i = open
        while (i < s.length) {
            when (s[i]) {
                '\\' -> i++
                '[' -> depth++
                ']' -> { depth--; if (depth == 0) return i }
            }
            i++
        }
        return -1
    }
}

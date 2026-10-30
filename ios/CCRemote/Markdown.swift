import SwiftUI

// MARK: - Markdown giống khung chat trong VS Code: tiêu đề, danh sách, bảng, trích dẫn, khối code, `code` inline.

struct MarkdownText: View {
    let text: String

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(MarkdownParser.parse(text).enumerated()), id: \.offset) { _, block in
                blockView(block)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder private func blockView(_ b: MarkdownParser.Block) -> some View {
        switch b {
        case .heading(let level, let s):
            Text(Inline.attributed(s))
                .font(level <= 1 ? .title3.weight(.bold) : level == 2 ? .headline : .subheadline.weight(.semibold))
                .padding(.top, 4)
                .textSelection(.enabled)
        case .paragraph(let s):
            Text(Inline.attributed(s))
                .font(.callout)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
        case .list(let items):
            VStack(alignment: .leading, spacing: 4) {
                ForEach(Array(items.enumerated()), id: \.offset) { _, it in
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text(it.marker)
                            .font(.callout.monospacedDigit())
                            .foregroundStyle(.secondary)
                            .frame(minWidth: 14, alignment: .trailing)
                        Text(Inline.attributed(it.text))
                            .font(.callout)
                            .textSelection(.enabled)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .padding(.leading, CGFloat(it.indent) * 16)
                }
            }
        case .code(let lang, let s):
            CodeBlock(text: s, label: lang.isEmpty ? nil : lang)
        case .table(let aligns, let rows):
            TableBlock(aligns: aligns, rows: rows)
        case .quote(let s):
            HStack(alignment: .top, spacing: 8) {
                RoundedRectangle(cornerRadius: 1.5).fill(Color.secondary.opacity(0.4)).frame(width: 3)
                Text(Inline.attributed(s)).font(.callout).foregroundStyle(.secondary).textSelection(.enabled)
            }
            .fixedSize(horizontal: false, vertical: true)
        case .rule:
            Divider().padding(.vertical, 2)
        }
    }
}

enum MarkdownParser {
    struct Item: Hashable {
        let indent: Int
        let marker: String
        let text: String
    }

    enum Block: Hashable {
        case heading(Int, String)
        case paragraph(String)
        case list([Item])
        case code(String, String)
        /// căn lề từng cột (từ dòng `|:--|--:|`), các hàng (hàng đầu là tiêu đề)
        case table([TextAlignment], [[String]])
        case quote(String)
        case rule
    }

    static func parse(_ text: String) -> [Block] {
        let lines = text.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n")
        var out: [Block] = []
        var para: [String] = []
        var i = 0
        func flush() {
            let p = para.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
            if !p.isEmpty { out.append(.paragraph(p)) }
            para = []
        }
        while i < lines.count {
            let line = lines[i]
            let t = line.trimmingCharacters(in: .whitespaces)

            if t.hasPrefix("```") || t.hasPrefix("~~~") {
                flush()
                let fence = String(t.prefix(3))
                let lang = String(t.dropFirst(3)).trimmingCharacters(in: .whitespaces)
                var code: [String] = []
                i += 1
                while i < lines.count && !lines[i].trimmingCharacters(in: .whitespaces).hasPrefix(fence) {
                    code.append(lines[i])
                    i += 1
                }
                out.append(.code(lang, code.joined(separator: "\n")))
                i += 1
                continue
            }
            if t.isEmpty { flush(); i += 1; continue }
            if let h = heading(t) { flush(); out.append(.heading(h.0, h.1)); i += 1; continue }
            if isRule(t) { flush(); out.append(.rule); i += 1; continue }
            if t.hasPrefix("|"), i + 1 < lines.count, isTableSeparator(lines[i + 1]) {
                flush()
                let aligns = cells(lines[i + 1].trimmingCharacters(in: .whitespaces)).map(alignment)
                var rows = [cells(t)]
                i += 2
                while i < lines.count, lines[i].trimmingCharacters(in: .whitespaces).hasPrefix("|") {
                    rows.append(cells(lines[i].trimmingCharacters(in: .whitespaces)))
                    i += 1
                }
                out.append(.table(aligns, rows))
                continue
            }
            if t.hasPrefix(">") {
                flush()
                var q: [String] = []
                while i < lines.count, lines[i].trimmingCharacters(in: .whitespaces).hasPrefix(">") {
                    q.append(String(lines[i].trimmingCharacters(in: .whitespaces).dropFirst()).trimmingCharacters(in: .whitespaces))
                    i += 1
                }
                out.append(.quote(q.joined(separator: "\n")))
                continue
            }
            if listItem(line) != nil {
                flush()
                var items: [Item] = []
                while i < lines.count {
                    if let it = listItem(lines[i]) {
                        items.append(it)
                    } else if !lines[i].trimmingCharacters(in: .whitespaces).isEmpty, lines[i].hasPrefix("  "), let last = items.popLast() {
                        // dòng tiếp nối của mục trước
                        items.append(Item(indent: last.indent, marker: last.marker, text: last.text + "\n" + lines[i].trimmingCharacters(in: .whitespaces)))
                    } else {
                        break
                    }
                    i += 1
                }
                out.append(.list(items))
                continue
            }
            para.append(line)
            i += 1
        }
        flush()
        return out
    }

    private static func heading(_ t: String) -> (Int, String)? {
        var level = 0
        for ch in t { if ch == "#" { level += 1 } else { break } }
        guard (1...6).contains(level), t.count > level, t[t.index(t.startIndex, offsetBy: level)] == " " else { return nil }
        return (level, String(t.dropFirst(level + 1)))
    }

    private static func isRule(_ t: String) -> Bool {
        let s = t.replacingOccurrences(of: " ", with: "")
        guard s.count >= 3, let c = s.first, "-*_".contains(c) else { return false }
        return s.allSatisfy { $0 == c }
    }

    private static func isTableSeparator(_ line: String) -> Bool {
        let t = line.trimmingCharacters(in: .whitespaces)
        guard t.contains("-"), t.contains("|") else { return false }
        return t.allSatisfy { "|-: ".contains($0) }
    }

    /// Tách ô theo `|`, trừ `\|` (dấu | nằm trong ô, vd. `a \| b`); `<br>` thành xuống dòng như GitHub.
    private static func cells(_ t: String) -> [String] {
        var s = Substring(t)
        if s.hasPrefix("|") { s = s.dropFirst() }
        if s.hasSuffix("|"), !s.hasSuffix("\\|") { s = s.dropLast() }
        var out: [String] = []
        var cur = ""
        for ch in s {
            if ch == "|", cur.hasSuffix("\\") {
                cur.removeLast()
                cur.append("|")
            } else if ch == "|" {
                out.append(cur)
                cur = ""
            } else {
                cur.append(ch)
            }
        }
        out.append(cur)
        return out.map {
            $0.replacingOccurrences(of: "<br\\s*/?>", with: "\n", options: [.regularExpression, .caseInsensitive])
                .trimmingCharacters(in: .whitespacesAndNewlines)
        }
    }

    private static func alignment(_ c: String) -> TextAlignment {
        c.hasPrefix(":") && c.hasSuffix(":") && c.count > 1 ? .center : c.hasSuffix(":") ? .trailing : .leading
    }

    private static func listItem(_ line: String) -> Item? {
        let indent = line.prefix { $0 == " " }.count / 2
        let t = line.trimmingCharacters(in: .whitespaces)
        for m in ["- ", "* ", "+ "] where t.hasPrefix(m) {
            let rest = String(t.dropFirst(2))
            if rest.hasPrefix("[ ] ") { return Item(indent: indent, marker: "☐", text: String(rest.dropFirst(4))) }
            if rest.hasPrefix("[x] ") || rest.hasPrefix("[X] ") { return Item(indent: indent, marker: "☑", text: String(rest.dropFirst(4))) }
            return Item(indent: indent, marker: "•", text: rest)
        }
        let digits = t.prefix { $0.isNumber }
        if !digits.isEmpty, digits.count <= 3 {
            let after = t.dropFirst(digits.count)
            if after.hasPrefix(". ") || after.hasPrefix(") ") {
                return Item(indent: indent, marker: "\(digits).", text: String(after.dropFirst(2)))
            }
        }
        return nil
    }
}

enum Inline {
    /// Markdown inline (đậm, nghiêng, link, `code`), `code` tô màu và nền như VS Code.
    static func attributed(_ s: String, code: Font = .system(.callout, design: .monospaced)) -> AttributedString {
        let opts = AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        var a = (try? AttributedString(markdown: s, options: opts)) ?? AttributedString(s)
        var codeRanges: [Range<AttributedString.Index>] = []
        for run in a.runs where run.inlinePresentationIntent?.contains(.code) == true {
            codeRanges.append(run.range)
        }
        for r in codeRanges {
            a[r].font = code
            a[r].foregroundColor = Color(red: 0.84, green: 0.45, blue: 0.30)
            a[r].backgroundColor = Color(.tertiarySystemFill)
        }
        return a
    }
}

// MARK: - Khối dùng chung

struct CodeBlock: View {
    let text: String
    var tint: Color? = nil
    var label: String? = nil
    var maxLines: Int? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let label {
                Text(label)
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 10).padding(.top, 6)
            }
            ScrollView(.horizontal, showsIndicators: false) {
                Text(text)
                    .font(.caption.monospaced())
                    .foregroundStyle(tint ?? Color.primary)
                    .lineLimit(maxLines)
                    .textSelection(.enabled)
                    .padding(10)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(.tertiarySystemFill), in: RoundedRectangle(cornerRadius: 8))
    }
}

/// Bảng markdown: hàng đầu là tiêu đề. Vừa màn hình thì cột dài được bóp lại cho chữ xuống dòng;
/// nhiều cột tới mức bóp vẫn không vừa mới cuộn ngang.
struct TableBlock: View {
    let aligns: [TextAlignment]
    let rows: [[String]]

    var body: some View {
        let cols = rows.map(\.count).max() ?? 0
        ViewThatFits(in: .horizontal) {
            grid(cols, fit: true)
            ScrollView(.horizontal, showsIndicators: false) { grid(cols, fit: false) }
        }
    }

    private func grid(_ cols: Int, fit: Bool) -> some View {
        TableLayout(cols: cols, fit: fit) {
            ForEach(0..<rows.count * cols, id: \.self) { i in
                cell(i / cols, i % cols)
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: 6))
        .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Color.secondary.opacity(0.35), lineWidth: 1))
    }

    private func cell(_ r: Int, _ c: Int) -> some View {
        let align = c < aligns.count ? aligns[c] : .leading
        return Text(Inline.attributed(c < rows[r].count ? rows[r][c] : "", code: .system(.footnote, design: .monospaced)))
            .font(r == 0 ? .footnote.weight(.semibold) : .footnote)
            .monospacedDigit()
            .multilineTextAlignment(align)
            .textSelection(.enabled)
            .padding(.horizontal, 8).padding(.vertical, 6)
            .frame(maxWidth: .infinity, maxHeight: .infinity,
                   alignment: align == .trailing ? .topTrailing : align == .center ? .top : .topLeading)
            .background(r == 0 ? Color(.tertiarySystemFill) : Color.clear)
            .overlay(Rectangle().stroke(Color.secondary.opacity(0.25), lineWidth: 0.5))
    }
}

/// Xếp ô bảng theo cột: hàng cao bằng ô cao nhất *đo ở đúng bề rộng cột*, nên ô nhiều dòng không
/// tràn đè sang hàng khác (Grid trong ScrollView ngang đo ô như chữ một dòng rồi mới cho xuống dòng).
private struct TableLayout: Layout {
    let cols: Int
    /// true: bóp các cột dài (không hẹp hơn `minWrap`) cho vừa bề rộng được đề nghị; bề rộng lý tưởng
    /// báo cho ViewThatFits là bề rộng hẹp nhất còn đọc được. false: nằm trong ScrollView ngang.
    let fit: Bool
    static let minWrap: CGFloat = 96
    static let maxCol: CGFloat = 240

    /// bề rộng tự nhiên (chữ một dòng) của từng cột
    func makeCache(subviews: Subviews) -> [CGFloat] {
        guard cols > 0 else { return [] }
        var w = Array(repeating: CGFloat(0), count: cols)
        for (i, v) in subviews.enumerated() {
            w[i % cols] = max(w[i % cols], ceil(v.sizeThatFits(.unspecified).width))
        }
        return w
    }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout [CGFloat]) -> CGSize {
        let (w, h) = measure(subviews, natural: cache, width: proposal.width)
        return CGSize(width: w.reduce(0, +), height: h.reduce(0, +))
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout [CGFloat]) {
        let (w, h) = measure(subviews, natural: cache, width: proposal.width)
        var y = bounds.minY
        for r in h.indices {
            var x = bounds.minX
            for c in w.indices {
                subviews[r * cols + c].place(at: CGPoint(x: x, y: y), anchor: .topLeading,
                                             proposal: ProposedViewSize(width: w[c], height: h[r]))
                x += w[c]
            }
            y += h[r]
        }
    }

    private func measure(_ subviews: Subviews, natural: [CGFloat], width: CGFloat?) -> (widths: [CGFloat], heights: [CGFloat]) {
        guard cols > 0, natural.count == cols else { return ([], []) }
        var widths = natural
        if !fit {
            widths = widths.map { min($0, Self.maxCol) }
        } else if let width {
            if widths.reduce(0, +) > width {
                // cột hẹp giữ nguyên, các cột dài chia đều phần còn lại
                var room = width, left = cols, cap = width
                for w in widths.sorted() {
                    if w > room / CGFloat(left) { cap = room / CGFloat(left); break }
                    room -= w
                    left -= 1
                }
                cap = max(floor(cap), Self.minWrap)
                widths = widths.map { min($0, cap) }
            }
        } else {
            widths = widths.map { min($0, Self.minWrap) }
        }
        var heights = Array(repeating: CGFloat(0), count: subviews.count / cols)
        for (i, v) in subviews.enumerated() where i / cols < heights.count {
            let h = v.sizeThatFits(ProposedViewSize(width: widths[i % cols], height: nil)).height
            heights[i / cols] = max(heights[i / cols], ceil(h))
        }
        return (widths, heights)
    }
}

/// Diff của Edit: dòng cũ đỏ (-), dòng mới xanh (+), như khung Edit trong VS Code.
struct DiffBlock: View {
    let old: String
    let new: String
    var maxLines = 14

    var body: some View {
        let olds = old.isEmpty ? [] : old.components(separatedBy: "\n")
        let news = new.isEmpty ? [] : new.components(separatedBy: "\n")
        let lines: [(String, Bool)] = olds.map { ($0, false) } + news.map { ($0, true) }
        ScrollView(.horizontal, showsIndicators: false) {
            VStack(alignment: .leading, spacing: 0) {
                ForEach(Array(lines.prefix(maxLines).enumerated()), id: \.offset) { _, l in
                    Text((l.1 ? "+ " : "- ") + l.0)
                        .font(.caption.monospaced())
                        .padding(.horizontal, 8).padding(.vertical, 1)
                        .frame(minWidth: 0, maxWidth: .infinity, alignment: .leading)
                        .background(l.1 ? Color.green.opacity(0.16) : Color.red.opacity(0.14))
                }
                if lines.count > maxLines {
                    Text("… thêm \(lines.count - maxLines) dòng")
                        .font(.caption2).foregroundStyle(.secondary).padding(6)
                }
            }
            .padding(.vertical, 4)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(.tertiarySystemFill), in: RoundedRectangle(cornerRadius: 8))
    }
}

/// Khung IN / OUT như tool Bash trong VS Code.
struct InOutBlock: View {
    let input: String?
    let output: String?
    var outputError = false
    var outputLines: Int? = 8

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let input, !input.isEmpty { row("IN", input, lines: 6, tint: nil) }
            if let input, !input.isEmpty, let output, !output.isEmpty { Divider() }
            if let output, !output.isEmpty { row("OUT", output, lines: outputLines, tint: outputError ? .red : nil) }
        }
        .background(Color(.tertiarySystemFill), in: RoundedRectangle(cornerRadius: 8))
    }

    private func row(_ label: String, _ text: String, lines: Int?, tint: Color?) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Text(label)
                .font(.caption2.monospaced())
                .foregroundStyle(.secondary)
                .frame(width: 28, alignment: .leading)
            ScrollView(.horizontal, showsIndicators: false) {
                Text(text)
                    .font(.caption.monospaced())
                    .foregroundStyle(tint ?? Color.primary)
                    .lineLimit(lines)
                    .textSelection(.enabled)
            }
        }
        .padding(.horizontal, 10).padding(.vertical, 8)
    }
}

/// Chấm + đường dọc bên trái như timeline của Claude Code trong VS Code.
struct TimelineRow<Content: View>: View {
    let color: Color
    @ViewBuilder let content: Content

    var body: some View {
        content
            .padding(.leading, 20)
            .frame(maxWidth: .infinity, alignment: .leading)
            .overlay(alignment: .leading) {
                Rectangle().fill(Color.secondary.opacity(0.18)).frame(width: 1.5).padding(.leading, 4.25)
            }
            .overlay(alignment: .topLeading) {
                Circle().fill(color).frame(width: 10, height: 10).padding(.top, 5)
            }
    }
}

/// Dòng chữ chạy khi Claude đang làm, như VS Code: ký hiệu cam nhấp nháy (· ✢ ✳ ✶ ✻ ✽) + "Vibing…".
struct SpinnerLine: View {
    let verb: String
    private static let frames = ["·", "✢", "✳", "✶", "✻", "✽", "✻", "✶", "✳", "✢"]
    private static let coral = Color(red: 0.85, green: 0.47, blue: 0.34)

    var body: some View {
        TimelineView(.periodic(from: .now, by: 0.12)) { ctx in
            let i = Int(ctx.date.timeIntervalSinceReferenceDate / 0.12) % Self.frames.count
            HStack(spacing: 8) {
                Text(Self.frames[i])
                    .font(.body.weight(.bold))
                    .foregroundStyle(Self.coral)
                    .frame(width: 16)
                Text("\(verb)…")
                    .font(.callout.weight(.semibold))
                    .foregroundStyle(.primary.opacity(0.85))
            }
        }
        .padding(.leading, 2)
        .padding(.top, 2)
    }
}

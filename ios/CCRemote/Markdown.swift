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
        case .table(let rows):
            TableBlock(rows: rows)
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
        case table([[String]])
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
                var rows = [cells(t)]
                i += 2
                while i < lines.count, lines[i].trimmingCharacters(in: .whitespaces).hasPrefix("|") {
                    rows.append(cells(lines[i].trimmingCharacters(in: .whitespaces)))
                    i += 1
                }
                out.append(.table(rows))
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
        guard t.contains("-") else { return false }
        return t.allSatisfy { "|-: ".contains($0) }
    }

    private static func cells(_ t: String) -> [String] {
        var s = t
        if s.hasPrefix("|") { s.removeFirst() }
        if s.hasSuffix("|") { s.removeLast() }
        return s.components(separatedBy: "|").map { $0.trimmingCharacters(in: .whitespaces) }
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
    static func attributed(_ s: String) -> AttributedString {
        let opts = AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        var a = (try? AttributedString(markdown: s, options: opts)) ?? AttributedString(s)
        var codeRanges: [Range<AttributedString.Index>] = []
        for run in a.runs where run.inlinePresentationIntent?.contains(.code) == true {
            codeRanges.append(run.range)
        }
        for r in codeRanges {
            a[r].font = .system(.callout, design: .monospaced)
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

/// Bảng markdown: hàng đầu là tiêu đề, cuộn ngang khi rộng.
struct TableBlock: View {
    let rows: [[String]]

    var body: some View {
        let cols = rows.map(\.count).max() ?? 0
        ScrollView(.horizontal, showsIndicators: false) {
            Grid(alignment: .leading, horizontalSpacing: 0, verticalSpacing: 0) {
                ForEach(Array(rows.enumerated()), id: \.offset) { r, row in
                    GridRow {
                        ForEach(0..<cols, id: \.self) { c in
                            Text(Inline.attributed(c < row.count ? row[c] : ""))
                                .font(r == 0 ? .footnote.weight(.semibold) : .footnote)
                                .textSelection(.enabled)
                                .fixedSize(horizontal: false, vertical: true)
                                .frame(minWidth: 70, maxWidth: 240, alignment: .leading)
                                .padding(.horizontal, 8).padding(.vertical, 6)
                                .frame(maxHeight: .infinity, alignment: .topLeading)
                                .background(r == 0 ? Color(.tertiarySystemFill) : Color.clear)
                                .overlay(Rectangle().stroke(Color.secondary.opacity(0.25), lineWidth: 0.5))
                        }
                    }
                }
            }
            .overlay(RoundedRectangle(cornerRadius: 6).stroke(Color.secondary.opacity(0.35), lineWidth: 1))
            .clipShape(RoundedRectangle(cornerRadius: 6))
        }
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

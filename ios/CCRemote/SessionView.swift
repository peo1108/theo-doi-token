import SwiftUI

struct SessionView: View {
    @Environment(AppModel.self) private var app
    @State private var model: SessionModel
    @State private var draft = ""
    @State private var confirmClose = false
    @FocusState private var inputFocused: Bool

    init(id: String) {
        _model = State(initialValue: SessionModel(id: id))
    }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 12) {
                    if model.events.isEmpty {
                        Text(model.connected ? "Chưa có tin nhắn" : "Đang kết nối…")
                            .foregroundStyle(.secondary)
                            .frame(maxWidth: .infinity)
                            .padding(.top, 40)
                    }
                    ForEach(model.visible) { ev in
                        EventRow(event: ev, model: model)
                            .id(ev.seq)
                    }
                    if model.status == "running" || model.status == "starting" {
                        HStack(spacing: 8) {
                            ProgressView().controlSize(.small)
                            Text(model.status == "starting" ? "Đang mở Claude…" : "Claude đang làm…")
                                .font(.footnote).foregroundStyle(.secondary)
                        }
                        .padding(.leading, 4)
                    }
                    Color.clear.frame(height: 1).id("bottom")
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 12)
            }
            .defaultScrollAnchor(.bottom)
            .scrollDismissesKeyboard(.interactively)
            .onChange(of: model.scrollTick) { _, _ in
                withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo("bottom", anchor: .bottom) }
            }
            .onChange(of: inputFocused) { _, f in
                if f { withAnimation { proxy.scrollTo("bottom", anchor: .bottom) } }
            }
        }
        .safeAreaInset(edge: .top, spacing: 0) { banner }
        .safeAreaInset(edge: .bottom, spacing: 0) { composer }
        .navigationTitle(model.summary?.title ?? app.title(for: model.id))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .principal) {
                VStack(spacing: 1) {
                    Text(model.summary?.title ?? app.title(for: model.id))
                        .font(.subheadline.weight(.semibold)).lineLimit(1)
                    HStack(spacing: 5) {
                        Circle().fill(model.connected ? Color.green : Color.gray).frame(width: 6, height: 6)
                        Text(subtitle).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                    }
                }
            }
            ToolbarItem(placement: .topBarTrailing) { menu }
        }
        .task {
            guard let api = app.api else { return }
            await model.run(api: api)
        }
        .confirmationDialog("Tắt tiến trình Claude của phiên này?", isPresented: $confirmClose, titleVisibility: .visible) {
            Button("Tắt", role: .destructive) { act { await model.close(api: $0) } }
        } message: {
            Text("Lịch sử vẫn giữ. Gửi tin nhắn mới sẽ mở lại phiên.")
        }
    }

    private var subtitle: String {
        var parts: [String] = [statusInfo(model.status).label]
        if let p = model.summary?.project, !p.isEmpty { parts.append(p) }
        if let r = model.summary?.rate, let h = r.fiveHour { parts.append("5h \(Int(h.rounded()))%") }
        return parts.joined(separator: " · ")
    }

    @ViewBuilder private var banner: some View {
        if let err = model.lastError {
            Label(err, systemImage: model.connected ? "exclamationmark.triangle" : "wifi.exclamationmark")
                .font(.footnote)
                .foregroundStyle(.white)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 14).padding(.vertical, 8)
                .background(Color.red.opacity(0.85))
        }
    }

    private var menu: some View {
        Menu {
            Picker("Quyền", selection: Binding(
                get: { model.summary?.mode ?? "default" },
                set: { m in act { await model.setMode(m, api: $0) } }
            )) {
                ForEach(PermissionMode.allCases) { m in Label(m.label, systemImage: m.icon).tag(m.rawValue) }
            }
            Picker("Model", selection: Binding(
                get: { model.summary?.model ?? "" },
                set: { m in act { await model.setModel(m, api: $0) } }
            )) {
                ForEach(modelChoices, id: \.id) { m in Text(m.label).tag(m.id) }
            }
            if let cwd = model.summary?.cwd {
                Section(cwd) {}
            }
            if model.summary?.live == true {
                Button("Tắt tiến trình", systemImage: "power", role: .destructive) { confirmClose = true }
            }
        } label: {
            Image(systemName: modeIcon)
        }
    }

    private var modeIcon: String {
        PermissionMode(rawValue: model.summary?.mode ?? "default")?.icon ?? "ellipsis.circle"
    }

    private var composer: some View {
        HStack(alignment: .bottom, spacing: 8) {
            TextField("Nhắn cho Claude…", text: $draft, axis: .vertical)
                .lineLimit(1...6)
                .focused($inputFocused)
                .padding(.horizontal, 14).padding(.vertical, 9)
                .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 20))
            if model.isBusy {
                Button {
                    act { await model.interrupt(api: $0) }
                } label: {
                    Image(systemName: "stop.circle.fill").font(.system(size: 32))
                }
                .tint(.red)
            }
            Button {
                let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !text.isEmpty else { return }
                draft = ""
                act { api in
                    if !(await model.send(text, api: api)) && draft.isEmpty { draft = text }
                }
            } label: {
                Image(systemName: "arrow.up.circle.fill").font(.system(size: 32))
            }
            .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || model.sending)
        }
        .padding(.horizontal, 12).padding(.vertical, 8)
        .background(.bar)
    }

    private func act(_ fn: @escaping @MainActor (APIClient) async -> Void) {
        guard let api = app.api else { return }
        Task { @MainActor in await fn(api) }
    }
}

// MARK: - Từng sự kiện

struct EventRow: View {
    let event: Event
    let model: SessionModel
    @Environment(AppModel.self) private var app

    var body: some View {
        switch event.kind {
        case "user":
            HStack {
                Spacer(minLength: 40)
                Text(event.text ?? "")
                    .textSelection(.enabled)
                    .padding(.horizontal, 13).padding(.vertical, 9)
                    .foregroundStyle(.white)
                    .background(Color.accentColor, in: RoundedRectangle(cornerRadius: 18))
            }
        case "assistant":
            MarkdownText(text: event.text ?? "")
        case "tool":
            ToolRow(event: event, result: event.toolId.flatMap { model.toolResults[$0] }, live: model.summary?.live == true)
        case "permission":
            PermissionCard(event: event, decision: event.requestId.flatMap { model.decisions[$0] }) { decision, answers in
                guard let api = app.api, let rid = event.requestId else { return }
                Task { await model.decide(rid, decision, answers: answers, api: api) }
            }
        case "result":
            ResultRow(event: event)
        case "limit":
            LimitCard(event: event, sessionId: model.id)
        case "error":
            Label(event.text ?? "Lỗi", systemImage: "xmark.octagon")
                .font(.footnote)
                .foregroundStyle(.red)
                .textSelection(.enabled)
        case "note":
            Text(event.text ?? "")
                .font(.caption)
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity)
        default:
            EmptyView()
        }
    }
}

struct ToolRow: View {
    let event: Event
    let result: Event?
    let live: Bool
    @State private var open = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button {
                withAnimation(.easeOut(duration: 0.15)) { open.toggle() }
            } label: {
                HStack(alignment: .top, spacing: 8) {
                    Image(systemName: icon)
                        .font(.caption)
                        .frame(width: 18)
                        .foregroundStyle(.secondary)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(event.name ?? "Tool").font(.caption.weight(.semibold))
                        Text(event.summary ?? "")
                            .font(.caption.monospaced())
                            .foregroundStyle(.secondary)
                            .lineLimit(open ? nil : 2)
                            .multilineTextAlignment(.leading)
                    }
                    Spacer(minLength: 4)
                    stateIcon
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if open {
                if let input = event.input, !input.isEmpty, input != "{}" {
                    CodeBlock(text: input)
                }
                if let r = result?.text, !r.isEmpty {
                    CodeBlock(text: r, tint: result?.error == true ? .red : nil)
                }
            }
        }
        .padding(10)
        .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 12))
    }

    @ViewBuilder private var stateIcon: some View {
        if let result {
            Image(systemName: result.error == true ? "xmark.circle.fill" : "checkmark.circle.fill")
                .foregroundStyle(result.error == true ? Color.red : Color.green)
                .font(.caption)
        } else if live {
            ProgressView().controlSize(.mini)
        }
    }

    private var icon: String {
        switch event.name ?? "" {
        case "Bash", "PowerShell": return "terminal"
        case "Read": return "doc.text"
        case "Write": return "square.and.pencil"
        case "Edit", "MultiEdit", "NotebookEdit": return "pencil"
        case "Grep", "Glob": return "magnifyingglass"
        case "WebFetch", "WebSearch": return "globe"
        case "Task", "Agent": return "person.2"
        case "TodoWrite": return "checklist"
        default: return "wrench.and.screwdriver"
        }
    }
}

struct PermissionCard: View {
    let event: Event
    let decision: String?
    let onDecide: (String, [String: String]?) -> Void
    @State private var showInput = false
    @State private var picks: [Int: Set<String>] = [:]

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Image(systemName: headerIcon).foregroundStyle(.orange)
                Text(title).font(.subheadline.weight(.semibold))
            }

            if let plan = event.plan {
                MarkdownText(text: plan)
                    .padding(10)
                    .background(Color(.systemBackground), in: RoundedRectangle(cornerRadius: 10))
            } else if let qs = event.questions, !qs.isEmpty {
                ForEach(Array(qs.enumerated()), id: \.offset) { i, q in
                    questionView(i, q)
                }
            } else {
                Text(event.summary ?? "")
                    .font(.callout.monospaced())
                    .lineLimit(showInput ? nil : 8)
                    .textSelection(.enabled)
                if let input = event.input, !input.isEmpty {
                    DisclosureGroup("Chi tiết", isExpanded: $showInput) {
                        CodeBlock(text: input)
                    }
                    .font(.caption)
                }
            }

            if let decision {
                Label(decidedText(decision), systemImage: decision == "deny" || decision == "cancel" ? "xmark.circle" : "checkmark.circle")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            } else {
                buttons
            }
        }
        .padding(12)
        .background(Color.orange.opacity(decision == nil ? 0.13 : 0.06), in: RoundedRectangle(cornerRadius: 14))
        .overlay(
            RoundedRectangle(cornerRadius: 14).strokeBorder(Color.orange.opacity(decision == nil ? 0.5 : 0.15))
        )
    }

    private var isQuestion: Bool { event.tool == "AskUserQuestion" && !(event.questions ?? []).isEmpty }
    private var isPlan: Bool { event.tool == "ExitPlanMode" }

    private var title: String {
        if isQuestion { return "Claude hỏi bạn" }
        if isPlan { return "Kế hoạch chờ duyệt" }
        return "Cho phép \(event.tool ?? "công cụ")?"
    }

    private var headerIcon: String {
        isQuestion ? "questionmark.bubble.fill" : isPlan ? "list.bullet.clipboard.fill" : "hand.raised.fill"
    }

    private func decidedText(_ d: String) -> String {
        switch d {
        case "allow": return isQuestion ? "Đã trả lời" : isPlan ? "Đã duyệt kế hoạch" : "Đã cho phép"
        case "always": return "Đã cho phép (cả phiên)"
        case "deny": return isQuestion ? "Đã bỏ qua" : "Đã từ chối"
        default: return "Đã huỷ"
        }
    }

    @ViewBuilder private func questionView(_ i: Int, _ q: Question) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(q.question).font(.callout.weight(.medium))
            ForEach(q.options, id: \.label) { o in
                let on = picks[i]?.contains(o.label) == true
                Button {
                    var s = picks[i] ?? []
                    if q.multiSelect {
                        if on { s.remove(o.label) } else { s.insert(o.label) }
                    } else {
                        s = [o.label]
                    }
                    picks[i] = s
                } label: {
                    HStack(alignment: .top, spacing: 8) {
                        Image(systemName: on ? (q.multiSelect ? "checkmark.square.fill" : "largecircle.fill.circle") : (q.multiSelect ? "square" : "circle"))
                            .foregroundStyle(on ? Color.accentColor : Color.secondary)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(o.label).font(.callout)
                            if !o.description.isEmpty {
                                Text(o.description).font(.caption).foregroundStyle(.secondary)
                            }
                        }
                        Spacer(minLength: 0)
                    }
                    .padding(8)
                    .background(Color(.systemBackground), in: RoundedRectangle(cornerRadius: 8))
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(decision != nil)
            }
        }
    }

    @ViewBuilder private var buttons: some View {
        if isQuestion {
            let qs = event.questions ?? []
            let ready = qs.indices.allSatisfy { !(picks[$0] ?? []).isEmpty }
            HStack {
                Button("Gửi trả lời") {
                    var answers: [String: String] = [:]
                    for (i, q) in qs.enumerated() {
                        let chosen = q.options.map(\.label).filter { (picks[i] ?? []).contains($0) }
                        answers[q.question] = chosen.joined(separator: ", ")
                    }
                    onDecide("allow", answers)
                }
                .buttonStyle(.borderedProminent)
                .disabled(!ready)
                Button("Bỏ qua", role: .destructive) { onDecide("deny", nil) }
                    .buttonStyle(.bordered)
            }
        } else {
            HStack(spacing: 8) {
                Button(isPlan ? "Duyệt" : "Cho phép") { onDecide("allow", nil) }
                    .buttonStyle(.borderedProminent)
                if event.canAlways == true && !isPlan {
                    Button("Luôn cho phép") { onDecide("always", nil) }
                        .buttonStyle(.bordered)
                }
                Button(isPlan ? "Chưa" : "Từ chối", role: .destructive) { onDecide("deny", nil) }
                    .buttonStyle(.bordered)
            }
            .controlSize(.regular)
        }
    }
}

struct ResultRow: View {
    let event: Event

    var body: some View {
        HStack(spacing: 6) {
            if event.aborted == true {
                Image(systemName: "stop.circle")
                Text("Đã dừng")
            } else if event.ok == true {
                Image(systemName: "checkmark.seal")
                Text(detail)
            } else {
                Image(systemName: "exclamationmark.triangle").foregroundStyle(.red)
                Text(event.text?.isEmpty == false ? event.text! : "Lỗi").foregroundStyle(.red)
            }
        }
        .font(.caption)
        .foregroundStyle(.secondary)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 2)
    }

    private var detail: String {
        var parts = ["Xong"]
        if let ms = event.ms, ms > 0 { parts.append(ms >= 60000 ? "\(Int(ms / 60000)) phút" : "\(Int((ms / 1000).rounded())) giây") }
        if let c = event.cost, c > 0 { parts.append(String(format: "$%.2f", c)) }
        if let t = event.t { parts.append(clockTime(t)) }
        return parts.joined(separator: " · ")
    }
}

struct LimitCard: View {
    let event: Event
    let sessionId: String
    @Environment(AppModel.self) private var app
    @State private var busy = false
    @State private var message: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("Hết hạn mức", systemImage: "gauge.with.dots.needle.100percent")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.red)
            Text(event.text ?? "").font(.footnote).foregroundStyle(.secondary)
            if let s = event.suggest {
                Button {
                    Task {
                        busy = true
                        do {
                            try await app.switchAccount(s.id, sessionId: sessionId, text: "tiếp tục")
                            message = "Đã đổi sang \(s.name) và gửi “tiếp tục”"
                        } catch {
                            message = (error as? APIError)?.message ?? error.localizedDescription
                        }
                        busy = false
                    }
                } label: {
                    HStack {
                        if busy { ProgressView().controlSize(.small) }
                        Text("Đổi sang \(s.name) & tiếp tục")
                    }
                }
                .buttonStyle(.borderedProminent)
                .disabled(busy || message != nil)
            } else {
                Text("Không có tài khoản khác còn hạn mức.").font(.footnote)
            }
            if let message { Text(message).font(.caption).foregroundStyle(.secondary) }
        }
        .padding(12)
        .background(Color.red.opacity(0.08), in: RoundedRectangle(cornerRadius: 14))
    }
}

// MARK: - Markdown đơn giản: khối ``` thành code, tiêu đề # thành chữ đậm, phần còn lại markdown inline.

struct MarkdownText: View {
    let text: String

    private enum Block { case text(String), code(String) }

    private var blocks: [Block] {
        var out: [Block] = []
        var buf: [String] = []
        var inCode = false
        for line in text.components(separatedBy: "\n") {
            if line.trimmingCharacters(in: .whitespaces).hasPrefix("```") {
                let chunk = buf.joined(separator: "\n")
                if inCode { out.append(.code(chunk)) } else if !chunk.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { out.append(.text(chunk)) }
                buf = []
                inCode.toggle()
                continue
            }
            if !inCode, let h = line.range(of: "^#{1,6} ", options: .regularExpression) {
                buf.append("**" + line[h.upperBound...] + "**")
            } else {
                buf.append(line)
            }
        }
        let rest = buf.joined(separator: "\n")
        if inCode { out.append(.code(rest)) } else if !rest.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { out.append(.text(rest)) }
        return out
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, b in
                switch b {
                case .text(let s):
                    Text(Self.attributed(s))
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                case .code(let s):
                    CodeBlock(text: s)
                }
            }
        }
    }

    static func attributed(_ s: String) -> AttributedString {
        let opts = AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        return (try? AttributedString(markdown: s, options: opts)) ?? AttributedString(s)
    }
}

struct CodeBlock: View {
    let text: String
    var tint: Color? = nil

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            Text(text)
                .font(.caption.monospaced())
                .foregroundStyle(tint ?? Color.primary)
                .textSelection(.enabled)
                .padding(9)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(.tertiarySystemBackground), in: RoundedRectangle(cornerRadius: 8))
    }
}

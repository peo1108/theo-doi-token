import SwiftUI

struct SessionView: View {
    @Environment(AppModel.self) private var app
    @State private var model: SessionModel
    @State private var draft = ""
    @State private var showSettings = false
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
                        // như VS Code: "Thinking… · N tokens" rồi dòng chữ chạy "Vibing…"
                        if let tk = model.thinkingTokens {
                            TimelineRow(color: Color.secondary.opacity(0.55)) {
                                Text("Thinking… · \(tk) tokens").font(.callout).foregroundStyle(.secondary)
                            }
                        }
                        SpinnerLine(verb: model.status == "starting" ? "Đang mở Claude" : model.spinnerVerb)
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
            ToolbarItem(placement: .topBarTrailing) {
                Button { showSettings = true } label: { Image(systemName: "slider.horizontal.3") }
            }
        }
        .task {
            guard let api = app.api else { return }
            await model.run(api: api)
        }
        .task { await app.loadCaps() }
        .onAppear { Notifier.shared.activeSessionId = model.id }      // đang xem phiên này thì không báo
        .onDisappear { if Notifier.shared.activeSessionId == model.id { Notifier.shared.activeSessionId = nil } }
        .onAppear {
            // tham số khởi chạy cho kiểm tra trên Simulator: -openSettings YES, -draft "/co"
            if UserDefaults.standard.bool(forKey: "openSettings") { showSettings = true }
            if let d = UserDefaults.standard.string(forKey: "draft"), draft.isEmpty { draft = d }
        }
        .sheet(isPresented: $showSettings) { SessionSettingsView(model: model) }
    }

    private var subtitle: String {
        var parts: [String] = [statusInfo(model.status).label]
        if let st = model.summary?.settings {
            parts.append(st.effort != nil ? "\(st.modelLabel) \(effortLabel(st.effort))" : st.modelLabel)
        } else if let p = model.summary?.project, !p.isEmpty {
            parts.append(p)
        }
        if let r = model.summary?.rate, let h = r.fiveHour { parts.append("5h \(Int(h.rounded()))%") }
        return parts.joined(separator: " · ")
    }

    @ViewBuilder private var banner: some View {
        VStack(spacing: 0) {
            if let err = model.lastError {
                Label(err, systemImage: model.connected ? "exclamationmark.triangle" : "wifi.exclamationmark")
                    .font(.footnote)
                    .foregroundStyle(.white)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 14).padding(.vertical, 8)
                    .background(Color.red.opacity(0.85))
            }
            externalBar
        }
    }

    /// Phiên đang mở trên máy (VS Code / terminal): điều khiển qua hook.
    @ViewBuilder private var externalBar: some View {
        if let s = model.summary, s.external == true {
            let src = s.source ?? "Máy tính"
            let attached = s.attached == true
            let ready = s.ready == true
            let running = s.status == "running" || s.status == "waiting"
            HStack(spacing: 10) {
                Image(systemName: src == "Terminal" ? "terminal" : "laptopcomputer")
                    .foregroundStyle(ready || running ? Color.green : Color.secondary)
                VStack(alignment: .leading, spacing: 1) {
                    Text(ready ? "\(src) · sẵn sàng nhận lệnh"
                         : running ? "\(src) · Claude đang làm…"
                         : "\(src) · chưa sẵn sàng")
                        .font(.footnote.weight(.semibold))
                    Text(ready ? "Nhắn là Claude trên máy làm tiếp ngay"
                         : running ? "Tin gửi lúc này sẽ vào ngay khi Claude xong lượt"
                         : "Hook đã bị dừng (bấm Stop trong VS Code?) — gõ một tin bất kỳ trong VS Code để bật lại")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                    Text(attached ? "Duyệt quyền: trên điện thoại" : s.pcAway == true ? "Duyệt quyền: trên điện thoại (máy đang để yên)" : "Duyệt quyền: trên máy tính (đang có người dùng máy)")
                        .font(.caption2)
                        .foregroundStyle(attached || s.pcAway == true ? Color.accentColor : Color.secondary)
                }
                Spacer(minLength: 4)
                Menu {
                    Button(attached ? "Trả duyệt quyền về máy tính" : "Luôn duyệt quyền trên điện thoại") {
                        act { await model.attach(!attached, api: $0) }
                    }
                } label: {
                    Image(systemName: "ellipsis.circle").font(.title3)
                }
            }
            .padding(.horizontal, 14).padding(.vertical, 8)
            .background(.bar)
        }
    }

    /// Đang gõ "/lệnh" (chưa có dấu cách) -> phần sau dấu /
    private var commandQuery: String? {
        guard draft.hasPrefix("/"), !draft.contains(" "), !draft.contains("\n") else { return nil }
        return String(draft.dropFirst())
    }

    private var composer: some View {
        VStack(spacing: 0) {
            if let q = commandQuery, let cmds = app.caps?.commands {
                CommandSuggestions(commands: cmds, query: q) { c in
                    draft = "/" + c.name + " "
                    inputFocused = true
                }
                Divider()
            }
            composerRow
        }
    }

    private var composerRow: some View {
        HStack(alignment: .bottom, spacing: 8) {
            Button {
                if !draft.hasPrefix("/") { draft = "/" + draft }
                inputFocused = true
            } label: {
                Image(systemName: "slash.circle").font(.system(size: 28))
            }
            .tint(.secondary)
            TextField("Nhắn cho Claude…  (/ để xem lệnh)", text: $draft, axis: .vertical)
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
            // giống ô lời nhắn trong VS Code: khung viền, cả chiều ngang
            VStack(alignment: .leading, spacing: 3) {
                if event.via == "phone" {
                    Label("từ điện thoại", systemImage: "iphone").font(.caption2).foregroundStyle(.secondary)
                }
                Text(event.text ?? "")
                    .font(.callout)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 12).padding(.vertical, 9)
                    .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 10))
                    .overlay(RoundedRectangle(cornerRadius: 10).stroke(Color.secondary.opacity(0.3), lineWidth: 1))
            }
            .padding(.top, 8)
        case "assistant":
            TimelineRow(color: Color.secondary.opacity(0.55)) { MarkdownText(text: event.text ?? "") }
        case "tool":
            let result = event.toolId.flatMap { model.toolResults[$0] }
            TimelineRow(color: toolColor(result)) {
                ToolRow(event: event, result: result, live: model.summary?.live == true)
            }
        case "permission":
            TimelineRow(color: .orange) {
                PermissionCard(event: event, decision: event.requestId.flatMap { model.decisions[$0] }) { decision, answers in
                    guard let api = app.api, let rid = event.requestId else { return }
                    Task { await model.decide(rid, decision, answers: answers, api: api) }
                }
            }
        case "result":
            ResultRow(event: event).padding(.leading, 20)
        case "limit":
            LimitCard(event: event, sessionId: model.id)
        case "error":
            TimelineRow(color: .red) {
                Text(event.text ?? "Lỗi").font(.footnote).foregroundStyle(.red).textSelection(.enabled)
            }
        case "output":
            TimelineRow(color: Color.secondary.opacity(0.55)) {
                InOutBlock(input: nil, output: event.text, outputError: event.error == true, outputLines: nil)
            }
        case "thought":
            TimelineRow(color: Color.secondary.opacity(0.55)) {
                Text("Thought for \(Int(event.seconds ?? 1))s").font(.callout).foregroundStyle(.secondary)
            }
        case "note":
            Text(event.text ?? "")
                .font(.caption)
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity)
        default:
            EmptyView()
        }
    }

    private func toolColor(_ r: Event?) -> Color {
        guard let r else { return model.summary?.live == true ? .blue : .gray }
        return r.error == true ? .red : .green
    }
}

/// Một lần gọi tool, giống VS Code: "Bash  mô tả" + khung IN/OUT, "Edit  đường dẫn" + diff, bấm để xem đủ.
struct ToolRow: View {
    let event: Event
    let result: Event?
    let live: Bool
    @State private var open = false

    private var name: String { event.name ?? "Tool" }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button {
                withAnimation(.easeOut(duration: 0.15)) { open.toggle() }
            } label: {
                HStack(alignment: .firstTextBaseline, spacing: 7) {
                    Text(name).font(.callout.weight(.semibold)).foregroundStyle(.primary)
                    Text(headline)
                        .font(event.path != nil ? .footnote.monospaced() : .footnote)
                        .foregroundStyle(event.path != nil ? Color.blue : Color.secondary)
                        .lineLimit(open ? 4 : 1)
                        .truncationMode(.middle)
                        .multilineTextAlignment(.leading)
                    Spacer(minLength: 0)
                    if result == nil && live { ProgressView().controlSize(.mini) }
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if let sub = subline {
                Text(sub).font(.caption).foregroundStyle(.secondary)
            }
            detail
        }
    }

    private var headline: String {
        if let p = event.path { return p }
        if let t = event.title, !t.isEmpty { return t }
        return event.summary ?? ""
    }

    /// dòng phụ dưới tiêu đề (vd. "Thêm 3 dòng, bớt 1 dòng" cho Edit, mô tả khi đã có đường dẫn)
    private var subline: String? {
        if let o = event.oldText ?? (event.newText != nil ? "" : nil), let n = event.newText {
            let a = n.isEmpty ? 0 : n.components(separatedBy: "\n").count
            let d = o.isEmpty ? 0 : o.components(separatedBy: "\n").count
            var parts: [String] = []
            if a > 0 { parts.append("Thêm \(a) dòng") }
            if d > 0 { parts.append("bớt \(d) dòng") }
            if let t = event.title { parts.append(t) }
            return parts.isEmpty ? nil : parts.joined(separator: ", ")
        }
        if event.path != nil, let t = event.title, !t.isEmpty { return t }
        return nil
    }

    private var outText: String? {
        guard let r = result?.text, !r.isEmpty else { return nil }
        return r
    }

    @ViewBuilder private var detail: some View {
        switch name {
        case "Edit", "MultiEdit":
            if event.oldText != nil || event.newText != nil {
                DiffBlock(old: event.oldText ?? "", new: event.newText ?? "", maxLines: open ? 200 : 10)
            }
            if result?.error == true, let o = outText { errorText(o) }
        case "Bash", "PowerShell":
            InOutBlock(input: event.code ?? event.summary, output: outText, outputError: result?.error == true, outputLines: open ? nil : 6)
        case "Write":
            if let c = event.code { CodeBlock(text: c, maxLines: open ? nil : 8) }
            if result?.error == true, let o = outText { errorText(o) }
        case "TodoWrite":
            if let c = event.code { CodeBlock(text: c) }
        default:
            if let c = event.code, open { CodeBlock(text: c, maxLines: nil) }
            if result?.error == true, let o = outText {
                errorText(o)
            } else if open, let o = outText {
                InOutBlock(input: nil, output: o, outputLines: nil)
            }
        }
    }

    private func errorText(_ s: String) -> some View {
        Text(s).font(.caption.monospaced()).foregroundStyle(.red).lineLimit(open ? nil : 4).textSelection(.enabled)
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

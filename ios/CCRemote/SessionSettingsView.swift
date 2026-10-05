import SwiftUI

/// Cài đặt của một phiên, giống menu Model trong VS Code: model, effort, thinking, fast mode,
/// tự đổi model khi bị flag, quyền, output style. Đổi xong áp dụng ngay (kể cả khi Claude đang chạy).
struct SessionSettingsView: View {
    let model: SessionModel
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    @State private var confirmClose = false

    private var s: SessionSettings? { model.summary?.settings }
    private var models: [ModelInfo] { app.caps?.models ?? [] }
    private var current: ModelInfo? { models.first { $0.value == s?.modelValue } }
    private var efforts: [String] {
        if let current { return current.efforts }
        return app.caps?.efforts ?? ["low", "medium", "high", "xhigh", "max"]
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Model") {
                    Picker(selection: binding(\.modelValue, "") { ["model": $0] }) {
                        ForEach(models) { m in
                            VStack(alignment: .leading, spacing: 2) {
                                Text(m.label)
                                if !m.description.isEmpty {
                                    Text(m.description).font(.caption).foregroundStyle(.secondary)
                                }
                            }
                            .tag(m.value)
                        }
                        if models.isEmpty, let v = s?.modelValue {
                            Text(s?.modelLabel ?? v).tag(v)
                        }
                    } label: {
                        Text("Đổi model")
                    }
                    .pickerStyle(.navigationLink)

                    if !efforts.isEmpty {
                        VStack(alignment: .leading, spacing: 8) {
                            HStack {
                                Text("Effort")
                                Text("(\(effortLabel(s?.effort)))").foregroundStyle(.secondary)
                            }
                            Picker("Effort", selection: binding(\.effort, "") { ["effort": $0] }) {
                                ForEach(efforts, id: \.self) { e in Text(effortLabel(e)).tag(e) }
                            }
                            .pickerStyle(.segmented)
                            .labelsHidden()
                        }
                        .padding(.vertical, 2)
                    }

                    Toggle("Thinking", isOn: boolBinding(\.thinking) { ["thinking": $0] })
                        .disabled(current != nil && current?.thinking == false)
                    if current?.fast == true {
                        Toggle("Fast mode", isOn: boolBinding(\.fast) { ["fast": $0] })
                    }
                    Toggle(isOn: boolBinding(\.flagSwitch) { ["flagSwitch": $0] }) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Đổi model khi tin nhắn bị flag")
                            Text("Tắt thì phiên sẽ dừng lại thay vì đổi model").font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }

                Section("Quyền") {
                    Picker("Chế độ", selection: Binding(
                        get: { model.summary?.mode ?? "default" },
                        set: { v in send(["mode": v]) }
                    )) {
                        ForEach(PermissionMode.allCases) { m in Label(m.label, systemImage: m.icon).tag(m.rawValue) }
                    }
                }

                if let styles = app.caps?.outputStyles, styles.count > 1 {
                    Section("Kiểu trả lời") {
                        Picker("Output style", selection: binding(\.outputStyle, "default") { ["outputStyle": $0] }) {
                            ForEach(styles, id: \.self) { Text($0 == "default" ? "Mặc định" : $0).tag($0) }
                        }
                    }
                }

                Section("Phiên") {
                    if let acc = model.summary?.account {
                        LabeledContent("Tài khoản", value: acc)
                    }
                    if let cwd = model.summary?.cwd {
                        LabeledContent("Thư mục") {
                            Text(cwd).font(.footnote.monospaced()).multilineTextAlignment(.trailing).textSelection(.enabled)
                        }
                    }
                    if let c = model.summary?.cost, c > 0 {
                        LabeledContent("Chi phí (quy đổi)", value: String(format: "$%.2f", c))
                    }
                    if let r = model.summary?.rate {
                        if let h = r.fiveHour { LabeledContent("Hạn mức 5 giờ", value: "\(Int(h.rounded()))%") }
                        if let d = r.sevenDay { LabeledContent("Hạn mức 7 ngày", value: "\(Int(d.rounded()))%") }
                    }
                    if model.summary?.live == true {
                        Button("Tắt tiến trình Claude", role: .destructive) { confirmClose = true }
                    }
                }
            }
            .navigationTitle("Cài đặt phiên")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Xong") { dismiss() } }
            }
            .task { await app.loadCaps() }
            .confirmationDialog("Tắt tiến trình Claude của phiên này?", isPresented: $confirmClose, titleVisibility: .visible) {
                Button("Tắt", role: .destructive) {
                    guard let api = app.api else { return }
                    Task { await model.close(api: api) }
                }
            } message: {
                Text("Lịch sử vẫn giữ. Gửi tin nhắn mới sẽ mở lại phiên với cài đặt này.")
            }
        }
    }

    private func send(_ body: [String: Any]) {
        guard let api = app.api else { return }
        Task { await model.applySettings(body, api: api) }
    }

    private func binding(_ key: KeyPath<SessionSettings, String?>, _ fallback: String, _ body: @escaping (String) -> [String: Any]) -> Binding<String> {
        Binding(get: { s?[keyPath: key] ?? fallback }, set: { send(body($0)) })
    }

    private func binding(_ key: KeyPath<SessionSettings, String>, _ fallback: String, _ body: @escaping (String) -> [String: Any]) -> Binding<String> {
        Binding(get: { s?[keyPath: key] ?? fallback }, set: { send(body($0)) })
    }

    private func boolBinding(_ key: KeyPath<SessionSettings, Bool>, _ body: @escaping (Bool) -> [String: Any]) -> Binding<Bool> {
        Binding(get: { s?[keyPath: key] ?? false }, set: { send(body($0)) })
    }
}

/// Gợi ý lệnh / khi lời nhắn bắt đầu bằng "/".
struct CommandSuggestions: View {
    let commands: [CommandInfo]
    let query: String
    let onPick: (CommandInfo) -> Void

    private var matches: [CommandInfo] {
        let q = query.lowercased()
        let starts = commands.filter { $0.name.lowercased().hasPrefix(q) }
        let contains = commands.filter { !$0.name.lowercased().hasPrefix(q) && $0.name.lowercased().contains(q) }
        return Array((starts + contains).prefix(8))
    }

    var body: some View {
        if matches.count > 4 {
            ScrollView { list }
                .frame(height: 260)
                .background(.bar)
        } else if !matches.isEmpty {
            list.background(.bar)
        }
    }

    private var list: some View {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(matches) { c in
                        Button { onPick(c) } label: {
                            VStack(alignment: .leading, spacing: 2) {
                                HStack(spacing: 6) {
                                    Text("/" + c.name).font(.callout.monospaced().weight(.semibold))
                                    if !c.hint.isEmpty {
                                        Text(c.hint).font(.caption.monospaced()).foregroundStyle(.secondary).lineLimit(1)
                                    }
                                }
                                if !c.description.isEmpty {
                                    Text(c.description).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                                }
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal, 14).padding(.vertical, 8)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        Divider().padding(.leading, 14)
                    }
                }
    }
}

import SwiftUI

struct NewSessionView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    @State private var projects: [Project] = []
    @State private var cwd: String
    private let presetCwd: String?

    /// presetCwd: mở từ trong một dự án -> chọn sẵn thư mục đó
    init(presetCwd: String? = nil) {
        self.presetCwd = presetCwd
        _cwd = State(initialValue: presetCwd ?? UserDefaults.standard.string(forKey: "lastCwd") ?? "")
    }
    @State private var prompt = ""
    @State private var mode = PermissionMode.default
    @State private var model = UserDefaults.standard.string(forKey: "lastModel") ?? ""
    @State private var effort = ""
    @State private var thinking = true
    @State private var touched = false   // đã chỉnh effort/thinking -> gửi kèm, không thì theo settings của máy
    @State private var busy = false
    @State private var error: String?
    @FocusState private var promptFocused: Bool

    var body: some View {
        NavigationStack {
            Form {
                Section("Thư mục dự án") {
                    TextField("C:\\Users\\...\\du-an", text: $cwd)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .font(.callout.monospaced())
                    if !projects.isEmpty {
                        ScrollView(.horizontal, showsIndicators: false) {
                            HStack(spacing: 8) {
                                ForEach(projects) { p in
                                    Button {
                                        cwd = p.cwd
                                    } label: {
                                        Text(p.name)
                                            .font(.callout)
                                            .padding(.horizontal, 10).padding(.vertical, 6)
                                            .background(
                                                (p.cwd == cwd ? Color.accentColor.opacity(0.2) : Color(.tertiarySystemFill)),
                                                in: Capsule()
                                            )
                                    }
                                    .buttonStyle(.plain)
                                }
                            }
                            .padding(.vertical, 2)
                        }
                    }
                }

                Section("Lời nhắn") {
                    TextField("Bạn muốn Claude làm gì?", text: $prompt, axis: .vertical)
                        .lineLimit(4...12)
                        .focused($promptFocused)
                }

                Section("Tuỳ chọn") {
                    Picker("Quyền", selection: $mode) {
                        ForEach(PermissionMode.allCases) { m in
                            Label(m.label, systemImage: m.icon).tag(m)
                        }
                    }
                    Picker("Model", selection: $model) {
                        if let caps = app.caps, !caps.models.isEmpty {
                            Text("Theo máy (\(caps.defaults.modelLabel))").tag("")
                            ForEach(caps.models.filter { $0.value != "default" }) { m in Text(m.label).tag(m.value) }
                        } else {
                            ForEach(modelChoices, id: \.id) { m in Text(m.label).tag(m.id) }
                        }
                    }
                    if !efforts.isEmpty {
                        Picker("Effort", selection: Binding(get: { effort }, set: { effort = $0; touched = true })) {
                            ForEach(efforts, id: \.self) { Text(effortLabel($0)).tag($0) }
                        }
                        .pickerStyle(.segmented)
                    }
                    Toggle("Thinking", isOn: Binding(get: { thinking }, set: { thinking = $0; touched = true }))
                }

                if let error {
                    Section { Label(error, systemImage: "exclamationmark.triangle").foregroundStyle(.red) }
                }
            }
            .navigationTitle("Phiên mới")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Huỷ") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    if busy {
                        ProgressView()
                    } else {
                        Button("Bắt đầu") { Task { await start() } }
                            .disabled(cwd.trimmingCharacters(in: .whitespaces).isEmpty || prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    }
                }
            }
            .task {
                await app.loadCaps()
                if let d = app.caps?.defaults {
                    effort = d.effort ?? ""
                    thinking = d.thinking
                }
                do {
                    projects = try await app.projects()
                    if cwd.isEmpty, let first = projects.first { cwd = first.cwd }
                } catch {
                    self.error = (error as? APIError)?.message ?? error.localizedDescription
                }
                promptFocused = true
            }
        }
    }

    /// Mức effort của model đang chọn (model rỗng = model mặc định của máy).
    private var efforts: [String] {
        guard let caps = app.caps else { return [] }
        let want = model.isEmpty ? (caps.defaults.modelValue ?? "default") : model
        return caps.models.first { $0.value == want }?.efforts ?? caps.efforts
    }

    private func start() async {
        busy = true
        error = nil
        do {
            var options: [String: Any] = [:]
            if touched {
                if !effort.isEmpty { options["effort"] = effort }
                options["thinking"] = thinking
            }
            let s = try await app.createSession(cwd: cwd.trimmingCharacters(in: .whitespaces), text: prompt, mode: mode.rawValue, model: model, options: options)
            UserDefaults.standard.set(cwd, forKey: "lastCwd")
            UserDefaults.standard.set(model, forKey: "lastModel")
            dismiss()
            app.path.append(Route.session(s.id))
        } catch let e {
            self.error = (e as? APIError)?.message ?? e.localizedDescription
        }
        busy = false
    }
}

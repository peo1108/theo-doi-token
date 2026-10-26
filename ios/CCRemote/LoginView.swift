import SwiftUI

/// Đăng nhập hub trên VPS bằng tài khoản admin tạo trên trang web của hub. Đăng nhập một lần dùng mãi — chỉ mất khi tự đăng xuất.
struct LoginView: View {
    @Environment(AppModel.self) private var app
    @State private var url = UserDefaults.standard.string(forKey: "hubURL") ?? AppModel.defaultHub
    @State private var username = ""
    @State private var password = ""
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    VStack(alignment: .leading, spacing: 10) {
                        Image(systemName: "terminal.fill")
                            .font(.system(size: 38))
                            .foregroundStyle(.tint)
                        Text("Điều khiển Claude Code trên máy tính từ iPhone")
                            .font(.headline)
                        Text("Đăng nhập tài khoản hub (admin tạo cho bạn trên trang web của hub). Máy tính đăng nhập cùng tài khoản (dashboard → thẻ **Điện thoại** → **Kết nối hub**) sẽ hiện ra ở đây.")
                            .font(.callout)
                            .foregroundStyle(.secondary)
                    }
                    .padding(.vertical, 4)
                }

                Section("Tài khoản") {
                    TextField("Tên đăng nhập", text: $username)
                        .textContentType(.username)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    SecureField("Mật khẩu", text: $password)
                        .textContentType(.password)
                }

                Section("Hub") {
                    TextField(AppModel.defaultHub, text: $url)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .font(.callout)
                }

                if let error {
                    Section {
                        Label(error, systemImage: "exclamationmark.triangle")
                            .foregroundStyle(.red)
                    }
                }

                Section {
                    Button {
                        Task { await go() }
                    } label: {
                        HStack {
                            Spacer()
                            if busy { ProgressView() } else { Text("Đăng nhập").bold() }
                            Spacer()
                        }
                    }
                    .disabled(busy || username.trimmingCharacters(in: .whitespaces).count < 3 || password.isEmpty)
                }
            }
            .navigationTitle("CC Remote")
        }
    }

    private func go() async {
        busy = true
        error = nil
        do {
            try await app.login(url: url, username: username, password: password)
            password = ""
        } catch let e {
            self.error = (e as? APIError)?.message ?? e.localizedDescription
        }
        busy = false
    }
}

/// Chọn máy tính khi tài khoản có nhiều máy (hiện trên thanh công cụ màn hình chính).
struct MachinePicker: View {
    @Environment(AppModel.self) private var app
    @State private var renaming = false
    @State private var newName = ""

    var body: some View {
        Menu {
            ForEach(app.machines) { m in
                Button {
                    app.selectMachine(m.id)
                } label: {
                    Label("\(m.name)\(m.online ? "" : " · tắt")", systemImage: m.id == app.machineId ? "checkmark" : (m.online ? "desktopcomputer" : "moon.zzz"))
                }
            }
            if app.machines.isEmpty {
                Text("Chưa có máy nào — ghép máy trên dashboard của máy tính")
            }
            if let m = app.currentMachine {
                Divider()
                Button {
                    newName = m.name
                    renaming = true
                } label: {
                    Label("Đổi tên máy này…", systemImage: "pencil")
                }
            }
        } label: {
            HStack(spacing: 4) {
                Circle().fill(app.currentMachine?.online == true ? Color.green : Color.secondary).frame(width: 7, height: 7)
                Text(app.currentMachine?.name ?? "Chọn máy").font(.subheadline).lineLimit(1)
                Image(systemName: "chevron.down").font(.caption2)
            }
        }
        .alert("Đổi tên máy", isPresented: $renaming) {
            TextField("Tên máy", text: $newName)
            Button("Lưu") { Task { await app.renameMachine(newName) } }
            Button("Huỷ", role: .cancel) {}
        } message: {
            Text("Tên hiện trên app và trang web của hub.")
        }
    }
}

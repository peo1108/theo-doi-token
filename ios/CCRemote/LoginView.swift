import SwiftUI

/// Đăng nhập hub trên VPS (hoặc tạo tài khoản bằng mã mời). Đăng nhập một lần dùng mãi — chỉ mất khi tự đăng xuất.
struct LoginView: View {
    @Environment(AppModel.self) private var app
    @State private var url = UserDefaults.standard.string(forKey: "hubURL") ?? AppModel.defaultHub
    @State private var invite = ""
    @State private var username = ""
    @State private var password = ""
    @State private var hasInvite = false
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
                        Text(hasInvite
                             ? "Nhập mã mời admin gửi cho bạn, rồi tự đặt tên đăng nhập và mật khẩu."
                             : "Đăng nhập tài khoản hub. Máy tính đã ghép với cùng tài khoản (dashboard → thẻ **Điện thoại** → **Hub**) sẽ hiện ra ở đây — không cần Tailscale.")
                            .font(.callout)
                            .foregroundStyle(.secondary)
                    }
                    .padding(.vertical, 4)
                }

                Section {
                    Picker("", selection: $hasInvite) {
                        Text("Đăng nhập").tag(false)
                        Text("Có mã mời").tag(true)
                    }
                    .pickerStyle(.segmented)
                }

                Section("Tài khoản") {
                    if hasInvite {
                        TextField("Mã mời (ABCD-EFGH)", text: $invite)
                            .textInputAutocapitalization(.characters)
                            .autocorrectionDisabled()
                            .font(.body.monospaced())
                    }
                    TextField("Tên đăng nhập", text: $username)
                        .textContentType(.username)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    SecureField(hasInvite ? "Mật khẩu (tối thiểu 8 ký tự)" : "Mật khẩu", text: $password)
                        .textContentType(hasInvite ? .newPassword : .password)
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
                            if busy { ProgressView() } else { Text(hasInvite ? "Tạo tài khoản" : "Đăng nhập").bold() }
                            Spacer()
                        }
                    }
                    .disabled(busy || username.trimmingCharacters(in: .whitespaces).count < 3 || password.isEmpty || (hasInvite && invite.isEmpty))
                }

                Section {
                    Button("Dùng Tailscale (cách cũ, mã ghép 6 số)") { app.setMode("tailscale") }
                        .font(.footnote)
                }
            }
            .navigationTitle("CC Remote")
        }
    }

    private func go() async {
        busy = true
        error = nil
        do {
            try await app.login(url: url, username: username, password: password, invite: hasInvite ? invite : nil)
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
        } label: {
            HStack(spacing: 4) {
                Circle().fill(app.currentMachine?.online == true ? Color.green : Color.secondary).frame(width: 7, height: 7)
                Text(app.currentMachine?.name ?? "Chọn máy").font(.subheadline).lineLimit(1)
                Image(systemName: "chevron.down").font(.caption2)
            }
        }
    }
}

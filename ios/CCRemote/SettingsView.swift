import SwiftUI
import UserNotifications

struct SettingsView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    @State private var topic = ""
    @State private var message: String?
    @State private var busy = false
    @State private var confirmUnpair = false
    @State private var notifyOn = Notifier.shared.enabled
    @State private var keepAlive = KeepAlive.shared.enabled
    @State private var notifyStatus: UNAuthorizationStatus = .notDetermined

    var body: some View {
        NavigationStack {
            Form {
                if app.isHub {
                    HubSettingsSection()
                } else {
                    Section("Máy tính") {
                        LabeledContent("Tên máy", value: app.state?.host ?? "—")
                        LabeledContent("Địa chỉ") {
                            Text(app.baseURL).font(.footnote.monospaced()).textSelection(.enabled)
                        }
                        if let ok = app.lastOK {
                            LabeledContent("Kết nối lần cuối", value: ok.formatted(date: .omitted, time: .standard))
                        }
                    }
                }

                Section {
                    Toggle("Thông báo", isOn: Binding(
                        get: { notifyOn },
                        set: { v in
                            notifyOn = v
                            Notifier.shared.enabled = v
                            if v { Task { await Notifier.shared.requestPermission(); notifyStatus = await Notifier.shared.authorizationStatus() } }
                        }
                    ))
                    Toggle("Giữ kết nối khi ẩn app", isOn: Binding(
                        get: { keepAlive },
                        set: { v in keepAlive = v; KeepAlive.shared.enabled = v }
                    ))
                    if notifyStatus == .denied {
                        Button("Mở Cài đặt iPhone để cho phép thông báo") {
                            if let u = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(u) }
                        }
                    }
                } header: {
                    Text("Thông báo trên iPhone")
                } footer: {
                    Text("Báo khi Claude hỏi / xin quyền, xong việc, bị dừng hoặc hết hạn mức; bấm vào là mở đúng phiên. \"Giữ kết nối khi ẩn app\" giữ app chạy nền (âm thanh im lặng, không làm gián đoạn nhạc) để vẫn báo khi khoá màn hình — tốn pin hơn một chút. Tắt hẳn app (vuốt khỏi đa nhiệm) thì dùng ntfy ở dưới.")
                }

                Section {
                    Toggle("Luôn sẵn sàng nhận lệnh", isOn: Binding(
                        get: { app.state?.alwaysOn ?? true },
                        set: { v in Task { try? await app.setAlwaysOn(v) } }
                    ))
                } header: {
                    Text("Phiên VS Code / terminal")
                } footer: {
                    Text("Bật: phiên Claude Code trên máy (đã cài hook) luôn chờ sau mỗi lượt, mở app là nhắn được, gõ ở máy vẫn bình thường. Rời máy quá 45 giây thì xin quyền hiện trên điện thoại. Tắt: phải gõ /phone trong VS Code trước.")
                }

                if !app.isHub {
                Section {
                    TextField("topic bí mật, vd. cc-x7k2p9q4", text: $topic)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .font(.callout.monospaced())
                    HStack {
                        Button("Ngẫu nhiên") {
                            let chars = Array("abcdefghijklmnopqrstuvwxyz0123456789")
                            topic = "cc-" + String((0..<12).map { _ in chars.randomElement()! })
                        }
                        .buttonStyle(.bordered)
                        Spacer()
                        Button("Lưu") { Task { await save() } }
                            .buttonStyle(.borderedProminent)
                            .disabled(busy)
                    }
                    if app.state?.ntfy != nil {
                        Button("Gửi thông báo thử") { Task { await test() } }.disabled(busy)
                    }
                    if let message {
                        Text(message).font(.footnote).foregroundStyle(.secondary)
                    }
                } header: {
                    Text("Thông báo khi app đóng")
                } footer: {
                    Text("Máy tính gửi thông báo qua ntfy.sh khi Claude xin quyền, hỏi bạn, hết hạn mức hoặc xong việc mà app không mở. Cài app ntfy rồi đăng ký đúng topic này. Chỉ gửi tiêu đề ngắn, không gửi code. Để trống rồi Lưu để tắt.")
                }

                Section {
                    Link("Tải app ntfy", destination: URL(string: "https://docs.ntfy.sh/subscribe/phone/")!)
                    if !topic.isEmpty, let url = URL(string: "ntfy://ntfy.sh/\(topic)") {
                        Link("Mở topic trong app ntfy", destination: url)
                    }
                }

                Section {
                    Button("Huỷ ghép máy tính", role: .destructive) { confirmUnpair = true }
                } footer: {
                    Text("Muốn chặn hẳn thiết bị này, bấm Thu hồi trong dashboard trên máy tính.")
                }

                Section {
                    Button("Đăng nhập hub (không cần Tailscale)") { app.setMode("hub"); dismiss() }
                }
                }
            }
            .navigationTitle("Cài đặt")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Xong") { dismiss() } }
            }
            .onAppear { topic = app.state?.ntfy?.topic ?? "" }
            .task { notifyStatus = await Notifier.shared.authorizationStatus() }
            .confirmationDialog("Huỷ ghép?", isPresented: $confirmUnpair, titleVisibility: .visible) {
                Button("Huỷ ghép", role: .destructive) {
                    app.unpair()
                    dismiss()
                }
            } message: {
                Text("Cần mã ghép mới để kết nối lại.")
            }
        }
    }

    private func save() async {
        busy = true
        defer { busy = false }
        do {
            try await app.setNtfy(topic: topic.trimmingCharacters(in: .whitespaces))
            message = topic.isEmpty ? "Đã tắt thông báo" : "Đã lưu — đăng ký topic này trong app ntfy"
        } catch {
            message = (error as? APIError)?.message ?? error.localizedDescription
        }
    }

    private func test() async {
        busy = true
        defer { busy = false }
        do {
            message = try await app.testNtfy() ? "Đã gửi — kiểm tra app ntfy" : "Máy tính không gửi được tới ntfy"
        } catch {
            message = (error as? APIError)?.message ?? error.localizedDescription
        }
    }
}

/// Cài đặt khi kết nối qua hub: tài khoản, máy, thông báo ntfy (topic do hub cấp), thiết bị, đăng xuất.
struct HubSettingsSection: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    @State private var devices: [HubDevice] = []
    @State private var message: String?
    @State private var confirmLogout = false
    @State private var confirmAll = false
    @State private var sendOriginal = ImagePrep.sendOriginal

    var body: some View {
        Section {
            LabeledContent("Tài khoản", value: app.hub?.username ?? "—")
            LabeledContent("Hub") { Text(app.hubURL).font(.footnote.monospaced()).textSelection(.enabled) }
            LabeledContent("Máy tính", value: app.currentMachine?.name ?? "—")
            LabeledContent("Kết nối", value: app.hub?.connected == true ? "Đang kết nối" : (app.hub?.lastError ?? "Đang nối lại…"))
        } header: {
            Text("Hub")
        }

        Section {
            Toggle("Gửi ảnh gốc (không thu nhỏ)", isOn: Binding(get: { sendOriginal }, set: { sendOriginal = $0; ImagePrep.sendOriginal = $0 }))
        } footer: {
            Text("Mặc định ảnh được thu nhỏ còn cạnh dài 2000 px trước khi gửi (Claude cũng tự thu nhỏ ảnh quá cỡ). Bật khi cần soi chi tiết nhỏ.")
        }

        Section {
            if let s = app.hub?.ntfySubscribe, let url = URL(string: s) {
                Link("Bật thông báo khi app đóng (mở app ntfy)", destination: url)
            }
            Link("Tải app ntfy", destination: URL(string: "https://docs.ntfy.sh/subscribe/phone/")!)
        } header: {
            Text("Thông báo khi app đóng")
        } footer: {
            Text("Hub tự cấp topic riêng cho tài khoản của bạn: bấm một lần để đăng ký trong app ntfy. Chỉ báo khi app không mở.")
        }

        Section {
            ForEach(devices) { d in
                HStack {
                    VStack(alignment: .leading) {
                        Text(d.name + (d.current == true ? " (máy này)" : ""))
                        if let t = d.lastSeen {
                            Text("dùng lần cuối " + Date(timeIntervalSince1970: t / 1000).formatted(date: .abbreviated, time: .shortened))
                                .font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    Spacer()
                    if d.current != true {
                        Button("Thu hồi", role: .destructive) { Task { await revoke(d.id) } }.font(.footnote)
                    }
                }
            }
            if let message { Text(message).font(.footnote).foregroundStyle(.secondary) }
        } header: {
            Text("Thiết bị đã đăng nhập")
        }
        .task { await loadDevices() }

        Section {
            Button("Đăng xuất", role: .destructive) { confirmLogout = true }
            Button("Đăng xuất mọi nơi", role: .destructive) { confirmAll = true }
            Button("Dùng Tailscale (cách cũ)") { app.setMode("tailscale"); dismiss() }
        } footer: {
            Text("Đăng nhập dùng mãi — app không tự đăng xuất. Mất máy thì thu hồi thiết bị đó ở đây từ máy khác.")
        }
        .confirmationDialog("Đăng xuất khỏi hub?", isPresented: $confirmLogout, titleVisibility: .visible) {
            Button("Đăng xuất", role: .destructive) { app.logout(); dismiss() }
        }
        .confirmationDialog("Đăng xuất trên mọi thiết bị?", isPresented: $confirmAll, titleVisibility: .visible) {
            Button("Đăng xuất mọi nơi", role: .destructive) {
                Task {
                    let _: Ignored? = try? await app.hubCall("logoutAll")
                    app.logout(remote: false)
                    dismiss()
                }
            }
        }
    }

    private func loadDevices() async {
        do { devices = try await app.hubCall("devices") } catch { message = (error as? APIError)?.message ?? error.localizedDescription }
    }

    private func revoke(_ id: String) async {
        do {
            let _: Ignored = try await app.hubCall("devices.revoke", ["id": id])
            await loadDevices()
            message = "Đã thu hồi"
        } catch { message = (error as? APIError)?.message ?? error.localizedDescription }
    }
}

import SwiftUI
import UserNotifications

struct SettingsView: View {
    @Environment(AppModel.self) private var app
    @Environment(.dismiss) private var dismiss
    @State private var notifyOn = Notifier.shared.enabled
    @State private var keepAlive = KeepAlive.shared.enabled
    @State private var notifyStatus: UNAuthorizationStatus = .notDetermined

    var body: some View {
        NavigationStack {
            Form {
                HubSettingsSection()

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
                    Text("Báo khi Claude hỏi / xin quyền, xong việc, bị dừng hoặc hết hạn mức; bấm vào là mở đúng phiên. \"Giữ kết nối khi ẩn app\" giữ app chạy nền (âm thanh im lặng, không làm gián đoạn nhạc) để vẫn báo khi khoá màn hình — tốn pin hơn một chút. Tắt hẳn app (vuốt khỏi đa nhiệm) thì dùng ntfy ở mục Hub.")
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
            }
            .navigationTitle("Cài đặt")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Xong") { dismiss() } }
            }
            .task { notifyStatus = await Notifier.shared.authorizationStatus() }
        }
    }
}

/// Cài đặt hub: tài khoản, máy, thông báo ntfy (topic do hub cấp), thiết bị, đăng xuất.
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

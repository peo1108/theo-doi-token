import SwiftUI

struct SettingsView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    @State private var topic = ""
    @State private var message: String?
    @State private var busy = false
    @State private var confirmUnpair = false

    var body: some View {
        NavigationStack {
            Form {
                Section("Máy tính") {
                    LabeledContent("Tên máy", value: app.state?.host ?? "—")
                    LabeledContent("Địa chỉ") {
                        Text(app.baseURL).font(.footnote.monospaced()).textSelection(.enabled)
                    }
                    if let ok = app.lastOK {
                        LabeledContent("Kết nối lần cuối", value: ok.formatted(date: .omitted, time: .standard))
                    }
                }

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
            }
            .navigationTitle("Cài đặt")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Xong") { dismiss() } }
            }
            .onAppear { topic = app.state?.ntfy?.topic ?? "" }
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

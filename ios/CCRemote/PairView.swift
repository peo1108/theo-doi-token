import SwiftUI

struct PairView: View {
    @Environment(AppModel.self) private var app
    @State private var url = UserDefaults.standard.string(forKey: "baseURL") ?? ""
    @State private var code = ""
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
                        Text("""
                        1. Cài Tailscale trên máy tính và iPhone, đăng nhập cùng một tài khoản.
                        2. Trên máy tính, mở dashboard Theo dõi token → thẻ **Điện thoại** → bấm **Mở cho điện thoại**, rồi **Tạo mã ghép**.
                        3. Nhập địa chỉ và mã ở dưới.
                        """)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                    }
                    .padding(.vertical, 4)
                }

                Section("Máy tính") {
                    TextField("may-tinh.tailxxxx.ts.net", text: $url)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    TextField("Mã ghép 6 số", text: $code)
                        .keyboardType(.numberPad)
                        .font(.title3.monospacedDigit())
                        .onChange(of: code) { _, v in
                            let digits = String(v.filter(\.isNumber).prefix(6))
                            if digits != v { code = digits }
                        }
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
                            if busy { ProgressView() } else { Text("Ghép").bold() }
                            Spacer()
                        }
                    }
                    .disabled(busy || url.trimmingCharacters(in: .whitespaces).isEmpty || code.count != 6)
                }

                Section {
                    Button("Đăng nhập hub (không cần Tailscale)") { app.setMode("hub") }
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
            try await app.pair(url: url, code: code)
        } catch let e {
            self.error = (e as? APIError)?.message ?? e.localizedDescription
        }
        busy = false
    }
}

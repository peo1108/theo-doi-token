import SwiftUI

struct HomeView: View {
    @Environment(AppModel.self) private var app
    @State private var confirmSwitch: Account?
    @State private var showNew = false
    @State private var showSettings = false
    @State private var switchMessage: String?

    var body: some View {
        List {
            if let err = app.lastError {
                Section {
                    Label(err, systemImage: "wifi.exclamationmark")
                        .foregroundStyle(.red)
                        .font(.callout)
                }
            }

            // cảnh báo của máy (ngân sách, hạn mức 90%, cần /login lại…): vuốt sang trái để ẩn
            if !app.visibleAlerts.isEmpty {
                Section("Cảnh báo trên máy") {
                    ForEach(app.visibleAlerts) { a in
                        PCAlertRow(alert: a)
                            .swipeActions { Button("Ẩn") { app.dismissAlert(a.id) }.tint(.gray) }
                    }
                }
            }

            if let info = app.state?.accounts, !info.list.isEmpty {
                Section {
                    ForEach(info.list) { a in
                        AccountRow(account: a) { confirmSwitch = a }
                    }
                    if let switchMessage {
                        Text(switchMessage).font(.footnote).foregroundStyle(.secondary)
                    }
                } header: {
                    Text("Tài khoản")
                } footer: {
                    if info.conflict {
                        Text("Đăng nhập trên máy đang khác tài khoản đã chọn — mở dashboard để xử lý.")
                    }
                }
            }

            // tài khoản hub chưa có máy tính nào (người mới, máy vừa bị ngắt): chỉ cách ghép thay vì "Đang tải…" mãi
            if app.hub?.connected == true && app.machines.isEmpty {
                Section {
                    VStack(alignment: .leading, spacing: 6) {
                        Label("Chưa có máy tính nào", systemImage: "desktopcomputer").font(.headline)
                        Text("Trên máy tính: mở dashboard (127.0.0.1:7788) → thẻ Điện thoại → Kết nối hub, đăng nhập cùng tài khoản này. Máy sẽ hiện ra ở đây.")
                            .font(.callout)
                            .foregroundStyle(.secondary)
                    }
                    .padding(.vertical, 4)
                }
            }

            Section("Đang chạy") {
                let live = app.state?.live ?? []
                if live.isEmpty {
                    Text(app.state != nil ? "Không có phiên nào đang chạy"
                         : app.machines.isEmpty && app.hub?.connected == true ? "Chưa ghép máy tính"
                         : app.currentMachine?.online == false ? "Máy tính đang tắt hoặc chưa chạy tracker"
                         : "Đang tải…")
                        .foregroundStyle(.secondary)
                } else {
                    ForEach(live) { s in
                        NavigationLink(value: Route.session(s.id)) { LiveRow(session: s) }
                    }
                }
            }

            if let projects = app.state?.projects, !projects.isEmpty {
                Section("Dự án") {
                    ForEach(projects) { p in
                        NavigationLink(value: Route.project(p.cwd)) { ProjectRow(project: p) }
                    }
                }
            } else if let recent = app.state?.recent, !recent.isEmpty {
                Section("Gần đây") {
                    ForEach(recent) { r in
                        NavigationLink(value: Route.session(r.id)) { RecentRow(session: r) }
                    }
                }
            }
        }
        // tên máy đã hiện ở nút chọn máy phía trên; tên Windows (DESKTOP-…) làm tiêu đề lớn thì vô nghĩa và bị cắt
        .navigationTitle("CC Remote")
        .refreshable { await app.refresh() }
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button { showSettings = true } label: { Image(systemName: "gearshape") }
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button { showNew = true } label: { Image(systemName: "square.and.pencil") }
            }
            ToolbarItem(placement: .principal) { MachinePicker() }
        }
        .sheet(isPresented: $showNew) { NewSessionView() }
        .sheet(isPresented: $showSettings) { SettingsView() }
        .confirmationDialog(
            confirmSwitch.map { "Đổi sang \($0.name)?" } ?? "",
            isPresented: Binding(get: { confirmSwitch != nil }, set: { if !$0 { confirmSwitch = nil } }),
            titleVisibility: .visible,
            presenting: confirmSwitch
        ) { a in
            Button("Đổi sang \(a.name)") {
                Task {
                    do {
                        let r = try await app.switchAccount(a.id)
                        let n = r.restarted?.count ?? 0
                        switchMessage = "Đã đổi sang \(a.name)" + (n > 0 ? " · khởi động lại \(n) phiên" : "")
                    } catch {
                        switchMessage = (error as? APIError)?.message ?? error.localizedDescription
                    }
                }
            }
        } message: { _ in
            Text("Claude Code trên máy sẽ dùng tài khoản này. Phiên mở từ điện thoại tự khởi động lại khi rảnh; phiên mở trong terminal cần mở lại.")
        }
    }
}

/// Một cảnh báo của tracker trên máy tính.
struct PCAlertRow: View {
    let alert: PCAlert

    private var icon: (String, Color) {
        switch alert.level {
        case "critical": return ("exclamationmark.octagon.fill", .red)
        case "warning": return ("exclamationmark.triangle.fill", .orange)
        default: return ("info.circle.fill", .accentColor)
        }
    }

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: icon.0).foregroundStyle(icon.1)
            VStack(alignment: .leading, spacing: 2) {
                Text(alert.title).font(.subheadline.weight(.semibold))
                if let b = alert.body, !b.isEmpty {
                    Text(b).font(.caption).foregroundStyle(.secondary)
                }
                Text(relativeTime(alert.t)).font(.caption2).foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 2)
    }
}

struct UsageBar: View {
    let label: String
    let pct: Double?

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack {
                Text(label).foregroundStyle(.secondary)
                Spacer()
                Text(pct.map { "\(Int($0.rounded()))%" } ?? "—").monospacedDigit().bold()
            }
            .font(.caption)
            ProgressView(value: min(max((pct ?? 0) / 100, 0), 1))
                .tint(color)
        }
    }

    private var color: Color {
        guard let pct else { return .gray }
        return pct >= 90 ? .red : pct >= 70 ? .orange : .accentColor
    }
}

struct AccountRow: View {
    let account: Account
    let onSwitch: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 6) {
                        Text(account.name).font(.body.weight(.semibold))
                        if account.active {
                            Text("Đang dùng")
                                .font(.caption2.bold())
                                .padding(.horizontal, 6).padding(.vertical, 2)
                                .background(Color.green.opacity(0.18), in: Capsule())
                                .foregroundStyle(.green)
                        } else if account.suggested {
                            Text("Nên dùng")
                                .font(.caption2.bold())
                                .padding(.horizontal, 6).padding(.vertical, 2)
                                .background(Color.blue.opacity(0.15), in: Capsule())
                                .foregroundStyle(.blue)
                        }
                    }
                    if let email = account.email, !email.isEmpty {
                        Text(email).font(.caption).foregroundStyle(.secondary)
                    }
                }
                Spacer()
                if !account.active && account.error == nil {
                    Button("Dùng", action: onSwitch)
                        .buttonStyle(.bordered)
                        .controlSize(.small)
                }
            }
            if let err = account.error {
                Text(err).font(.caption).foregroundStyle(.red)
            } else {
                HStack(spacing: 14) {
                    UsageBar(label: "5 giờ", pct: account.fiveHour?.pct)
                    UsageBar(label: "7 ngày", pct: account.sevenDay?.pct)
                }
                if account.loginState == "expired" {
                    Label("Hết hạn đăng nhập — cần /login lại", systemImage: "exclamationmark.triangle")
                        .font(.caption).foregroundStyle(.red)
                } else if account.loginState == "soon" {
                    Label("Sắp hết hạn đăng nhập", systemImage: "clock")
                        .font(.caption).foregroundStyle(.orange)
                }
            }
        }
        .padding(.vertical, 4)
    }
}

struct StatusBadge: View {
    let status: String

    var body: some View {
        let info = statusInfo(status)
        HStack(spacing: 4) {
            Image(systemName: info.icon)
            Text(info.label)
        }
            .font(.caption2.bold())
            .padding(.horizontal, 7).padding(.vertical, 3)
            .background(color(info.color).opacity(0.15), in: Capsule())
            .foregroundStyle(color(info.color))
    }

    private func color(_ name: String) -> Color {
        switch name {
        case "blue": return .blue
        case "orange": return .orange
        case "green": return .green
        default: return .gray
        }
    }
}

struct LiveRow: View {
    let session: SessionSummary

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(session.title.flatMap { $0.isEmpty ? nil : $0 } ?? "Phiên mới").font(.body.weight(.medium)).lineLimit(1)
                Spacer()
                StatusBadge(status: session.status)
            }
            HStack(spacing: 6) {
                Image(systemName: "folder").font(.caption2)
                Text(session.project ?? "").font(.caption)
                if session.external == true {
                    Label(session.attached == true ? "\(session.source ?? "Máy tính") · đã gắn" : session.source ?? "Máy tính",
                          systemImage: "laptopcomputer")
                        .font(.caption)
                        .foregroundStyle(session.attached == true ? Color.accentColor : Color.secondary)
                }
                if session.pending > 0 {
                    Text("· \(session.pending) chờ duyệt").font(.caption.bold()).foregroundStyle(.orange)
                }
            }
            .foregroundStyle(.secondary)
            if let t = session.lastText, !t.isEmpty {
                Text(t).font(.caption).foregroundStyle(.secondary).lineLimit(2)
            }
        }
        .padding(.vertical, 2)
    }
}

struct RecentRow: View {
    let session: RecentSession

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(session.title).lineLimit(2)
            HStack(spacing: 6) {
                Image(systemName: "folder").font(.caption2)
                Text(session.project)
                Text("·")
                Text(relativeTime(session.updatedAt))
            }
            .font(.caption)
            .foregroundStyle(.secondary)
        }
        .padding(.vertical, 2)
    }
}

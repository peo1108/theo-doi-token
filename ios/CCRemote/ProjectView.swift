import SwiftUI

/// Một dòng dự án ở trang chủ: tên, số phiên, lần dùng cuối, chấm xanh nếu đang có phiên chạy.
struct ProjectRow: View {
    let project: Project

    var body: some View {
        HStack(spacing: 12) {
            ZStack(alignment: .topTrailing) {
                Image(systemName: "folder.fill")
                    .font(.title3)
                    .foregroundStyle(Color.accentColor)
                    .frame(width: 30)
                if (project.live ?? 0) > 0 {
                    Circle().fill(Color.green).frame(width: 9, height: 9)
                        .overlay(Circle().stroke(Color(.systemBackground), lineWidth: 1.5))
                        .offset(x: 3, y: -2)
                }
            }
            VStack(alignment: .leading, spacing: 3) {
                Text(project.name).font(.body.weight(.medium)).lineLimit(1)
                HStack(spacing: 5) {
                    if let n = project.count { Text("\(n) phiên") }
                    Text("·")
                    Text(relativeTime(project.lastUsed))
                    if let l = project.live, l > 0 {
                        Text("· \(l) đang chạy").foregroundStyle(.green)
                    }
                }
                .font(.caption)
                .foregroundStyle(.secondary)
                if let t = project.lastTitle, !t.isEmpty {
                    Text(t).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                }
            }
        }
        .padding(.vertical, 2)
    }
}

/// Các phiên của một dự án: đang chạy ở trên, rồi tới phiên cũ (mới trước). Nút ✏️ mở phiên mới ngay trong dự án.
struct ProjectView: View {
    let cwd: String
    @Environment(AppModel.self) private var app
    @State private var sessions: [RecentSession] = []
    @State private var loaded = false
    @State private var error: String?
    @State private var showNew = false

    private var name: String {
        app.state?.projects?.first { $0.cwd == cwd }?.name ?? URL(fileURLWithPath: cwd).lastPathComponent
    }

    private var live: [SessionSummary] {
        (app.state?.live ?? []).filter { ($0.cwd ?? "").lowercased() == cwd.lowercased() }
    }

    var body: some View {
        List {
            Section {
                Button {
                    showNew = true
                } label: {
                    Label("Phiên mới trong \(name)", systemImage: "square.and.pencil")
                }
            } footer: {
                Text(cwd).font(.caption2.monospaced())
            }

            if !live.isEmpty {
                Section("Đang chạy") {
                    ForEach(live) { s in
                        NavigationLink(value: Route.session(s.id)) { LiveRow(session: s) }
                    }
                }
            }

            let liveIds = Set(live.map(\.id))
            let older = sessions.filter { !liveIds.contains($0.id) }
            Section(loaded ? "Phiên trước (\(older.count))" : "Phiên trước") {
                if let error {
                    Label(error, systemImage: "exclamationmark.triangle").foregroundStyle(.red).font(.callout)
                } else if !loaded {
                    HStack { ProgressView(); Text("Đang tải…").foregroundStyle(.secondary) }
                } else if older.isEmpty {
                    Text(sessions.isEmpty ? "Chưa có phiên nào" : "Không có phiên cũ — tất cả đang chạy").foregroundStyle(.secondary)
                }
                ForEach(older) { s in
                    NavigationLink(value: Route.session(s.id)) {
                        VStack(alignment: .leading, spacing: 3) {
                            Text(s.title).lineLimit(2)
                            Text(relativeTime(s.updatedAt)).font(.caption).foregroundStyle(.secondary)
                        }
                        .padding(.vertical, 2)
                    }
                }
            }
        }
        .navigationTitle(name)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button { showNew = true } label: { Image(systemName: "square.and.pencil") }
            }
        }
        .refreshable { await load() }
        .task { await load() }
        .sheet(isPresented: $showNew) { NewSessionView(presetCwd: cwd) }
    }

    private func load() async {
        do {
            sessions = try await app.projectSessions(cwd)
            error = nil
        } catch {
            self.error = (error as? APIError)?.message ?? error.localizedDescription
        }
        loaded = true
        await app.refresh()
    }
}

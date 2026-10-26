import SwiftUI

@main
struct CCRemoteApp: App {
    @State private var app = AppModel()
    @Environment(\.scenePhase) private var phase

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(app)
                .onOpenURL { app.open(url: $0) }
        }
        .onChange(of: phase) { _, p in
            if p == .active {
                KeepAlive.shared.stop()
                Task {
                    await Notifier.shared.refreshAuthorization()   // có thể vừa bật thông báo trong Cài đặt iPhone
                    await app.refresh()
                }
            } else if p == .background, app.isPaired {
                KeepAlive.shared.start()   // giữ app chạy nền để vẫn báo khi khoá màn hình
            }
            // hub chỉ đẩy ntfy khi không app nào đang mở; app còn chạy nền và tự báo được thì hub thôi đẩy
            // sự kiện của phiên (xin quyền, xong việc…) để không báo trùng hai lần
            app.hub?.setForeground(p == .active, notifies: p != .active && KeepAlive.shared.running && Notifier.shared.canNotify)
        }
    }
}

struct RootView: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        @Bindable var app = app
        Group {
            if app.isPaired {
                NavigationStack(path: $app.path) {
                    HomeView()
                        .navigationDestination(for: Route.self) { route in
                            switch route {
                            case .session(let id):
                                SessionView(id: id)
                            case .project(let cwd):
                                ProjectView(cwd: cwd)
                            }
                        }
                }
                // theo dõi máy tính suốt khi app còn chạy (cả khi ẩn app nhờ KeepAlive) để báo kịp thời
                .task {
                    Notifier.shared.setup(app: app)
                    if Notifier.shared.enabled { await Notifier.shared.requestPermission() }
                    await app.poll()
                }
            } else {
                LoginView()
            }
        }
    }
}

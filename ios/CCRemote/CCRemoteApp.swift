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
            if p == .active { Task { await app.refresh() } }
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
            } else {
                PairView()
            }
        }
    }
}

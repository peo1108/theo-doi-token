import Foundation
import Observation
import SwiftUI
import UIKit

@MainActor
@Observable
final class AppModel {
    var baseURL: String = UserDefaults.standard.string(forKey: "baseURL") ?? ""
    var token: String? = SecureStore.get("token")
    var state: RemoteState?
    var lastError: String?
    var lastOK: Date?
    var path = NavigationPath()
    var caps: Capabilities?

    var isPaired: Bool { token != nil && !baseURL.isEmpty }

    init() {
        // `-openSession <id>` khi khởi chạy (dùng cho kiểm tra trên Simulator)
        if let id = UserDefaults.standard.string(forKey: "openSession"), id.count == 36 {
            path.append(Route.session(id))
        }
        if let cwd = UserDefaults.standard.string(forKey: "openProject"), !cwd.isEmpty {
            path.append(Route.project(cwd))
        }
    }

    var api: APIClient? {
        guard let token, !baseURL.isEmpty else { return nil }
        return APIClient(base: baseURL, token: token)
    }

    func pair(url raw: String, code: String) async throws {
        let base = APIClient.normalize(raw)
        guard !base.isEmpty else { throw APIError(code: "URL", message: "Nhập địa chỉ máy tính") }
        let open = APIClient(base: base, token: nil)
        let ping: PingResponse = try await open.call("GET", "/v1/ping")
        guard ping.ok, ping.app == "theo-doi-token" else {
            throw APIError(code: "NOT_TRACKER", message: "Địa chỉ này không phải tool Theo dõi token")
        }
        let r: PairResponse = try await open.call("POST", "/v1/pair", body: [
            "code": code.trimmingCharacters(in: .whitespaces),
            "name": UIDevice.current.name,
        ])
        baseURL = base
        token = r.token
        UserDefaults.standard.set(base, forKey: "baseURL")
        SecureStore.set(r.token, for: "token")
        lastError = nil
        await refresh()
    }

    func unpair() {
        token = nil
        state = nil
        SecureStore.set(nil, for: "token")
        path = NavigationPath()
    }

    func refresh() async {
        guard let api else { return }
        do {
            state = try await api.call("GET", "/v1/state")
            lastError = nil
            lastOK = Date()
        } catch let e as APIError {
            lastError = e.message
            if e.code == "UNAUTHORIZED" { unpair() }
        } catch {
            lastError = error.localizedDescription
        }
    }

    func poll() async {
        while !Task.isCancelled {
            await refresh()
            try? await Task.sleep(for: .seconds(4))
        }
    }

    /// Model, lệnh /, output style: tải một lần, làm mới sau 10 phút.
    private var capsAt: Date?
    func loadCaps(force: Bool = false) async {
        guard let api else { return }
        if !force, caps != nil, let at = capsAt, Date().timeIntervalSince(at) < 600 { return }
        if let c: Capabilities = try? await api.call("GET", "/v1/capabilities") {
            caps = c
            capsAt = Date()
        }
    }

    func projectSessions(_ cwd: String) async throws -> [RecentSession] {
        guard let api else { return [] }
        let q = cwd.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? ""
        return try await api.call("GET", "/v1/projects/sessions?cwd=\(q)")
    }

    func projects() async throws -> [Project] {
        guard let api else { return [] }
        return try await api.call("GET", "/v1/projects")
    }

    func createSession(cwd: String, text: String, mode: String, model: String, options: [String: Any] = [:]) async throws -> SessionSummary {
        guard let api else { throw APIError(code: "UNPAIRED", message: "Chưa ghép máy tính") }
        var body: [String: Any] = ["cwd": cwd, "text": text, "mode": mode, "model": model]
        body.merge(options) { _, new in new }
        let s: SessionSummary = try await api.call("POST", "/v1/sessions", body: body)
        await refresh()
        return s
    }

    @discardableResult
    func switchAccount(_ id: String, sessionId: String? = nil, text: String? = nil) async throws -> SwitchResponse {
        guard let api else { throw APIError(code: "UNPAIRED", message: "Chưa ghép máy tính") }
        var body: [String: Any] = ["id": id]
        if let sessionId { body["sessionId"] = sessionId }
        if let text { body["text"] = text }
        let r: SwitchResponse = try await api.call("POST", "/v1/accounts/switch", body: body)
        await refresh()
        return r
    }

    func setNtfy(topic: String) async throws {
        guard let api else { return }
        let _: Ignored = try await api.call("POST", "/v1/ntfy", body: ["topic": topic])
        await refresh()
    }

    func testNtfy() async throws -> Bool {
        guard let api else { return false }
        struct R: Decodable { let ok: Bool }
        let r: R = try await api.call("POST", "/v1/ntfy/test")
        return r.ok
    }

    func open(url: URL) {
        // ccremote://session/<id>
        guard url.scheme == "ccremote", url.host == "session" else { return }
        let id = url.lastPathComponent
        guard id.count == 36 else { return }
        path = NavigationPath()
        path.append(Route.session(id))
    }

    func title(for id: String) -> String {
        if let s = state?.live.first(where: { $0.id == id }), let t = s.title, !t.isEmpty { return t }
        if let r = state?.recent.first(where: { $0.id == id }) { return r.title }
        return "Phiên"
    }
}

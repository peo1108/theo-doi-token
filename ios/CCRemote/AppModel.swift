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

    // ---- chế độ hub (VPS): đăng nhập tài khoản, điện thoại không cần Tailscale ----
    static let defaultHub = "https://clauderc.caesarvn.xyz"
    /// "hub" | "tailscale" (đường cũ: ghép mã 6 số qua Tailscale)
    var mode: String = UserDefaults.standard.string(forKey: "mode") ?? (SecureStore.get("token") != nil ? "tailscale" : "hub")
    var hubURL: String = UserDefaults.standard.string(forKey: "hubURL") ?? AppModel.defaultHub
    var hubToken: String? = SecureStore.get("hubToken")
    var machineId: String = UserDefaults.standard.string(forKey: "machineId") ?? ""
    var hub: HubClient?

    var isHub: Bool { mode == "hub" }
    var isPaired: Bool { isHub ? hubToken != nil : (token != nil && !baseURL.isEmpty) }
    var machines: [HubMachine] { hub?.machines ?? [] }
    var currentMachine: HubMachine? { machines.first { $0.id == machineId } }

    init() {
        if mode == "hub", let t = hubToken { startHub(token: t) }
        // `-openSession <id>` khi khởi chạy (dùng cho kiểm tra trên Simulator)
        if let id = UserDefaults.standard.string(forKey: "openSession"), id.count == 36 {
            path.append(Route.session(id))
        }
        if let cwd = UserDefaults.standard.string(forKey: "openProject"), !cwd.isEmpty {
            path.append(Route.project(cwd))
        }
    }

    var api: APIClient? {
        if isHub {
            guard let hub, !machineId.isEmpty else { return nil }
            return APIClient(base: hubURL, token: nil, hub: hub, machine: machineId)
        }
        guard let token, !baseURL.isEmpty else { return nil }
        return APIClient(base: baseURL, token: token)
    }

    private func startHub(token: String) {
        hub?.stop()
        let h = HubClient(base: hubURL, token: token)
        h.onUnauthorized = { [weak self] in self?.logout(remote: false) }
        h.onSessionsChanged = { [weak self] m in
            guard let self, m == self.machineId else { return }
            Task { await self.refresh() }
        }
        hub = h
        h.start()
    }

    /// Chọn máy: giữ máy đã chọn nếu còn; không thì máy online đầu tiên.
    func pickMachine() {
        if let m = currentMachine, m.online { return }
        if let m = machines.first(where: { $0.online }) ?? (currentMachine == nil ? machines.first : nil) { selectMachine(m.id) }
    }

    func selectMachine(_ id: String) {
        guard id != machineId else { return }
        machineId = id
        UserDefaults.standard.set(id, forKey: "machineId")
        state = nil
        caps = nil
        path = NavigationPath()
        Task { await refresh() }
    }

    /// Đăng nhập (hoặc đăng ký bằng mã mời) vào hub. Token dùng mãi tới khi tự đăng xuất.
    func login(url raw: String, username: String, password: String, invite: String? = nil) async throws {
        let base = APIClient.normalize(raw.isEmpty ? AppModel.defaultHub : raw)
        let open = APIClient(base: base, token: nil)
        var body: [String: Any] = ["username": username.trimmingCharacters(in: .whitespaces), "password": password, "deviceName": UIDevice.current.name]
        let path: String
        if let invite, !invite.trimmingCharacters(in: .whitespaces).isEmpty { body["invite"] = invite; path = "/v1/auth/register" } else { path = "/v1/auth/login" }
        let r: HubLoginResponse = try await open.call("POST", path, body: body)
        hubURL = base
        hubToken = r.token
        mode = "hub"
        UserDefaults.standard.set(base, forKey: "hubURL")
        UserDefaults.standard.set("hub", forKey: "mode")
        SecureStore.set(r.token, for: "hubToken")
        lastError = nil
        startHub(token: r.token)
        await hub?.ready()
        pickMachine()
        await refresh()
    }

    /// Đăng xuất khỏi hub (chỉ khi người dùng bấm, hoặc hub báo token đã bị thu hồi).
    func logout(remote: Bool = true) {
        if remote, let t = hubToken {
            let open = APIClient(base: hubURL, token: t)
            Task { let _: Ignored? = try? await open.call("POST", "/v1/auth/logout") }
        }
        hub?.stop()
        hub = nil
        hubToken = nil
        state = nil
        SecureStore.set(nil, for: "hubToken")
        path = NavigationPath()
    }

    /// Hàm của chính hub: thiết bị, máy, đổi mật khẩu, ntfy...
    func hubCall<T: Decodable>(_ method: String, _ params: [String: Any] = [:]) async throws -> T {
        guard let hub else { throw APIError(code: "UNPAIRED", message: "Chưa đăng nhập hub") }
        let d = try await hub.call(machine: "hub", method: method, params: params)
        return try JSONDecoder().decode(T.self, from: d)
    }

    /// Chuyển giữa hub và Tailscale (cũ) — không xoá đăng nhập của chế độ kia.
    func setMode(_ m: String) {
        mode = m
        UserDefaults.standard.set(m, forKey: "mode")
        state = nil
        path = NavigationPath()
        if m == "hub", let t = hubToken { startHub(token: t) } else { hub?.stop(); hub = nil }
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
        if isHub {
            pickMachine()
            if api == nil { state = nil; lastError = hub?.lastError; return }
            if currentMachine?.online == false { lastError = "Máy \(currentMachine?.name ?? "") đang tắt hoặc chưa chạy tracker"; return }
        }
        guard let api else { return }
        do {
            let st: RemoteState = try await api.call("GET", "/v1/state")
            state = st
            Notifier.shared.process(st)
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

    func setAlwaysOn(_ on: Bool) async throws {
        guard let api else { return }
        let _: Ignored = try await api.call("POST", "/v1/always-on", body: ["on": on])
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

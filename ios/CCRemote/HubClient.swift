import Foundation
import Observation

/// Máy tính (PC) của người dùng trên hub.
struct HubMachine: Identifiable, Hashable {
    let id: String
    var name: String
    var online: Bool
    var lastSeen: Double?
}

/// Kết nối WebSocket tới CC Remote Hub (VPS): hỏi–đáp (req/res) tới máy tính, theo dõi phiên (sub/event),
/// tự nối lại 1 → 30 giây. Tin lớn hơn 256 KB được chia mảnh (khung nhị phân "part"), giống hub/proto.js.
@MainActor
@Observable
final class HubClient {
    static let proto = 1
    static let chunk = 256 * 1024

    private(set) var machines: [HubMachine] = []
    private(set) var connected = false
    private(set) var username: String?
    private(set) var ntfySubscribe: String?
    var lastError: String?
    /// gọi khi token không còn hiệu lực (thu hồi, khoá, đăng xuất ở thiết bị khác)
    @ObservationIgnored var onUnauthorized: (@MainActor () -> Void)?
    /// gọi khi danh sách phiên trên một máy đổi (để làm mới màn hình chính)
    @ObservationIgnored var onSessionsChanged: (@MainActor (String) -> Void)?

    private let wsURL: URL
    private let token: String
    @ObservationIgnored private var task: URLSessionWebSocketTask?
    private var stopped = false
    private var attempt = 0
    private var foreground = true
    /// app chạy nền và tự báo được (thông báo local) -> hub thôi đẩy ntfy cho sự kiện của phiên, khỏi báo trùng
    private var notifies = false
    @ObservationIgnored private var pending: [String: CheckedContinuation<Data, Error>] = [:]
    /// "machine:session" -> luồng đang xem; token phân biệt luồng cũ / mới của cùng một phiên
    @ObservationIgnored private var subs: [String: (token: UUID, c: AsyncThrowingStream<Data, Error>.Continuation)] = [:]
    @ObservationIgnored private var parts: [String: (next: Int, data: Data)] = [:]
    @ObservationIgnored private var welcomeWaiters: [UUID: CheckedContinuation<Void, Never>] = [:]
    private let session = URLSession(configuration: .default)

    init(base: String, token: String) {
        var s = base.replacingOccurrences(of: "https://", with: "wss://").replacingOccurrences(of: "http://", with: "ws://")
        while s.hasSuffix("/") { s.removeLast() }
        self.wsURL = URL(string: s + "/v1/ws") ?? URL(string: "wss://invalid")!
        self.token = token
    }

    // MARK: - kết nối

    func start() {
        stopped = false
        if task == nil { connect() }
    }

    func stop() {
        stopped = true
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        failAll(APIError(code: "STOPPED", message: "Đã ngắt kết nối hub"))
        connected = false
        releaseWaiters()
    }

    func setForeground(_ fg: Bool, notifies: Bool = false) {
        foreground = fg
        self.notifies = notifies
        sendJSON(["type": "presence", "foreground": fg, "notifies": notifies])
        if fg && task == nil && !stopped { attempt = 0; connect() }
    }

    /// Chờ bắt tay xong (tối đa vài giây) — dùng trước lời gọi đầu tiên sau khi mở app.
    func ready(timeout: Double = 6) async {
        if connected { return }
        let key = UUID()
        await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
            welcomeWaiters[key] = c
            Task { @MainActor [weak self] in
                try? await Task.sleep(for: .seconds(timeout))
                self?.welcomeWaiters.removeValue(forKey: key)?.resume()
            }
        }
    }

    private func releaseWaiters() {
        let w = welcomeWaiters
        welcomeWaiters = [:]
        w.values.forEach { $0.resume() }
    }

    private func connect() {
        guard !stopped else { return }
        let t = session.webSocketTask(with: wsURL)
        t.maximumMessageSize = 2 * 1024 * 1024
        task = t
        t.resume()
        sendJSON(["type": "hello", "proto": Self.proto, "role": "app", "token": token,
                  "client": ["name": "ios", "version": Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? ""]])
        receive(t)
        ping(t)
    }

    private func receive(_ t: URLSessionWebSocketTask) {
        t.receive { [weak self] result in
            Task { @MainActor in
                guard let self, self.task === t else { return }
                switch result {
                case .success(let msg):
                    switch msg {
                    case .string(let s): self.handle(Data(s.utf8))
                    case .data(let d): self.handlePart(d)
                    @unknown default: break
                    }
                    self.receive(t)
                case .failure:
                    self.closed(t)
                }
            }
        }
    }

    private func ping(_ t: URLSessionWebSocketTask) {
        Task { @MainActor [weak self] in
            while true {
                try? await Task.sleep(for: .seconds(20))
                guard let self, self.task === t else { return }
                t.sendPing { [weak self] err in
                    if err != nil { Task { @MainActor in self?.closed(t) } }
                }
            }
        }
    }

    private func closed(_ t: URLSessionWebSocketTask) {
        guard task === t else { return }
        let code = t.closeCode.rawValue
        task = nil
        connected = false
        failAll(APIError(code: "NETWORK", message: "Mất kết nối tới hub"))
        if code == 4001 {
            stopped = true
            lastError = "Đăng nhập không còn hiệu lực"
            onUnauthorized?()
            return
        }
        if code == 4002 { stopped = true; lastError = "Cần cập nhật app để dùng hub này"; return }
        guard !stopped else { return }
        let delay = min(30, pow(2, Double(attempt))) * Double.random(in: 0.8...1.2)
        attempt += 1
        Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            guard let self, self.task == nil, !self.stopped else { return }
            self.connect()
        }
    }

    private func failAll(_ e: Error) {
        let p = pending
        pending = [:]
        p.values.forEach { $0.resume(throwing: e) }
        let s = subs
        subs = [:]
        s.values.forEach { $0.c.finish(throwing: e) }
        parts = [:]
    }

    // MARK: - nhận tin

    private func handle(_ data: Data) {
        guard let m = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any], let type = m["type"] as? String else { return }
        switch type {
        case "welcome":
            attempt = 0
            connected = true
            lastError = nil
            if let u = m["user"] as? [String: Any] { username = u["username"] as? String }
            if let n = m["ntfy"] as? [String: Any] { ntfySubscribe = n["subscribe"] as? String }
            machines = (m["machines"] as? [[String: Any]] ?? []).compactMap(Self.machine)
            sendJSON(["type": "presence", "foreground": foreground, "notifies": notifies])
            releaseWaiters()
        case "res":
            guard let id = m["id"] as? String, let c = pending.removeValue(forKey: id) else { return }
            if m["ok"] as? Bool == true {
                let r = m["result"] ?? NSNull()
                c.resume(returning: (try? JSONSerialization.data(withJSONObject: r, options: [.fragmentsAllowed])) ?? Data("null".utf8))
            } else {
                let e = m["error"] as? [String: Any]
                c.resume(throwing: Self.apiError(e?["code"] as? String ?? "ERROR", e?["message"] as? String))
            }
        case "event":
            let machine = m["machine"] as? String ?? ""
            let sessionId = m["session"] as? String ?? ""
            guard let d = m["data"] as? [String: Any] else { return }
            if d["kind"] as? String == "sessions" { onSessionsChanged?(machine); return }
            if let c = subs["\(machine):\(sessionId)"]?.c, let raw = try? JSONSerialization.data(withJSONObject: d) {
                c.yield(raw)
            }
        case "machine":
            guard let id = m["id"] as? String else { return }
            if m["removed"] as? Bool == true { machines.removeAll { $0.id == id }; return }
            if let mm = Self.machine(m) {
                if let i = machines.firstIndex(where: { $0.id == id }) { machines[i] = mm } else { machines.append(mm) }
            }
            if m["online"] as? Bool == false {
                // máy rớt: kết thúc các luồng phiên của máy đó -> SessionModel tự nối lại khi máy online
                for (k, sub) in subs where k.hasPrefix(id + ":") {
                    sub.c.finish(throwing: APIError(code: "OFFLINE", message: "Máy tính đang tắt hoặc mất mạng"))
                    subs[k] = nil
                }
            }
        case "error":
            if let code = m["code"] as? String, let pid = m["pid"] as? String {
                // tin lớn bị từ chối: báo cho lời gọi đang chờ (id nằm trong pid)
                if let c = pending.removeValue(forKey: pid) { c.resume(throwing: Self.apiError(code, m["message"] as? String)) }
            } else if let machine = m["machine"] as? String, let s = m["session"] as? String, let sub = subs.removeValue(forKey: "\(machine):\(s)") {
                sub.c.finish(throwing: Self.apiError(m["code"] as? String ?? "ERROR", m["message"] as? String))
            } else {
                lastError = m["message"] as? String
            }
        default:
            break
        }
    }

    /// Khung nhị phân: [4 byte độ dài phần đầu][phần đầu JSON][dữ liệu].
    private func handlePart(_ buf: Data) {
        guard buf.count >= 4 else { return }
        let b = [UInt8](buf.prefix(4))
        let n = Int(b[0]) << 24 | Int(b[1]) << 16 | Int(b[2]) << 8 | Int(b[3])
        guard n <= 4096, 4 + n <= buf.count,
              let h = (try? JSONSerialization.jsonObject(with: buf.subdata(in: 4..<(4 + n)))) as? [String: Any],
              let pid = h["pid"] as? String, let idx = h["idx"] as? Int else { return }
        let payload = buf.subdata(in: (4 + n)..<buf.count)
        var p = parts[pid] ?? (next: 0, data: Data())
        guard idx == p.next else { parts[pid] = nil; return }
        p.data.append(payload)
        p.next += 1
        guard p.data.count <= 50 * 1024 * 1024 else { parts[pid] = nil; return }
        if h["last"] as? Bool == true {
            parts[pid] = nil
            if var m = (try? JSONSerialization.jsonObject(with: p.data)) as? [String: Any] {
                if m["machine"] == nil, let mm = h["machine"] { m["machine"] = mm }
                if let d = try? JSONSerialization.data(withJSONObject: m) { handle(d) }
            }
        } else {
            parts[pid] = p
        }
    }

    // MARK: - gửi

    @discardableResult
    private func sendJSON(_ obj: [String: Any]) -> Bool {
        guard let task, let d = try? JSONSerialization.data(withJSONObject: obj) else { return false }
        if d.count <= Self.chunk, let s = String(data: d, encoding: .utf8) {
            task.send(.string(s)) { _ in }
            return true
        }
        // chia mảnh; machine nằm ở phần đầu để hub định tuyến không cần ghép
        let pid = (obj["id"] as? String) ?? UUID().uuidString
        var idx = 0
        var off = 0
        while off < d.count {
            let end = min(off + Self.chunk, d.count)
            var header: [String: Any] = ["type": "part", "pid": pid, "idx": idx, "last": end == d.count]
            if let m = obj["machine"] { header["machine"] = m }
            guard let hd = try? JSONSerialization.data(withJSONObject: header) else { return false }
            var frame = Data()
            let len = UInt32(hd.count).bigEndian
            withUnsafeBytes(of: len) { frame.append(contentsOf: $0) }
            frame.append(hd)
            frame.append(d.subdata(in: off..<end))
            task.send(.data(frame)) { _ in }
            off = end
            idx += 1
        }
        return true
    }

    /// Gọi một hàm trên máy tính (`machine`) hoặc của hub (`machine == "hub"`); trả JSON kết quả.
    func call(machine: String, method: String, params: [String: Any] = [:], timeout: Double = 40) async throws -> Data {
        if !connected { await ready() }
        guard connected else { throw APIError(code: "NETWORK", message: lastError ?? "Chưa kết nối được hub") }
        let id = UUID().uuidString
        return try await withCheckedThrowingContinuation { (c: CheckedContinuation<Data, Error>) in
            pending[id] = c
            guard sendJSON(["type": "req", "id": id, "machine": machine, "method": method, "params": params]) else {
                pending[id] = nil
                c.resume(throwing: APIError(code: "NETWORK", message: "Chưa kết nối được hub"))
                return
            }
            Task { @MainActor [weak self] in
                try? await Task.sleep(for: .seconds(timeout))
                if let c = self?.pending.removeValue(forKey: id) {
                    c.resume(throwing: APIError(code: "TIMEOUT", message: "Máy tính không phản hồi"))
                }
            }
        }
    }

    /// Theo dõi một phiên: phát lại sự kiện sau `after` rồi sự kiện mới (giống SSE của đường cũ).
    /// Mỗi luồng có token riêng: luồng cũ của cùng phiên kết thúc muộn (mở lại phiên, bấm thông báo khi đang xem)
    /// không được gỡ nhầm luồng mới — không thì màn phiên đứng im, không nhận sự kiện nữa.
    func subscribe(machine: String, session sid: String, after: Int, epoch: String) -> AsyncThrowingStream<Data, Error> {
        let key = "\(machine):\(sid)"
        let token = UUID()
        return AsyncThrowingStream { c in
            c.onTermination = { _ in
                Task { @MainActor in
                    guard self.subs[key]?.token == token else { return }
                    self.subs[key] = nil
                    self.sendJSON(["type": "unsub", "machine": machine, "session": sid])
                }
            }
            Task { @MainActor in
                self.subs[key]?.c.finish()
                self.subs[key] = (token: token, c: c)   // ghi trước khi chờ nối: thôi xem trong lúc chờ thì onTermination gỡ được
                if !self.connected { await self.ready() }
                guard self.subs[key]?.token == token else { return }   // đã thôi xem / bị luồng mới thay trong lúc chờ
                guard self.connected else {
                    self.subs[key] = nil
                    c.finish(throwing: APIError(code: "NETWORK", message: self.lastError ?? "Chưa kết nối được hub")); return
                }
                guard self.machines.contains(where: { $0.id == machine && $0.online }) else {
                    self.subs[key] = nil
                    c.finish(throwing: APIError(code: "OFFLINE", message: "Máy tính đang tắt hoặc mất mạng")); return
                }
                self.sendJSON(["type": "sub", "machine": machine, "session": sid, "after": after, "epoch": epoch])
            }
        }
    }

    // MARK: - tiện ích

    private static func machine(_ m: [String: Any]) -> HubMachine? {
        guard let id = m["id"] as? String else { return nil }
        return HubMachine(id: id, name: m["name"] as? String ?? "PC", online: m["online"] as? Bool ?? false, lastSeen: m["lastSeen"] as? Double)
    }

    static func apiError(_ code: String, _ message: String?) -> APIError {
        let msg = message ?? [
            "NOT_FOUND": "Không tìm thấy (máy đang tắt?)",
            "TIMEOUT": "Máy tính không phản hồi",
            "OFFLINE": "Máy tính vừa mất kết nối",
            "TOO_LARGE": "Tin nhắn quá lớn (tối đa 50 MB)",
        ][code] ?? "Lỗi \(code)"
        return APIError(code: code, message: msg)
    }
}

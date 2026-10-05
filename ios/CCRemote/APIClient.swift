import Foundation

struct APIError: LocalizedError {
    let code: String
    let message: String
    var errorDescription: String? { message }
}

private struct ErrorBody: Decodable {
    let error: String
    let message: String
}

/// Gọi hàm trên máy tính qua hub (`hub` + `machine`): đường dẫn kiểu REST được chuyển thành hàm của giao thức hub.
/// Không có `hub`: gọi HTTP thẳng tới hub (đăng nhập / đăng xuất).
struct APIClient {
    let base: String
    let token: String?
    var hub: HubClient? = nil
    var machine: String = ""

    /// Đường dẫn HTTP cũ -> (hàm, tham số) của giao thức hub (khớp httpRoute trong remote.js).
    static func rpc(_ method: String, _ path: String, _ body: [String: Any]?) throws -> (String, [String: Any]) {
        let comps = URLComponents(string: path)
        let p = comps?.path ?? path
        var params = body ?? [:]
        let fixed: [String: String] = [
            "GET /v1/state": "state", "GET /v1/projects": "projects", "GET /v1/projects/sessions": "projects.sessions",
            "GET /v1/capabilities": "capabilities", "POST /v1/sessions": "sessions.create",
            "POST /v1/accounts/switch": "accounts.switch", "POST /v1/always-on": "alwaysOn",
        ]
        if let m = fixed["\(method) \(p)"] {
            for q in comps?.queryItems ?? [] { params[q.name] = q.value ?? "" }
            return (m, params)
        }
        let seg = p.split(separator: "/").map(String.init)   // ["v1", "sessions", id, action?]
        if seg.count >= 3, seg[0] == "v1", seg[1] == "sessions", seg[2].count == 36 {
            params["id"] = seg[2]
            if seg.count == 3, method == "GET" { return ("sessions.get", params) }
            if seg.count == 4, method == "POST" { return ("sessions.\(seg[3])", params) }
        }
        throw APIError(code: "UNSUPPORTED", message: "Chức năng này chưa có khi kết nối qua hub")
    }

    static let session: URLSession = {
        let c = URLSessionConfiguration.default
        c.timeoutIntervalForRequest = 20
        c.requestCachePolicy = .reloadIgnoringLocalCacheData
        return URLSession(configuration: c)
    }()

    /// "hub.vidu.com" -> "https://hub.vidu.com", bỏ dấu / cuối.
    static func normalize(_ raw: String) -> String {
        var s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if !s.isEmpty && !s.lowercased().hasPrefix("http://") && !s.lowercased().hasPrefix("https://") {
            s = "https://" + s
        }
        while s.hasSuffix("/") { s.removeLast() }
        return s
    }

    func makeRequest(_ method: String, _ path: String, body: [String: Any]? = nil) throws -> URLRequest {
        guard let url = URL(string: base + path) else {
            throw APIError(code: "URL", message: "Địa chỉ máy tính không hợp lệ")
        }
        var req = URLRequest(url: url)
        req.httpMethod = method
        if let token { req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        if let body {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        return req
    }

    func call<T: Decodable>(_ method: String, _ path: String, body: [String: Any]? = nil, as type: T.Type = T.self) async throws -> T {
        if let hub {
            let (m, params) = try Self.rpc(method, path, body)
            let data = try await hub.call(machine: machine, method: m, params: params)
            do { return try JSONDecoder().decode(T.self, from: data) } catch {
                throw APIError(code: "DECODE", message: "Dữ liệu từ máy tính không đọc được — cập nhật tracker trên máy tính?")
            }
        }
        let req = try makeRequest(method, path, body: body)
        let data: Data
        let resp: URLResponse
        do {
            (data, resp) = try await Self.session.data(for: req)
        } catch let e as URLError {
            throw APIError(code: "NETWORK", message: Self.describe(e))
        }
        let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(code) else {
            if let e = try? JSONDecoder().decode(ErrorBody.self, from: data) {
                throw APIError(code: e.error, message: e.message)
            }
            throw APIError(code: "HTTP_\(code)", message: "Máy tính trả lỗi \(code)")
        }
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw APIError(code: "DECODE", message: "Dữ liệu từ máy tính không đọc được — cập nhật tool trên máy tính?")
        }
    }

    /// Theo dõi một phiên qua hub: phát lại sự kiện sau `after` rồi đẩy sự kiện mới.
    func events(session id: String, after: Int, epoch: String) -> AsyncThrowingStream<Data, Error> {
        guard let hub else {
            return AsyncThrowingStream { $0.finish(throwing: APIError(code: "UNPAIRED", message: "Chưa đăng nhập hub")) }
        }
        let machine = self.machine
        return AsyncThrowingStream { continuation in
            let task = Task { @MainActor in
                do {
                    for try await d in hub.subscribe(machine: machine, session: id, after: after, epoch: epoch) { continuation.yield(d) }
                    continuation.finish()
                } catch { continuation.finish(throwing: error) }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    static func describe(_ e: URLError) -> String {
        switch e.code {
        case .notConnectedToInternet: return "Điện thoại đang không có mạng"
        case .cannotFindHost, .dnsLookupFailed: return "Không tìm thấy hub — kiểm tra địa chỉ hub và mạng"
        case .cannotConnectToHost: return "Không kết nối được hub"
        case .timedOut: return "Hết thời gian chờ máy tính phản hồi"
        case .networkConnectionLost: return "Mất kết nối tới máy tính"
        case .secureConnectionFailed, .serverCertificateUntrusted, .serverCertificateHasBadDate:
            return "Lỗi HTTPS khi kết nối hub"
        case .cancelled: return "Đã huỷ"
        default: return e.localizedDescription
        }
    }
}

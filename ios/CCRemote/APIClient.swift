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

/// Gọi API của remote.js. Mọi request (trừ ping/pair) mang `Authorization: Bearer <token>`.
struct APIClient {
    let base: String
    let token: String?

    static let session: URLSession = {
        let c = URLSessionConfiguration.default
        c.timeoutIntervalForRequest = 20
        c.requestCachePolicy = .reloadIgnoringLocalCacheData
        return URLSession(configuration: c)
    }()

    /// Luồng SSE: server gửi nhịp 15 giây/lần nên 60 giây không có byte nào là mất kết nối.
    static let streamSession: URLSession = {
        let c = URLSessionConfiguration.default
        c.timeoutIntervalForRequest = 60
        c.timeoutIntervalForResource = 7 * 24 * 3600
        c.requestCachePolicy = .reloadIgnoringLocalCacheData
        return URLSession(configuration: c)
    }()

    /// "pc.tailnet.ts.net" -> "https://pc.tailnet.ts.net", bỏ dấu / cuối.
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

    /// Đọc SSE của một phiên: mỗi dòng `data: {...}` là một sự kiện JSON hoàn chỉnh.
    func events(session id: String, after: Int, epoch: String) -> AsyncThrowingStream<Data, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    let ep = epoch.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? ""
                    var req = try makeRequest("GET", "/v1/sessions/\(id)/events?after=\(after)&epoch=\(ep)")
                    req.setValue("text/event-stream", forHTTPHeaderField: "Accept")
                    let (bytes, resp) = try await Self.streamSession.bytes(for: req)
                    let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
                    guard code == 200 else {
                        throw APIError(code: "HTTP_\(code)", message: code == 404 ? "Không tìm thấy phiên" : code == 401 ? "Thiết bị chưa ghép hoặc đã bị thu hồi" : "Máy tính trả lỗi \(code)")
                    }
                    for try await line in bytes.lines {
                        if line.hasPrefix("data: ") {
                            continuation.yield(Data(line.dropFirst(6).utf8))
                        }
                    }
                    continuation.finish()
                } catch let e as URLError {
                    continuation.finish(throwing: APIError(code: "NETWORK", message: Self.describe(e)))
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    static func describe(_ e: URLError) -> String {
        switch e.code {
        case .notConnectedToInternet: return "Điện thoại đang không có mạng"
        case .cannotFindHost, .dnsLookupFailed: return "Không tìm thấy máy tính — Tailscale trên điện thoại đã bật chưa?"
        case .cannotConnectToHost: return "Máy tính không nhận kết nối — tracker có đang chạy không?"
        case .timedOut: return "Hết thời gian chờ máy tính phản hồi"
        case .networkConnectionLost: return "Mất kết nối tới máy tính"
        case .secureConnectionFailed, .serverCertificateUntrusted, .serverCertificateHasBadDate:
            return "Lỗi HTTPS — kiểm tra lại `tailscale serve` trên máy tính"
        case .cancelled: return "Đã huỷ"
        default: return e.localizedDescription
        }
    }
}

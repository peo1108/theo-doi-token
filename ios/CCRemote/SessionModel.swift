import Foundation
import Observation
import UIKit

/// Một phiên đang mở trên màn hình: giữ danh sách sự kiện và luồng SSE (tự nối lại khi rớt).
@MainActor
@Observable
final class SessionModel {
    let id: String
    var events: [Event] = []
    var summary: SessionSummary?
    var toolResults: [String: Event] = [:]
    var decisions: [String: String] = [:]
    var connected = false
    var lastError: String?
    var sending = false
    var scrollTick = 0

    private var epoch = ""
    private var lastSeq = 0
    private let decoder = JSONDecoder()

    init(id: String) { self.id = id }

    /// Sự kiện hiện trên màn hình (kết quả tool và quyết định được gộp vào thẻ tương ứng).
    var visible: [Event] {
        events.filter { $0.kind != "tool_result" && $0.kind != "decided" }
    }

    var status: String { summary?.status ?? "off" }
    var isBusy: Bool { status == "running" || status == "waiting" || status == "starting" }

    func run(api: APIClient) async {
        var delay: Double = 1
        while !Task.isCancelled {
            do {
                let stream = api.events(session: id, after: lastSeq, epoch: epoch)
                connected = true
                lastError = nil
                for try await data in stream {
                    handle(data)
                    delay = 1
                }
            } catch {
                if Task.isCancelled { break }
                lastError = (error as? APIError)?.message ?? error.localizedDescription
            }
            connected = false
            if Task.isCancelled { break }
            try? await Task.sleep(for: .seconds(delay))
            delay = min(delay * 2, 10)
        }
        connected = false
    }

    func handle(_ data: Data) {
        guard let head = try? decoder.decode(EventHead.self, from: data) else { return }
        switch head.kind {
        case "reset":
            events = []
            toolResults = [:]
            decisions = [:]
            lastSeq = 0
            epoch = head.epoch ?? ""
        case "state":
            if let s = try? decoder.decode(SessionSummary.self, from: data) {
                summary = s
                epoch = s.epoch
            }
        default:
            guard let e = try? decoder.decode(Event.self, from: data), e.seq > lastSeq else { return }
            append(e)
        }
    }

    private func append(_ e: Event) {
        events.append(e)
        lastSeq = e.seq
        switch e.kind {
        case "tool_result":
            if let tid = e.toolId { toolResults[tid] = e }
        case "decided":
            if let rid = e.requestId, let d = e.decision { decisions[rid] = d }
        case "permission", "limit":
            UINotificationFeedbackGenerator().notificationOccurred(.warning)
        case "result":
            if e.ok == true { UINotificationFeedbackGenerator().notificationOccurred(.success) }
        default:
            break
        }
        scrollTick += 1
    }

    private func post(_ api: APIClient, _ action: String, _ body: [String: Any] = [:]) async {
        do {
            let s: SessionSummary = try await api.call("POST", "/v1/sessions/\(id)/\(action)", body: body)
            summary = s
            lastError = nil
        } catch {
            lastError = (error as? APIError)?.message ?? error.localizedDescription
        }
    }

    func send(_ text: String, api: APIClient) async -> Bool {
        sending = true
        defer { sending = false }
        await post(api, "send", ["text": text])
        return lastError == nil
    }

    func decide(_ requestId: String, _ decision: String, answers: [String: String]? = nil, api: APIClient) async {
        var body: [String: Any] = ["requestId": requestId, "decision": decision]
        if let answers { body["answers"] = answers }
        await post(api, "permission", body)
    }

    func interrupt(api: APIClient) async { await post(api, "interrupt") }
    func setMode(_ mode: String, api: APIClient) async { await post(api, "mode", ["mode": mode]) }
    func setModel(_ model: String, api: APIClient) async { await post(api, "model", ["model": model]) }
    func close(api: APIClient) async { await post(api, "close") }
}

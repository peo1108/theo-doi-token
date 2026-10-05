import Foundation

// Dữ liệu từ remote.js (máy tính). Mọi trường có thể thiếu đều để Optional cho an toàn khi server đổi.

struct UsageBucket: Codable, Hashable {
    let pct: Double
    let resetsAt: Double?
}

struct Account: Codable, Identifiable, Hashable {
    let id: String
    let name: String
    let email: String?
    let plan: String?
    let active: Bool
    let suggested: Bool
    let loginState: String?
    let stale: Bool?
    let error: String?
    let fiveHour: UsageBucket?
    let sevenDay: UsageBucket?
    let costToday: Double?
}

struct AccountsInfo: Codable, Hashable {
    let active: String?
    let conflict: Bool
    let list: [Account]
}

struct Rate: Codable, Hashable {
    let status: String?
    let type: String?
    let resetsAt: Double?
    let fiveHour: Double?
    let sevenDay: Double?
}

struct SessionSummary: Codable, Identifiable, Hashable {
    let id: String
    let cwd: String?
    let project: String?
    let title: String?
    let status: String
    let live: Bool
    let pending: Int
    let mode: String
    let model: String?
    let rate: Rate?
    let cost: Double?
    let lastText: String?
    let updatedAt: Double
    let epoch: String
    let lastSeq: Int
    let watching: Int?
}

struct RecentSession: Codable, Identifiable, Hashable {
    let id: String
    let cwd: String
    let project: String
    let title: String
    let updatedAt: Double
}

struct NtfyConfig: Codable, Hashable {
    let server: String
    let topic: String
}

struct RemoteState: Codable {
    let version: Int
    let host: String
    let now: Double
    let live: [SessionSummary]
    let recent: [RecentSession]
    let accounts: AccountsInfo?
    let ntfy: NtfyConfig?
}

struct Project: Codable, Identifiable, Hashable {
    var id: String { cwd }
    let cwd: String
    let name: String
    let lastUsed: Double
}

struct QuestionOption: Codable, Hashable {
    let label: String
    let description: String
}

struct Question: Codable, Hashable {
    let question: String
    let header: String
    let multiSelect: Bool
    let options: [QuestionOption]
}

struct Suggest: Codable, Hashable {
    let id: String
    let name: String
}

/// Một sự kiện trong phiên (đã được server chuẩn hoá).
/// kind: user | assistant | tool | tool_result | permission | decided | result | note | error | limit
struct Event: Decodable, Identifiable, Hashable {
    let kind: String
    let seq: Int
    let t: Double?
    let text: String?
    let toolId: String?
    let name: String?
    let summary: String?
    let input: String?
    let error: Bool?
    let requestId: String?
    let tool: String?
    let canAlways: Bool?
    let reason: String?
    let questions: [Question]?
    let plan: String?
    let decision: String?
    let ok: Bool?
    let aborted: Bool?
    let cost: Double?
    let ms: Double?
    let turns: Int?
    let suggest: Suggest?
    let toolUseId: String?

    var id: Int { seq }

    enum CodingKeys: String, CodingKey {
        case kind, seq, t, text, toolId = "id", name, summary, input, error, requestId, tool, canAlways, reason
        case questions, plan, decision, ok, aborted, cost, ms, turns, suggest, toolUseId
    }
}

/// Chỉ đọc `kind` (và `epoch` của sự kiện reset) trước khi giải mã đầy đủ.
struct EventHead: Decodable {
    let kind: String
    let epoch: String?
}

struct PairResponse: Decodable {
    let token: String
    let deviceId: String
    let host: String?
}

struct PingResponse: Decodable {
    let ok: Bool
    let app: String?
    let version: Int?
    let authed: Bool?
}

struct SwitchResponse: Decodable {
    let ok: Bool
    let to: String?
    let restarted: [String]?
    let running: Int?
}

struct Ignored: Decodable {}

enum Route: Hashable {
    case session(String)
}

enum PermissionMode: String, CaseIterable, Identifiable {
    case `default`, acceptEdits, plan, bypassPermissions
    var id: String { rawValue }
    var label: String {
        switch self {
        case .default: return "Hỏi trước khi làm"
        case .acceptEdits: return "Tự sửa file"
        case .plan: return "Lập kế hoạch"
        case .bypassPermissions: return "Bỏ qua mọi quyền"
        }
    }
    var icon: String {
        switch self {
        case .default: return "hand.raised"
        case .acceptEdits: return "pencil"
        case .plan: return "list.bullet.clipboard"
        case .bypassPermissions: return "exclamationmark.shield"
        }
    }
}

struct ModelChoice: Identifiable, Hashable {
    let id: String
    let label: String
}

let modelChoices: [ModelChoice] = [
    ModelChoice(id: "", label: "Mặc định"),
    ModelChoice(id: "opus", label: "Opus"),
    ModelChoice(id: "sonnet", label: "Sonnet"),
    ModelChoice(id: "haiku", label: "Haiku"),
]

func statusInfo(_ status: String) -> (label: String, icon: String, color: String) {
    switch status {
    case "running": return ("Đang chạy", "bolt.fill", "blue")
    case "waiting": return ("Cần duyệt", "hand.raised.fill", "orange")
    case "idle": return ("Rảnh", "checkmark.circle", "green")
    case "starting": return ("Đang mở", "hourglass", "blue")
    default: return ("Đã tắt", "moon.zzz", "gray")
    }
}

func relativeTime(_ ms: Double) -> String {
    let f = RelativeDateTimeFormatter()
    f.locale = Locale(identifier: "vi_VN")
    f.unitsStyle = .short
    return f.localizedString(for: Date(timeIntervalSince1970: ms / 1000), relativeTo: Date())
}

func clockTime(_ ms: Double) -> String {
    let f = DateFormatter()
    f.locale = Locale(identifier: "vi_VN")
    let d = Date(timeIntervalSince1970: ms / 1000)
    f.dateFormat = Calendar.current.isDateInToday(d) ? "HH:mm" : "EEE HH:mm"
    return f.string(from: d)
}

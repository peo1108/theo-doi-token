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

struct SessionSettings: Codable, Hashable {
    let model: String?
    let modelValue: String?
    let modelLabel: String
    let effort: String?
    let thinking: Bool
    let flagSwitch: Bool
    let fast: Bool
    let outputStyle: String
}

struct ModelInfo: Codable, Identifiable, Hashable {
    var id: String { value }
    let value: String
    let label: String
    let description: String
    let resolved: String
    let efforts: [String]
    let thinking: Bool
    let fast: Bool
}

struct CommandInfo: Codable, Identifiable, Hashable {
    var id: String { name }
    let name: String
    let description: String
    let hint: String
}

struct CapsAccount: Codable, Hashable {
    let email: String
    let plan: String
}

/// Danh sách model, lệnh /, output style mà Claude Code trên máy hỗ trợ (từ initialize).
struct Capabilities: Codable {
    let models: [ModelInfo]
    let commands: [CommandInfo]
    let outputStyles: [String]
    let account: CapsAccount?
    let efforts: [String]
    let defaults: SessionSettings
}

func effortLabel(_ e: String?) -> String {
    switch e {
    case "low": return "Low"
    case "medium": return "Medium"
    case "high": return "High"
    case "xhigh": return "XHigh"
    case "max": return "Max"
    default: return "Mặc định"
    }
}

struct AskInfo: Codable, Hashable {
    let tool: String
    let summary: String
}

struct ThinkingInfo: Codable, Hashable {
    let tokens: Int
    let since: Double
}

struct SessionSummary: Codable, Identifiable, Hashable {
    let id: String
    let settings: SessionSettings?
    let account: String?
    let external: Bool?
    let source: String?
    let attached: Bool?
    let ready: Bool?
    let pcAway: Bool?
    let mirror: Bool?
    let thinking: ThinkingInfo?
    let ask: AskInfo?
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
    let projects: [Project]?
    let alwaysOn: Bool?
    let pcAway: Bool?
}

struct Project: Codable, Identifiable, Hashable {
    var id: String { cwd }
    let cwd: String
    let name: String
    let lastUsed: Double
    let count: Int?
    let lastTitle: String?
    let live: Int?
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
    let title: String?
    let path: String?
    let code: String?
    let oldText: String?
    let newText: String?
    let via: String?
    let seconds: Double?
    let tokens: Int?
    /// ảnh gửi từ điện thoại (ảnh nhỏ base64) hoặc ảnh Claude xem trên máy (không có ảnh nhỏ);
    /// ảnh đầy đủ lấy bằng sessions.image
    let images: [EventImage]?

    var id: Int { seq }

    enum CodingKeys: String, CodingKey {
        case kind, seq, t, text, toolId = "id", name, summary, input, error, requestId, tool, canAlways, reason
        case questions, plan, decision, ok, aborted, cost, ms, turns, suggest, toolUseId
        case title, path, code, oldText = "old", newText = "new", via, seconds, tokens, images
    }
}

/// Chỉ đọc `kind` (và `epoch` của sự kiện reset) trước khi giải mã đầy đủ.
struct EventHead: Decodable {
    let kind: String
    let epoch: String?
}

struct SwitchResponse: Decodable {
    let ok: Bool
    let to: String?
    let restarted: [String]?
    let running: Int?
}

struct Ignored: Decodable {}

struct EventImage: Decodable, Hashable {
    let name: String
    let thumb: String?
}

struct HubUser: Decodable {
    let id: Int
    let username: String
    let admin: Bool
}

struct HubLoginResponse: Decodable {
    let token: String
    let user: HubUser
}

struct HubDevice: Decodable, Identifiable {
    let id: String
    let name: String
    let lastSeen: Double?
    let current: Bool?
}

struct ImageData: Decodable {
    let mime: String
    let data: String
}

enum Route: Hashable {
    case session(String)
    case project(String)
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

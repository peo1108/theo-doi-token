import AVFoundation
import Foundation
import UIKit
import UserNotifications

/// Thông báo trên iPhone khi Claude hỏi, xong việc, bị dừng hoặc hết hạn mức.
/// App ký bằng ESign không dùng được APNs, nên app tự theo dõi máy tính (poll /v1/state) rồi bắn thông báo local;
/// khi ẩn app thì KeepAlive giữ app chạy nền để vẫn báo được lúc khoá màn hình.
@MainActor
final class Notifier: NSObject, UNUserNotificationCenterDelegate {
    static let shared = Notifier()

    weak var app: AppModel?
    /// phiên đang mở trên màn hình: không báo (m đang nhìn rồi)
    var activeSessionId: String?

    private struct Snap {
        let status: String
        let pending: Int
        let rejected: Bool
    }

    private var last: [String: Snap] = [:]
    private var primed = false

    var enabled: Bool {
        get { UserDefaults.standard.object(forKey: "notifyOn") as? Bool ?? true }
        set { UserDefaults.standard.set(newValue, forKey: "notifyOn") }
    }

    func setup(app: AppModel) {
        self.app = app
        UNUserNotificationCenter.current().delegate = self
    }

    @discardableResult
    func requestPermission() async -> Bool {
        (try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])) ?? false
    }

    func authorizationStatus() async -> UNAuthorizationStatus {
        await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
    }

    /// So trạng thái mới với lần trước, báo các thay đổi đáng chú ý.
    func process(_ state: RemoteState) {
        var next: [String: Snap] = [:]
        for s in state.live {
            let snap = Snap(status: s.status, pending: s.pending, rejected: s.rate?.status == "rejected")
            next[s.id] = snap
            guard primed, enabled, let old = last[s.id] else { continue }
            if watching(s.id) { continue }
            let title = s.title?.isEmpty == false ? s.title! : (s.project ?? "Phiên Claude")
            let wasBusy = old.status == "running" || old.status == "starting" || old.status == "waiting"

            if snap.pending > old.pending {
                let tool = s.ask?.tool ?? ""
                let head = tool == "AskUserQuestion" ? "🙋 Claude đang hỏi m"
                    : tool == "ExitPlanMode" ? "📋 Kế hoạch chờ duyệt"
                    : "✋ Claude cần m duyệt \(tool)"
                post(head, "\(title)\n\(s.ask?.summary ?? "")", s.id)
            } else if !old.rejected && snap.rejected {
                post("⚠️ Hết hạn mức", "\(title) — mở app để đổi tài khoản và chạy tiếp", s.id)
            } else if wasBusy && s.status == "idle" {
                post("✅ Xong việc", "\(title)\n\(s.lastText ?? "")", s.id)
            } else if wasBusy && s.status == "off" {
                post("⏹ Claude đã dừng", title, s.id)
            }
        }
        last = next
        primed = true
    }

    private func watching(_ id: String) -> Bool {
        activeSessionId == id && UIApplication.shared.applicationState == .active
    }

    private func post(_ title: String, _ body: String, _ sid: String) {
        let c = UNMutableNotificationContent()
        c.title = title
        c.body = String(body.prefix(240))
        c.sound = .default
        c.threadIdentifier = sid
        c.userInfo = ["sid": sid]
        UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: UUID().uuidString, content: c, trigger: nil))
    }

    // đang mở app vẫn hiện banner
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                            withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .sound, .list])
    }

    // bấm vào thông báo -> mở đúng phiên
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                            withCompletionHandler completionHandler: @escaping () -> Void) {
        let sid = response.notification.request.content.userInfo["sid"] as? String
        Task { @MainActor in
            if let sid, let url = URL(string: "ccremote://session/\(sid)") { Notifier.shared.app?.open(url: url) }
            completionHandler()
        }
    }
}

/// Giữ app chạy nền bằng âm thanh im lặng (không làm gián đoạn nhạc đang phát), để vẫn theo dõi và báo khi khoá màn hình.
@MainActor
final class KeepAlive {
    static let shared = KeepAlive()
    private var player: AVAudioPlayer?
    private var observer: NSObjectProtocol?

    var enabled: Bool {
        get { UserDefaults.standard.object(forKey: "keepAlive") as? Bool ?? true }
        set { UserDefaults.standard.set(newValue, forKey: "keepAlive"); if !newValue { stop() } }
    }

    func start() {
        guard enabled, player == nil else { return }
        let session = AVAudioSession.sharedInstance()
        try? session.setCategory(.playback, options: [.mixWithOthers])
        try? session.setActive(true)
        guard let p = try? AVAudioPlayer(data: Self.silentWav()) else { return }
        p.numberOfLoops = -1
        p.play()
        player = p
        // bị cuộc gọi / app khác ngắt -> phát lại khi xong
        observer = NotificationCenter.default.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { note in
            let type = (note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt).flatMap(AVAudioSession.InterruptionType.init)
            if type == .ended { Task { @MainActor in KeepAlive.shared.player?.play() } }
        }
    }

    func stop() {
        player?.stop()
        player = nil
        if let observer { NotificationCenter.default.removeObserver(observer) }
        observer = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    /// 1 giây im lặng, WAV 8 kHz mono 16-bit.
    static func silentWav() -> Data {
        let rate: UInt32 = 8000
        let samples = Int(rate)
        let dataSize = UInt32(samples * 2)
        var d = Data()
        func u32(_ v: UInt32) { var x = v.littleEndian; d.append(Data(bytes: &x, count: 4)) }
        func u16(_ v: UInt16) { var x = v.littleEndian; d.append(Data(bytes: &x, count: 2)) }
        d.append("RIFF".data(using: .ascii)!); u32(36 + dataSize); d.append("WAVE".data(using: .ascii)!)
        d.append("fmt ".data(using: .ascii)!); u32(16); u16(1); u16(1); u32(rate); u32(rate * 2); u16(2); u16(16)
        d.append("data".data(using: .ascii)!); u32(dataSize)
        d.append(Data(count: Int(dataSize)))
        return d
    }
}

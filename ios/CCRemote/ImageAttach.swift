import SwiftUI
import PhotosUI
import UIKit

/// Ảnh đang đính kèm trong ô nhắn (chưa gửi).
struct PickedImage: Identifiable {
    let id = UUID()
    let image: UIImage
}

enum ImagePrep {
    static let maxSide: CGFloat = 2000
    static let thumbSide: CGFloat = 256
    static let maxCount = 10
    /// Cài đặt: gửi ảnh gốc (không thu nhỏ)
    static var sendOriginal: Bool {
        get { UserDefaults.standard.bool(forKey: "sendOriginal") }
        set { UserDefaults.standard.set(newValue, forKey: "sendOriginal") }
    }

    static func resized(_ img: UIImage, maxSide: CGFloat) -> UIImage {
        let w = img.size.width, h = img.size.height
        let scale = min(1, maxSide / max(w, h, 1))
        if scale >= 1 && img.imageOrientation == .up { return img }
        let size = CGSize(width: (w * scale).rounded(), height: (h * scale).rounded())
        let fmt = UIGraphicsImageRendererFormat.default()
        fmt.scale = 1
        return UIGraphicsImageRenderer(size: size, format: fmt).image { _ in img.draw(in: CGRect(origin: .zero, size: size)) }
    }

    /// Ảnh -> {mime, data, name, thumb} gửi cho máy tính (JPEG; cạnh dài ≤ 2000 px trừ khi bật "Gửi ảnh gốc").
    static func payload(_ img: UIImage, index: Int) -> [String: Any]? {
        let full = sendOriginal ? resized(img, maxSide: .greatestFiniteMagnitude) : resized(img, maxSide: maxSide)
        guard let data = full.jpegData(compressionQuality: sendOriginal ? 0.95 : 0.85),
              let thumb = resized(img, maxSide: thumbSide).jpegData(compressionQuality: 0.6) else { return nil }
        return ["mime": "image/jpeg", "data": data.base64EncodedString(), "name": "anh-\(index + 1).jpg", "thumb": thumb.base64EncodedString()]
    }

    static func image(base64: String?) -> UIImage? {
        guard let s = base64, let d = Data(base64Encoded: s) else { return nil }
        return UIImage(data: d)
    }
}

/// Chụp ảnh bằng camera (UIImagePickerController).
struct CameraPicker: UIViewControllerRepresentable {
    let onPick: (UIImage) -> Void
    @Environment(\.dismiss) private var dismiss

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let p = UIImagePickerController()
        p.sourceType = UIImagePickerController.isSourceTypeAvailable(.camera) ? .camera : .photoLibrary
        p.delegate = context.coordinator
        return p
    }

    func updateUIViewController(_ vc: UIImagePickerController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let parent: CameraPicker
        init(_ parent: CameraPicker) { self.parent = parent }

        func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            if let img = info[.originalImage] as? UIImage { parent.onPick(img) }
            parent.dismiss()
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) { parent.dismiss() }
    }
}

/// Dải ảnh đã chọn phía trên ô nhắn (bấm × để bỏ).
struct AttachmentStrip: View {
    @Binding var picks: [PickedImage]

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(picks) { p in
                    Image(uiImage: p.image)
                        .resizable()
                        .scaledToFill()
                        .frame(width: 58, height: 58)
                        .clipShape(RoundedRectangle(cornerRadius: 8))
                        .overlay(alignment: .topTrailing) {
                            Button {
                                picks.removeAll { $0.id == p.id }
                            } label: {
                                Image(systemName: "xmark.circle.fill").font(.system(size: 18)).symbolRenderingMode(.palette)
                                    .foregroundStyle(.white, .black.opacity(0.6))
                            }
                            .offset(x: 5, y: -5)
                        }
                }
            }
            .padding(.horizontal, 14).padding(.top, 8)
        }
    }
}

/// Ảnh nhỏ trong lời nhắn; bấm để xem ảnh đầy đủ (lấy từ máy tính).
struct EventImages: View {
    let images: [EventImage]
    let sessionId: String
    @Environment(AppModel.self) private var app
    @State private var shown: UIImage?
    @State private var loading = false

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                ForEach(images, id: \.name) { im in
                    Button {
                        Task { await open(im) }
                    } label: {
                        Group {
                            if let t = ImagePrep.image(base64: im.thumb) {
                                Image(uiImage: t).resizable().scaledToFill()
                            } else {
                                Image(systemName: "photo").foregroundStyle(.secondary)
                            }
                        }
                        .frame(width: 72, height: 72)
                        .background(Color(.tertiarySystemBackground))
                        .clipShape(RoundedRectangle(cornerRadius: 8))
                    }
                    .buttonStyle(.plain)
                }
                if loading { ProgressView() }
            }
        }
        .sheet(isPresented: Binding(get: { shown != nil }, set: { if !$0 { shown = nil } })) {
            if let shown {
                ScrollView([.horizontal, .vertical]) { Image(uiImage: shown).resizable().scaledToFit() }
                    .presentationDragIndicator(.visible)
            }
        }
    }

    private func open(_ im: EventImage) async {
        guard let api = app.api else { return }
        loading = true
        defer { loading = false }
        if let r: ImageData = try? await api.call("POST", "/v1/sessions/\(sessionId)/image", body: ["name": im.name]),
           let img = ImagePrep.image(base64: r.data) {
            shown = img
        } else {
            shown = ImagePrep.image(base64: im.thumb)
        }
    }
}

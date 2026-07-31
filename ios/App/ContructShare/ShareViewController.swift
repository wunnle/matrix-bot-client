//
//  ShareViewController.swift
//  ContructShare
//
//  Custom share UI (WhatsApp-style): full-screen dark, a large preview of what
//  you're sharing, an X to close (top-left), a caption field, and a recipient
//  chip + circular Send at the bottom. Targets the picked room (from the
//  share-sheet suggestion) or the default. Sends in the background over the same
//  routes the app uses, reading the intent secret from the App Group.
//
//  We only call completeRequest once the upload finishes, so the extension
//  isn't suspended mid-send. Images are decoded + downsampled via ImageIO to
//  stay inside the share extension's small memory budget.
//

import UIKit
import UniformTypeIdentifiers
import ImageIO
import Intents

class ShareViewController: UIViewController {

    private enum Shared {
        static let appGroup = "group.com.wunnle.construct"
        static let secret = "construct.intentSecret"
        static let apiBase = "construct.apiBase"
        static let room = "construct.defaultRoom"
        static let defaultApiBase = "https://construct.kafagoz.com"
        static let defaultRoom = "!DpRWqhWOHJAxyvjOGI:matrix.org"
    }

    // Extracted content
    private var sharedString: String?   // text or URL
    private var imageFileURL: URL?      // local copy of the shared image

    // UI
    private let closeButton = UIButton(type: .system)
    private let previewImage = UIImageView()
    private let textPreview = UILabel()
    private let captionField = UITextField()
    private let recipientChip = PaddingLabel()
    private let sendButton = UIButton(type: .system)
    private let spinner = UIActivityIndicatorView(style: .medium)
    private var bottomStackBottom: NSLayoutConstraint!

    override func viewDidLoad() {
        super.viewDidLoad()
        buildUI()
        loadSharedContent()
        NotificationCenter.default.addObserver(self, selector: #selector(keyboardWillChange(_:)),
                                               name: UIResponder.keyboardWillChangeFrameNotification, object: nil)
    }

    // MARK: - UI

    private func buildUI() {
        view.backgroundColor = UIColor(red: 0.04, green: 0.04, blue: 0.05, alpha: 1)

        closeButton.setImage(UIImage(systemName: "xmark", withConfiguration:
            UIImage.SymbolConfiguration(pointSize: 15, weight: .semibold)), for: .normal)
        closeButton.tintColor = .white
        closeButton.backgroundColor = UIColor.white.withAlphaComponent(0.16)
        closeButton.layer.cornerRadius = 18
        closeButton.translatesAutoresizingMaskIntoConstraints = false
        closeButton.addTarget(self, action: #selector(cancel), for: .touchUpInside)
        view.addSubview(closeButton)

        previewImage.contentMode = .scaleAspectFit
        previewImage.clipsToBounds = true
        previewImage.layer.cornerRadius = 14
        previewImage.isHidden = true
        previewImage.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(previewImage)

        textPreview.font = .systemFont(ofSize: 17)
        textPreview.textColor = .white
        textPreview.numberOfLines = 0
        textPreview.textAlignment = .center
        textPreview.isHidden = true
        textPreview.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(textPreview)

        captionField.placeholder = "Add a caption…"
        captionField.attributedPlaceholder = NSAttributedString(
            string: "Add a caption…",
            attributes: [.foregroundColor: UIColor.white.withAlphaComponent(0.4)])
        captionField.font = .systemFont(ofSize: 16)
        captionField.textColor = .white
        captionField.backgroundColor = UIColor.white.withAlphaComponent(0.08)
        captionField.layer.cornerRadius = 20
        captionField.leftView = UIView(frame: CGRect(x: 0, y: 0, width: 16, height: 1))
        captionField.leftViewMode = .always
        captionField.rightView = UIView(frame: CGRect(x: 0, y: 0, width: 16, height: 1))
        captionField.rightViewMode = .always
        captionField.heightAnchor.constraint(equalToConstant: 44).isActive = true
        captionField.returnKeyType = .send
        captionField.addTarget(self, action: #selector(send), for: .editingDidEndOnExit)

        recipientChip.font = .systemFont(ofSize: 15, weight: .medium)
        recipientChip.textColor = .white
        recipientChip.backgroundColor = UIColor.white.withAlphaComponent(0.12)
        recipientChip.layer.cornerRadius = 18
        recipientChip.clipsToBounds = true
        recipientChip.insets = UIEdgeInsets(top: 8, left: 14, bottom: 8, right: 14)
        recipientChip.text = pickedRoomName ?? "Construct"
        recipientChip.setContentHuggingPriority(.required, for: .horizontal)

        sendButton.setImage(UIImage(systemName: "arrow.up", withConfiguration:
            UIImage.SymbolConfiguration(pointSize: 17, weight: .bold)), for: .normal)
        sendButton.tintColor = .white
        sendButton.backgroundColor = UIColor(red: 0.49, green: 0.42, blue: 0.97, alpha: 1)
        sendButton.layer.cornerRadius = 21
        sendButton.translatesAutoresizingMaskIntoConstraints = false
        sendButton.widthAnchor.constraint(equalToConstant: 42).isActive = true
        sendButton.heightAnchor.constraint(equalToConstant: 42).isActive = true
        sendButton.addTarget(self, action: #selector(send), for: .touchUpInside)

        spinner.color = .white
        spinner.hidesWhenStopped = true

        let bottomRow = UIStackView(arrangedSubviews: [recipientChip, UIView(), spinner, sendButton])
        bottomRow.axis = .horizontal
        bottomRow.spacing = 12
        bottomRow.alignment = .center

        let bottomStack = UIStackView(arrangedSubviews: [captionField, bottomRow])
        bottomStack.axis = .vertical
        bottomStack.spacing = 14
        bottomStack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(bottomStack)

        let g = view.safeAreaLayoutGuide
        bottomStackBottom = bottomStack.bottomAnchor.constraint(equalTo: g.bottomAnchor, constant: -12)
        NSLayoutConstraint.activate([
            closeButton.topAnchor.constraint(equalTo: g.topAnchor, constant: 8),
            closeButton.trailingAnchor.constraint(equalTo: g.trailingAnchor, constant: -16),
            closeButton.widthAnchor.constraint(equalToConstant: 36),
            closeButton.heightAnchor.constraint(equalToConstant: 36),

            bottomStack.leadingAnchor.constraint(equalTo: g.leadingAnchor, constant: 16),
            bottomStack.trailingAnchor.constraint(equalTo: g.trailingAnchor, constant: -16),
            bottomStackBottom,

            previewImage.topAnchor.constraint(equalTo: closeButton.bottomAnchor, constant: 16),
            previewImage.leadingAnchor.constraint(equalTo: g.leadingAnchor, constant: 16),
            previewImage.trailingAnchor.constraint(equalTo: g.trailingAnchor, constant: -16),
            previewImage.bottomAnchor.constraint(equalTo: bottomStack.topAnchor, constant: -16),

            textPreview.leadingAnchor.constraint(equalTo: g.leadingAnchor, constant: 32),
            textPreview.trailingAnchor.constraint(equalTo: g.trailingAnchor, constant: -32),
            textPreview.centerYAnchor.constraint(equalTo: previewImage.centerYAnchor),
        ])
    }

    @objc private func keyboardWillChange(_ note: Notification) {
        guard let frame = (note.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? NSValue)?.cgRectValue else { return }
        let overlap = max(0, view.bounds.height - view.convert(frame, from: nil).origin.y)
        bottomStackBottom.constant = overlap > 0 ? -(overlap + 8) : -12
        UIView.animate(withDuration: 0.25) { self.view.layoutIfNeeded() }
    }

    // MARK: - Extract shared content (for preview + send)

    private var provider: NSItemProvider? {
        (extensionContext?.inputItems.first as? NSExtensionItem)?.attachments?.first
    }

    private func loadSharedContent() {
        guard let provider else { showText("Nothing to share"); return }
        let urlType = UTType.url.identifier
        let textType = UTType.text.identifier

        if let imageUTI = provider.registeredTypeIdentifiers.first(where: { UTType($0)?.conforms(to: .image) == true }) {
            provider.loadFileRepresentation(forTypeIdentifier: imageUTI) { [weak self] url, _ in
                guard let self, let url else { return }
                let dest = FileManager.default.temporaryDirectory.appendingPathComponent("share-\(UUID().uuidString)")
                try? FileManager.default.copyItem(at: url, to: dest)
                let preview = Self.thumbnail(from: dest, maxPixel: 1400)
                DispatchQueue.main.async {
                    self.imageFileURL = dest
                    self.previewImage.image = preview
                    self.previewImage.isHidden = (preview == nil)
                }
            }
        } else if provider.hasItemConformingToTypeIdentifier(urlType) {
            provider.loadItem(forTypeIdentifier: urlType, options: nil) { [weak self] obj, _ in
                let link = (obj as? URL)?.absoluteString ?? ""
                DispatchQueue.main.async { self?.sharedString = link; self?.showText(link) }
            }
        } else if provider.hasItemConformingToTypeIdentifier(textType) {
            provider.loadItem(forTypeIdentifier: textType, options: nil) { [weak self] obj, _ in
                let text = (obj as? String) ?? ""
                DispatchQueue.main.async { self?.sharedString = text; self?.showText(text) }
            }
        } else {
            showText("Unsupported item")
        }
    }

    private func showText(_ text: String) {
        textPreview.text = text
        textPreview.isHidden = false
    }

    // MARK: - Actions

    @objc private func cancel() {
        extensionContext?.cancelRequest(withError: NSError(domain: NSCocoaErrorDomain, code: NSUserCancelledError))
    }

    @objc private func send() {
        let note = (captionField.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        captionField.resignFirstResponder()
        sendButton.isHidden = true
        closeButton.isEnabled = false
        spinner.startAnimating()

        let finish = { [weak self] in
            DispatchQueue.main.async {
                self?.extensionContext?.completeRequest(returningItems: [], completionHandler: nil)
            }
        }

        if let fileURL = imageFileURL, let jpeg = Self.downsampledJPEG(from: fileURL, maxPixel: 2048) {
            sendImage(jpeg) { [weak self] in
                note.isEmpty ? finish() : self?.sendText(note, then: finish)
            }
        } else {
            let text = [note, sharedString ?? ""].filter { !$0.isEmpty }.joined(separator: "\n")
            text.isEmpty ? finish() : sendText(text, then: finish)
        }
    }

    // MARK: - Sending (App Group secret; complete-when-done)

    private var suite: UserDefaults? { UserDefaults(suiteName: Shared.appGroup) }

    private var pickedRoomId: String? {
        (extensionContext?.intent as? INSendMessageIntent)?.conversationIdentifier
    }
    private var pickedRoomName: String? {
        (extensionContext?.intent as? INSendMessageIntent)?.speakableGroupName?.spokenPhrase
    }

    private func creds() -> (secret: String, apiBase: String, room: String)? {
        guard let secret = suite?.string(forKey: Shared.secret), !secret.isEmpty else { return nil }
        let apiBase = suite?.string(forKey: Shared.apiBase) ?? Shared.defaultApiBase
        let room = pickedRoomId ?? suite?.string(forKey: Shared.room) ?? Shared.defaultRoom
        return (secret, apiBase, room)
    }

    private func sendText(_ message: String, then: @escaping () -> Void) {
        let text = message.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, let c = creds(),
              let url = URL(string: "\(c.apiBase)/api/send-message"),
              let body = try? JSONSerialization.data(withJSONObject:
                ["room": c.room, "text": text, "source": "share"]) else { then(); return }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue(c.secret, forHTTPHeaderField: "x-intent-secret")
        req.httpBody = body
        req.timeoutInterval = 25
        URLSession.shared.dataTask(with: req) { _, _, _ in then() }.resume()
    }

    private func sendImage(_ jpeg: Data, then: @escaping () -> Void) {
        guard let c = creds() else { then(); return }
        let allowed = CharacterSet.alphanumerics
        let room = c.room.addingPercentEncoding(withAllowedCharacters: allowed) ?? c.room
        guard let url = URL(string:
            "\(c.apiBase)/api/send-file?room=\(room)&filename=shared.jpg&source=share") else { then(); return }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("image/jpeg", forHTTPHeaderField: "Content-Type")
        req.setValue(c.secret, forHTTPHeaderField: "x-intent-secret")
        req.httpBody = jpeg
        req.timeoutInterval = 25
        URLSession.shared.dataTask(with: req) { _, _, _ in then() }.resume()
    }

    // MARK: - ImageIO helpers (memory-safe)

    private static func thumbnail(from url: URL, maxPixel: CGFloat) -> UIImage? {
        guard let src = CGImageSourceCreateWithURL(url as CFURL, nil) else { return nil }
        let opts: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: maxPixel,
        ]
        guard let cg = CGImageSourceCreateThumbnailAtIndex(src, 0, opts as CFDictionary) else { return nil }
        return UIImage(cgImage: cg)
    }

    private static func downsampledJPEG(from url: URL, maxPixel: CGFloat) -> Data? {
        guard let source = CGImageSourceCreateWithURL(url as CFURL,
                [kCGImageSourceShouldCache: false] as CFDictionary) else { return nil }
        let thumbOptions: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: maxPixel,
        ]
        guard let thumb = CGImageSourceCreateThumbnailAtIndex(source, 0, thumbOptions as CFDictionary) else { return nil }
        let data = NSMutableData()
        guard let dest = CGImageDestinationCreateWithData(data, UTType.jpeg.identifier as CFString, 1, nil) else { return nil }
        CGImageDestinationAddImage(dest, thumb, [kCGImageDestinationLossyCompressionQuality: 0.8] as CFDictionary)
        guard CGImageDestinationFinalize(dest) else { return nil }
        return data as Data
    }
}

/// Label with content insets — used for the pill-shaped recipient chip.
final class PaddingLabel: UILabel {
    var insets = UIEdgeInsets.zero
    override func drawText(in rect: CGRect) { super.drawText(in: rect.inset(by: insets)) }
    override var intrinsicContentSize: CGSize {
        let s = super.intrinsicContentSize
        return CGSize(width: s.width + insets.left + insets.right, height: s.height + insets.top + insets.bottom)
    }
}

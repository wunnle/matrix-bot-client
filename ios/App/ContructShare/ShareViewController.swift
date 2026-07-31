//
//  ShareViewController.swift
//  ContructShare
//
//  Share-sheet target: sends the shared text / URL / image (plus the optional
//  note the user types) to bender via the same routes the app uses, reading the
//  intent secret from the shared App Group. No app launch.
//
//  The share extension is suspended the instant the sheet dismisses, which
//  killed uploads mid-flight (tiny text made it in the grace period, a multi-MB
//  image did not). So we DON'T call completeRequest until the upload finishes:
//  the compose sheet stays up (with its progress spinner) and the extension
//  stays in the foreground, so the request just completes normally.
//

import UIKit
import Social
import UniformTypeIdentifiers
import ImageIO
import Intents

class ShareViewController: SLComposeServiceViewController {

    private enum Shared {
        static let appGroup = "group.com.wunnle.construct"
        static let secret = "construct.intentSecret"
        static let apiBase = "construct.apiBase"
        static let room = "construct.defaultRoom"
        static let defaultApiBase = "https://construct.kafagoz.com"
        static let defaultRoom = "!DpRWqhWOHJAxyvjOGI:matrix.org"
    }

    override func isContentValid() -> Bool { true }

    override func didSelectPost() {
        let note = (contentText ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let provider = (extensionContext?.inputItems.first as? NSExtensionItem)?.attachments?.first

        // Only complete once the upload is done — see the file header. Until
        // then the sheet stays up and the extension isn't suspended.
        process(provider: provider, note: note) { [weak self] in
            DispatchQueue.main.async {
                self?.extensionContext?.completeRequest(returningItems: [], completionHandler: nil)
            }
        }
    }

    override func configurationItems() -> [Any]! { [] }

    // MARK: - Extract the shared item, then send (calls `completion` when done)

    private func process(provider: NSItemProvider?, note: String, completion: @escaping () -> Void) {
        guard let provider else {
            note.isEmpty ? completion() : sendText(note, then: completion)
            return
        }
        let urlType = UTType.url.identifier
        let textType = UTType.text.identifier

        let imageUTI = provider.registeredTypeIdentifiers.first { UTType($0)?.conforms(to: .image) == true }
        if let imageUTI {
            provider.loadFileRepresentation(forTypeIdentifier: imageUTI) { [weak self] url, err in
                guard let self else { completion(); return }
                // Decode-and-downsample straight from the file via ImageIO.
                // Loading the full-res photo into a UIImage blows the share
                // extension's tiny memory budget and it gets jetsammed before
                // it can send anything.
                guard let url, let jpeg = Self.downsampledJPEG(from: url, maxPixel: 2048) else {
                    _ = err
                    completion()
                    return
                }
                let sendNote = { note.isEmpty ? completion() : self.sendText(note, then: completion) }
                self.sendImage(jpeg, then: sendNote)
            }
        } else if provider.hasItemConformingToTypeIdentifier(urlType) {
            provider.loadItem(forTypeIdentifier: urlType, options: nil) { [weak self] obj, _ in
                let link = (obj as? URL)?.absoluteString ?? ""
                self?.sendText([note, link].filter { !$0.isEmpty }.joined(separator: "\n"), then: completion)
            }
        } else if provider.hasItemConformingToTypeIdentifier(textType) {
            provider.loadItem(forTypeIdentifier: textType, options: nil) { [weak self] obj, _ in
                let shared = (obj as? String) ?? ""
                self?.sendText([note, shared].filter { !$0.isEmpty }.joined(separator: "\n"), then: completion)
            }
        } else {
            note.isEmpty ? completion() : sendText(note, then: completion)
        }
    }

    /// Decodes `url` at a reduced size and re-encodes to JPEG, entirely through
    /// ImageIO so a full-res bitmap is never held in memory — essential inside
    /// the share extension's small memory budget.
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
        CGImageDestinationAddImage(dest, thumb,
            [kCGImageDestinationLossyCompressionQuality: 0.8] as CFDictionary)
        guard CGImageDestinationFinalize(dest) else { return nil }
        return data as Data
    }

    // MARK: - Sending

    private var suite: UserDefaults? { UserDefaults(suiteName: Shared.appGroup) }

    /// If launched from a share-sheet suggestion (a donated room), that room's
    /// id rides in on the intent's conversationIdentifier; otherwise nil and we
    /// fall back to the default room.
    private var pickedRoomId: String? {
        (extensionContext?.intent as? INSendMessageIntent)?.conversationIdentifier
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
}

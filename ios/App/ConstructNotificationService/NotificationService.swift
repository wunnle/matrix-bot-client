//
//  NotificationService.swift
//  ConstructNotificationService
//
//  Rewrites an incoming message push into a *communication notification* so the
//  banner shows the room's round avatar (à la Messages/WhatsApp) instead of the
//  app icon. The push gateway sets `mutable-content: 1` and an `avatarUrl`
//  (see api/matrix-push.js); we download that avatar, hang it on an
//  INSendMessageIntent whose sender is the room, and update the content from it.
//
//  Anything that goes wrong — no avatar, download failure, missing Communication
//  Notifications entitlement — falls back to delivering the plain alert
//  untouched, so a message is never lost to a decoration step.
//
import Intents
import UserNotifications
import ImageIO
import UIKit

/// Writer half of the Live Activity avatar cache, duplicated from the app
/// target (AppDelegate.swift) — separate processes with no shared module, so
/// the path scheme has to stay identical. Worth having here as well as in the
/// app: this extension runs for rooms the app has never opened, which is
/// exactly when the gateway starts a Live Activity for one.
private enum AvatarCache {
    static let appGroup = "group.com.wunnle.construct"

    static func fileName(for roomId: String) -> String {
        String(roomId.map { $0.isLetter || $0.isNumber ? $0 : "_" }) + ".png"
    }

    static func write(_ data: Data, roomId: String) {
        // The proxy serves the avatar at full resolution, and the reader is a
        // Live Activity with a tiny memory budget — store a bounded thumbnail
        // rather than whatever arrived, so rendering can't be killed for it.
        guard !roomId.isEmpty, let png = downsampledPNG(data, maxPixel: 180),
              let dir = FileManager.default
                .containerURL(forSecurityApplicationGroupIdentifier: appGroup)?
                .appendingPathComponent("avatars", isDirectory: true)
        else { return }
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        try? png.write(to: dir.appendingPathComponent(fileName(for: roomId)), options: .atomic)
    }

    /// ImageIO rather than UIImage: this decodes straight to the target size
    /// instead of expanding the original in memory first (the same reason the
    /// share extension downsamples).
    private static func downsampledPNG(_ data: Data, maxPixel: Int) -> Data? {
        guard !data.isEmpty,
              let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: maxPixel,
        ]
        guard let thumb = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary)
        else { return nil }
        return UIImage(cgImage: thumb).pngData()
    }
}

final class NotificationService: UNNotificationServiceExtension {
  private var contentHandler: ((UNNotificationContent) -> Void)?
  private var bestAttempt: UNMutableNotificationContent?
  private var task: URLSessionDataTask?

  override func didReceive(
    _ request: UNNotificationRequest,
    withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
  ) {
    self.contentHandler = contentHandler
    let best = request.content.mutableCopy() as? UNMutableNotificationContent
    self.bestAttempt = best

    guard let best else { contentHandler(request.content); return }

    let info = best.userInfo
    let roomId = info["roomId"] as? String ?? request.identifier
    // The alert title is already the best display name (sender, falling back to
    // the room); reuse it as the communication sender's name.
    let senderName = best.title.isEmpty ? "Message" : best.title

    guard let urlString = info["avatarUrl"] as? String, let url = URL(string: urlString) else {
      // No avatar to show — deliver the alert as-is.
      contentHandler(best)
      return
    }

    // Download the avatar, then rebuild the notification as a communication one.
    var req = URLRequest(url: url)
    req.timeoutInterval = 12
    task = URLSession.shared.dataTask(with: req) { [weak self] data, _, _ in
      guard let self else { return }
      // Keep a copy for the Live Activity, which has no way to fetch its own.
      if let data { AvatarCache.write(data, roomId: roomId) }
      let image = data.flatMap { INImage(imageData: $0) }
      self.deliver(communicationFrom: best, roomId: roomId, senderName: senderName, avatar: image)
    }
    task?.resume()
  }

  /// Build + donate the INSendMessageIntent and hand the updated content back.
  private func deliver(
    communicationFrom best: UNMutableNotificationContent,
    roomId: String,
    senderName: String,
    avatar: INImage?
  ) {
    let handler = contentHandler
    // Model the room as the message sender so the banner shows its avatar/name.
    let sender = INPerson(
      personHandle: INPersonHandle(value: roomId, type: .unknown),
      nameComponents: nil,
      displayName: senderName,
      image: avatar,
      contactIdentifier: nil,
      customIdentifier: roomId
    )
    let intent = INSendMessageIntent(
      recipients: nil,
      outgoingMessageType: .outgoingMessageText,
      content: nil,
      speakableGroupName: nil,
      conversationIdentifier: roomId,
      serviceName: nil,
      sender: sender,
      attachments: nil
    )
    if let avatar { intent.setImage(avatar, forParameterNamed: \.sender) }

    let interaction = INInteraction(intent: intent, response: nil)
    interaction.direction = .incoming
    interaction.donate(completion: nil)

    // `updating(from:)` throws without the Communication Notifications
    // entitlement — fall back to the plain alert if so.
    if let updated = try? best.updating(from: intent) {
      handler?(updated)
    } else {
      handler?(best)
    }
    contentHandler = nil
  }

  override func serviceExtensionTimeWillExpire() {
    // iOS is about to kill us — flush whatever we have rather than losing the push.
    task?.cancel()
    if let contentHandler, let bestAttempt {
      contentHandler(bestAttempt)
      self.contentHandler = nil
    }
  }
}

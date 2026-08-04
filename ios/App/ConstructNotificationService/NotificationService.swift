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

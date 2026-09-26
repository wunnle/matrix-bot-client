import UIKit
import Capacitor
import ActivityKit
import Speech
import AVFoundation
import AppIntents
import UniformTypeIdentifiers
import Intents

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        // Must be in place before iOS delivers a notification action to a
        // cold-launched app; re-asserted on every activation once Capacitor's
        // push plugin has installed its own delegate.
        if #available(iOS 15.0, *) { NotificationActionRouter.shared.install() }
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        NotificationCenter.default.post(name: .capacitorDidRegisterForRemoteNotifications, object: deviceToken)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        NotificationCenter.default.post(name: .capacitorDidFailToRegisterForRemoteNotifications, object: error)
    }
}

/// Scene lifecycle. Apps built against the iOS 27 SDK trap at launch without
/// one (UIKit's "no scene lifecycle adoption" check). Under scenes UIKit stops
/// calling the app delegate's activation and URL methods, so they live here;
/// URLs and user activities are handed to Capacitor's ApplicationDelegateProxy
/// exactly as the app delegate used to, which is what feeds the App plugin's
/// appUrlOpen and getLaunchUrl.
class SceneDelegate: UIResponder, UIWindowSceneDelegate {

    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        // A cold launch delivers its URL or activity here, not through the
        // openURLContexts / continue callbacks below.
        if let url = connectionOptions.urlContexts.first?.url {
            _ = ApplicationDelegateProxy.shared.application(UIApplication.shared, open: url, options: [:])
        }
        if let activity = connectionOptions.userActivities.first {
            _ = ApplicationDelegateProxy.shared.application(UIApplication.shared, continue: activity) { _ in }
        }
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        guard let url = URLContexts.first?.url else { return }
        _ = ApplicationDelegateProxy.shared.application(UIApplication.shared, open: url, options: [:])
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        _ = ApplicationDelegateProxy.shared.application(UIApplication.shared, continue: userActivity) { _ in }
    }

    func sceneDidBecomeActive(_ scene: UIScene) {
        // Capacitor's push plugin claims the notification delegate when it
        // loads; take it back (chaining to it) so Reply keeps working.
        if #available(iOS 15.0, *) { NotificationActionRouter.shared.install() }
        // Drop server tokens for activities dismissed while the app was away;
        // they'd only waste pushes and count toward the server's activity cap.
        if #available(iOS 16.2, *) { Task { await reconcileLiveActivityTokens() } }
        // Pick up activities the server started while this process was away, so
        // their update tokens get registered.
        if #available(iOS 16.2, *) { adoptRunningLiveActivities() }
        // Let the server start activities by push.
        if #available(iOS 17.2, *) { observeLiveActivityStartsOnce() }
        #if DEBUG
        if #available(iOS 16.2, *) { startLiveActivityDemoOnce() }
        #endif
        // Hide the assistant/"language" bar on iPad + Mac (and the blank software
        // keyboard on Mac). No-op on iPhone.
        if #available(iOS 14.0, *) { configureWebKeyboardOnce() }
    }
}

// MARK: - Notification reply

/// Inline "Reply" on push notifications, handled natively so it works with the
/// app not running — the webview (and Capacitor's JS bridge) may not exist when
/// a notification action fires.
///
/// Capacitor's PushNotificationsHandler also wants to be the notification centre
/// delegate, so this installs itself in front and forwards everything it doesn't
/// consume, leaving the plugin's `pushNotificationActionPerformed` events intact.
@available(iOS 15.0, *)
final class NotificationActionRouter: NSObject, UNUserNotificationCenterDelegate {
    static let shared = NotificationActionRouter()

    static let categoryId = "MESSAGE"   // must match `category` in api/matrix-push.js
    static let replyActionId = "REPLY"

    private weak var chained: UNUserNotificationCenterDelegate?

    /// Idempotent, and safe to call repeatedly: Capacitor assigns its own
    /// delegate when the plugin loads (after `didFinishLaunching`), so this is
    /// called again on `didBecomeActive` to move back in front and pick the
    /// plugin up as the chained delegate.
    func install() {
        let center = UNUserNotificationCenter.current()
        if !(center.delegate is NotificationActionRouter) {
            chained = center.delegate
            center.delegate = self
        }
        let reply = UNTextInputNotificationAction(
            identifier: Self.replyActionId,
            title: "Reply",
            options: [],                       // no .foreground — stay out of the app
            textInputButtonTitle: "Send",
            textInputPlaceholder: "Message…"
        )
        center.setNotificationCategories([
            UNNotificationCategory(identifier: Self.categoryId,
                                   actions: [reply],
                                   intentIdentifiers: [],
                                   options: [])
        ])
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        if response.actionIdentifier == UNNotificationDefaultActionIdentifier,
           let room = response.notification.request.content.userInfo["roomId"] as? String,
           !room.isEmpty {
            var allowed = CharacterSet.urlQueryAllowed
            allowed.remove(charactersIn: "&+=?")
            guard let encoded = room.addingPercentEncoding(withAllowedCharacters: allowed),
                  let url = URL(string: "construct://room?room=\(encoded)") else {
                forward(center, didReceive: response, completionHandler: completionHandler)
                return
            }
            Task { @MainActor in
                UIApplication.shared.open(url)
                self.forward(center, didReceive: response, completionHandler: completionHandler)
            }
            return
        }

        guard response.actionIdentifier == Self.replyActionId,
              let textResponse = response as? UNTextInputNotificationResponse else {
            forward(center, didReceive: response, completionHandler: completionHandler)
            return
        }

        let room = response.notification.request.content.userInfo["roomId"] as? String
        let text = textResponse.userText

        // The action handler gets a limited window; keep the app alive across
        // the send so a backgrounded reply isn't cut off mid-request.
        var bgTask: UIBackgroundTaskIdentifier = .invalid
        bgTask = UIApplication.shared.beginBackgroundTask(withName: "notification-reply") {
            UIApplication.shared.endBackgroundTask(bgTask)
            bgTask = .invalid
        }

        Task {
            await Self.sendReply(text: text, room: room)
            if bgTask != .invalid { UIApplication.shared.endBackgroundTask(bgTask) }
            await MainActor.run {
                self.forward(center, didReceive: response, completionHandler: completionHandler)
            }
        }
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        guard let chained,
              chained.responds(to: #selector(UNUserNotificationCenterDelegate.userNotificationCenter(_:willPresent:withCompletionHandler:))) else {
            completionHandler([])
            return
        }
        chained.userNotificationCenter?(center, willPresent: notification, withCompletionHandler: completionHandler)
    }

    private func forward(_ center: UNUserNotificationCenter,
                         didReceive response: UNNotificationResponse,
                         completionHandler: @escaping () -> Void) {
        guard let chained,
              chained.responds(to: #selector(UNUserNotificationCenterDelegate.userNotificationCenter(_:didReceive:withCompletionHandler:))) else {
            completionHandler()
            return
        }
        chained.userNotificationCenter?(center, didReceive: response, withCompletionHandler: completionHandler)
    }

    /// Same route the Shortcut path uses — `IntentConfig` values the app
    /// persisted to UserDefaults, posted with the intent secret.
    private static func sendReply(text: String, room: String?) async {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        let d = IntentConfig.defaults
        // Only set once the app has run; a reply before first launch is dropped.
        guard let secret = d.string(forKey: IntentConfig.secret), !secret.isEmpty else { return }
        let apiBase = d.string(forKey: IntentConfig.apiBase) ?? "https://construct.kafagoz.com"
        let target = room ?? d.string(forKey: IntentConfig.room) ?? "!DpRWqhWOHJAxyvjOGI:matrix.org"
        _ = await intentPost("\(apiBase)/api/send-message", secret: secret,
                             body: ["room": target, "text": trimmed, "source": "notification"])
    }
}

// MARK: - App Intents

/// App-side twin of the widget extension's ListenIntent (same type name =
/// same action identifier). The control launches the app because this copy
/// exists in the app's AppIntents metadata; perform() then runs here and
/// re-enters the normal deep-link path (appUrlOpen → navigate → dictate).
@available(iOS 16.0, *)
struct ListenIntent: AppIntent {
    static let title: LocalizedStringResource = "Listen"
    static let description = IntentDescription("Open Construct and start dictating a message.")
    static let openAppWhenRun = true

    @MainActor
    func perform() async throws -> some IntentResult {
        if let url = URL(string: "construct://listen?room=%21DpRWqhWOHJAxyvjOGI%3Amatrix.org") {
            await UIApplication.shared.open(url)
        }
        return .result()
    }
}

/// Web-keyboard tweaks for the larger-screen idioms, applied by swizzling
/// WebKit's private content view once. iPhone is left completely untouched.
///
/// - iPad (and Mac): drop the `inputAccessoryView` — the assistant/"language"
///   bar that otherwise floats over the composer with a hardware keyboard.
///   Native apps like Messages hide it too.
/// - Mac only: also replace `inputView` with an empty zero-size view, so the
///   blank software keyboard (useless with no touch input) collapses. The
///   hardware keyboard still types.
private var didConfigureWebKeyboard = false
private var didObserveLiveActivityStarts = false
@available(iOS 14.0, *)
private func configureWebKeyboardOnce() {
    guard !didConfigureWebKeyboard, let cls = NSClassFromString("WKContentView") else { return }
    let isMac = ProcessInfo.processInfo.isiOSAppOnMac
    let isPad = UIDevice.current.userInterfaceIdiom == .pad
    guard isPad || isMac else { return }   // iPhone unaffected
    didConfigureWebKeyboard = true

    // An empty zero-size view is more reliable than nil: returning nil lets iOS
    // fall back to the default assistant bar on a fresh input session (e.g.
    // after switching rooms), whereas an empty view stays empty.
    let emptyAccessory = UIView(frame: .zero)
    let accessoryBlock: @convention(block) (AnyObject) -> UIView? = { _ in emptyAccessory }
    let accessorySel = NSSelectorFromString("inputAccessoryView")
    if let m = class_getInstanceMethod(cls, accessorySel) {
        method_setImplementation(m, imp_implementationWithBlock(accessoryBlock))
    } else {
        class_addMethod(cls, accessorySel, imp_implementationWithBlock(accessoryBlock), "@@:")
    }

    // The iPad hardware-keyboard shortcuts bar (undo/redo + the language
    // selector) is the `inputAssistantItem`, repopulated on later input
    // sessions — so the accessory swizzle alone let it come back after the first
    // focus. Empty its button groups on every fetch to keep it hidden.
    let assistantSel = NSSelectorFromString("inputAssistantItem")
    if let m = class_getInstanceMethod(cls, assistantSel) {
        typealias AssistantGetter = @convention(c) (AnyObject, Selector) -> UITextInputAssistantItem
        let original = unsafeBitCast(method_getImplementation(m), to: AssistantGetter.self)
        let assistantBlock: @convention(block) (AnyObject) -> UITextInputAssistantItem = { receiver in
            let item = original(receiver, assistantSel)
            item.leadingBarButtonGroups = []
            item.trailingBarButtonGroups = []
            return item
        }
        method_setImplementation(m, imp_implementationWithBlock(assistantBlock))
    }

    if isMac {
        let emptyInputView = UIView(frame: .zero)
        let inputBlock: @convention(block) (AnyObject) -> UIView? = { _ in emptyInputView }
        let inputSel = NSSelectorFromString("inputView")
        if let m = class_getInstanceMethod(cls, inputSel) {
            method_setImplementation(m, imp_implementationWithBlock(inputBlock))
        } else {
            class_addMethod(cls, inputSel, imp_implementationWithBlock(inputBlock), "@@:")
        }
    }
}

/// Config the app writes for background intents to read (they run without the
/// webview, so they can't reach import.meta.env). Persisted in the shared App
/// Group suite so extensions in their own processes (e.g. the notification
/// content extension) can read the secret too, not just the app process.
enum IntentConfig {
    static let appGroup = "group.com.wunnle.construct"
    static let secret = "construct.intentSecret"
    static let apiBase = "construct.apiBase"
    static let room = "construct.defaultRoom"

    /// Shared across the app and its extensions. Falls back to `.standard` if the
    /// App Group container is somehow unavailable.
    static var defaults: UserDefaults { UserDefaults(suiteName: appGroup) ?? .standard }
}

/// Writer half of the Live Activity avatar cache.
///
/// NOTE: the reader is duplicated in the widget target
/// (ContructWidgetsLiveActivity.swift) and the notification service extension
/// writes to it too — separate processes, no shared module, so the path scheme
/// has to stay identical in all three. A Live Activity can't fetch its own
/// image (no network while rendering, and the push payload is far too small),
/// so whatever is on disk when it draws is what it shows.
enum AvatarCache {
    static let appGroup = "group.com.wunnle.construct"

    static func fileName(for roomId: String) -> String {
        String(roomId.map { $0.isLetter || $0.isNumber ? $0 : "_" }) + ".png"
    }

    static func write(_ data: Data, roomId: String) {
        guard !roomId.isEmpty, !data.isEmpty,
              let dir = FileManager.default
                .containerURL(forSecurityApplicationGroupIdentifier: appGroup)?
                .appendingPathComponent("avatars", isDirectory: true)
        else { return }
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        try? data.write(to: dir.appendingPathComponent(fileName(for: roomId)), options: .atomic)
    }
}

/// Registers an Activity's APNs push token with the server so it can update the
/// Live Activity while the app is suspended — the only way to move it past
/// whatever state the app last set.
///
/// The token is per-activity and rotates, so this observes `pushTokenUpdates`
/// for the activity's lifetime rather than reading it once.
/// Activities can arrive from two directions — created here, or created by the
/// server and handed to us via `activityUpdates` — and the same one can arrive
/// both ways. Observing it twice would post its token again on every rotation,
/// so each activity is claimed once.
private final class TrackedActivities {
    static let shared = TrackedActivities()
    private let lock = NSLock()
    private var ids = Set<String>()

    /// True only for the first caller to claim this activity.
    func claim(_ id: String) -> Bool {
        lock.lock(); defer { lock.unlock() }
        return ids.insert(id).inserted
    }

    func release(_ id: String) {
        lock.lock(); defer { lock.unlock() }
        ids.remove(id)
    }
}

@available(iOS 16.2, *)
private extension Activity {
    /// Still on screen. A `.stale` activity is dimmed but visible, and still
    /// takes pushes.
    var isLive: Bool { activityState == .active || activityState == .stale }
}

@available(iOS 16.2, *)
private func trackLiveActivityToken(_ activity: Activity<ConstructActivityAttributes>) {
    guard TrackedActivities.shared.claim(activity.id) else { return }
    let activityId = activity.attributes.activityId
    Task {
        for await tokenData in activity.pushTokenUpdates {
            await postLiveActivity(["activityId": activityId, "token": hexString(tokenData)])
        }
    }
    // When the activity ends or the user dismisses it, drop its server token
    // right away (the fast path), then reconcile to sweep anything else that
    // ended while nobody was watching. Only terminal states count — a `.stale`
    // activity is still on screen.
    Task {
        for await state in activity.activityStateUpdates {
            if state == .ended || state == .dismissed {
                await postLiveActivity(["action": "end", "activityId": activityId])
                await reconcileLiveActivityTokens()
                TrackedActivities.shared.release(activity.id)
                break
            }
        }
    }
}

/// Adopts activities that are already running. `activityUpdates` only delivers
/// activities as they are *created*, and a push-started one is created while
/// this process is suspended — that creation is never replayed on resume, so
/// without sweeping the current list its update token is never registered and
/// the server can't update it.
///
/// Safe to call on every activation: trackLiveActivityToken claims each
/// activity once.
@available(iOS 16.2, *)
private func adoptRunningLiveActivities() {
    for activity in Activity<ConstructActivityAttributes>.activities {
        trackLiveActivityToken(activity)
    }
}

/// Wires up the two streams that let the *server* create Live Activities:
///
///  * `pushToStartTokenUpdates` — a per-device token the server pushes to in
///    order to create an activity. It rotates, so it is observed rather than
///    read once.
///  * `activityUpdates` — an activity created remotely has nothing observing
///    its own update token, so it would be stuck on whatever content started
///    it. Adopt each one and register its token under its activityId.
@available(iOS 17.2, *)
private func observeLiveActivityStartsOnce() {
    guard !didObserveLiveActivityStarts else { return }
    didObserveLiveActivityStarts = true

    Task {
        for await tokenData in Activity<ConstructActivityAttributes>.pushToStartTokenUpdates {
            await postLiveActivity(["action": "push-to-start", "token": hexString(tokenData)])
        }
    }

    Task {
        for await activity in Activity<ConstructActivityAttributes>.activityUpdates {
            trackLiveActivityToken(activity)
        }
    }
}

#if DEBUG
private var didStartLiveActivityDemo = false

/// Debug builds only: launching with `-LiveActivityDemo` starts one activity
/// per sample state, so the widget can be checked on a simulator with no
/// server push. Ten seconds later each gets an alerting update, which pops the
/// expanded Dynamic Island if the app has been backgrounded by then.
@available(iOS 16.2, *)
private func startLiveActivityDemoOnce() {
    guard !didStartLiveActivityDemo,
          ProcessInfo.processInfo.arguments.contains("-LiveActivityDemo") else { return }
    didStartLiveActivityDemo = true
    typealias State = ConstructActivityAttributes.ContentState
    let samples: [State] = [
        State(title: "Deploying construct", body: "Building the web bundle and uploading to Vercel.",
              progress: 0.6, step: "3/5", roomName: "Bender"),
        State(title: "Deploy is live", body: "All checks passed. Promote to production?", tone: "success",
              actions: [.init(label: "Ship it", send: "ship it"), .init(label: "Hold", send: "hold"),
                        .init(label: "Details", send: "details")],
              roomName: "Bender"),
        State(title: "Approve rm -rf build/?",
              body: "The agent wants to clear the build directory before a clean rebuild.",
              tone: "warning", progress: 0.3,
              actions: [.init(label: "Approve", send: "approve"), .init(label: "Deny", send: "deny")],
              roomName: "agent: clean rebuild", endsAt: Date().addingTimeInterval(300).timeIntervalSince1970),
    ]
    Task {
        for activity in Activity<ConstructActivityAttributes>.activities {
            await activity.end(nil, dismissalPolicy: .immediate)
        }
        var started: [Activity<ConstructActivityAttributes>] = []
        for (i, state) in samples.enumerated() {
            do {
                started.append(try Activity.request(
                    attributes: ConstructActivityAttributes(activityId: "demo-\(i)"),
                    content: .init(state: state, staleDate: nil)))
            } catch {
                NSLog("LiveActivityDemo: request \(i) failed: \(error)")
            }
        }
        NSLog("LiveActivityDemo: started \(started.count)")
        // The app is suspended once backgrounded; hold it awake for the alerts.
        let bg = await UIApplication.shared.beginBackgroundTask(withName: "live-activity-demo")
        defer { Task { @MainActor in UIApplication.shared.endBackgroundTask(bg) } }
        try? await Task.sleep(for: .seconds(10))
        for activity in started {
            await activity.update(.init(state: activity.content.state, staleDate: nil),
                                  alertConfiguration: .init(title: "Demo", body: "Demo", sound: .default))
            try? await Task.sleep(for: .seconds(6))
        }
    }
}
#endif

/// Tells the server which activities are still on screen; it drops every
/// update token not in the list (an empty list clears them all). The safety
/// net behind the per-activity "end": an activity dismissed while the app was
/// closed vanishes from `Activity.activities`, so its id is gone and nothing
/// else would ever end it.
@available(iOS 16.2, *)
private func reconcileLiveActivityTokens() async {
    let live = Activity<ConstructActivityAttributes>.activities
        .filter(\.isLive)
        .map(\.attributes.activityId)
    await postLiveActivity(["action": "reconcile", "activityIds": live])
}

/// POSTs to api/live-activity with the stored credential. No-op until the app
/// has saved one (saveIntentConfig, after login).
@discardableResult
private func postLiveActivity(_ body: [String: Any]) async -> [String: Any]? {
    let d = IntentConfig.defaults
    guard let secret = d.string(forKey: IntentConfig.secret), !secret.isEmpty else { return nil }
    let apiBase = d.string(forKey: IntentConfig.apiBase) ?? "https://construct.kafagoz.com"
    return await intentPost("\(apiBase)/api/live-activity", secret: secret, body: body)
}

private func hexString(_ data: Data) -> String {
    data.map { String(format: "%02x", $0) }.joined()
}

private func intentPost(_ urlString: String, secret: String, body: [String: Any]) async -> [String: Any]? {
    guard let url = URL(string: urlString),
          let data = try? JSONSerialization.data(withJSONObject: body) else { return nil }
    var req = URLRequest(url: url)
    req.httpMethod = "POST"
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    req.setValue(secret, forHTTPHeaderField: "x-intent-secret")
    req.httpBody = data
    req.timeoutInterval = 12
    guard let (respData, _) = try? await URLSession.shared.data(for: req) else { return nil }
    return (try? JSONSerialization.jsonObject(with: respData)) as? [String: Any]
}

/// Upload raw file bytes to send-file (room + filename in the query, secret in
/// the header, body is the bytes). Used by the screenshot intent.
private func intentUpload(_ urlString: String, secret: String, room: String,
                          filename: String, contentType: String, body: Data) async {
    let q = CharacterSet.alphanumerics
    let encRoom = room.addingPercentEncoding(withAllowedCharacters: q) ?? room
    let encName = filename.addingPercentEncoding(withAllowedCharacters: q) ?? filename
    guard let url = URL(string: "\(urlString)?room=\(encRoom)&filename=\(encName)&source=shortcut") else { return }
    var req = URLRequest(url: url)
    req.httpMethod = "POST"
    req.setValue(contentType, forHTTPHeaderField: "Content-Type")
    req.setValue(secret, forHTTPHeaderField: "x-intent-secret")
    req.httpBody = body
    req.timeoutInterval = 20
    _ = try? await URLSession.shared.data(for: req)
}

/// Shortcut entry point: send a dictated message to Construct — no app launch.
@available(iOS 17.0, *)
struct AskConstructIntent: AppIntent {
    static let title: LocalizedStringResource = "Ask Construct"
    static let description = IntentDescription("Send a message to Construct.")

    @Parameter(title: "Message")
    var message: String

    init() {}

    func perform() async throws -> some IntentResult {
        let d = IntentConfig.defaults
        guard let secret = d.string(forKey: IntentConfig.secret), !secret.isEmpty else {
            throw $message.needsValueError("Open Construct once to enable Shortcut sending.")
        }
        let apiBase = d.string(forKey: IntentConfig.apiBase) ?? "https://construct.kafagoz.com"
        let room = d.string(forKey: IntentConfig.room) ?? "!DpRWqhWOHJAxyvjOGI:matrix.org"

        _ = await intentPost("\(apiBase)/api/send-message", secret: secret,
                             body: ["room": room, "text": message, "source": "shortcut"])
        return .result()
    }
}

/// One-tap button on a Live Activity: posts the action's `send` text back to
/// its room in the background — no app launch — over the same send-message
/// route the notification reply uses, tagged with the activity it came from.
/// The widget target holds a no-op twin (ContructWidgetsLiveActivity.swift)
/// that the button references; this copy is what actually performs, resolved
/// by type name in the app's AppIntents metadata (same mechanism as
/// ListenIntent).
@available(iOS 17.0, *)
struct QuickReplyIntent: AppIntent, LiveActivityIntent {
    static let title: LocalizedStringResource = "Quick Reply"
    static let description = IntentDescription("Send a Live Activity button's reply to Construct.")

    @Parameter(title: "Text")
    var text: String

    // Empty falls back to the default room, matching the other intents.
    @Parameter(title: "Room")
    var roomId: String

    @Parameter(title: "Activity")
    var activityId: String

    init() {}
    init(text: String, roomId: String, activityId: String) {
        self.text = text
        self.roomId = roomId
        self.activityId = activityId
    }

    func perform() async throws -> some IntentResult {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return .result() }
        let d = IntentConfig.defaults
        guard let secret = d.string(forKey: IntentConfig.secret), !secret.isEmpty else { return .result() }
        let apiBase = d.string(forKey: IntentConfig.apiBase) ?? "https://construct.kafagoz.com"
        let room = roomId.isEmpty
            ? (d.string(forKey: IntentConfig.room) ?? "!DpRWqhWOHJAxyvjOGI:matrix.org")
            : roomId
        _ = await intentPost("\(apiBase)/api/send-message", secret: secret,
                             body: ["room": room, "text": trimmed, "source": "live-activity",
                                    "activityId": activityId])
        return .result()
    }
}

/// Shortcut entry point: send a screenshot (or any image) to Construct — no app
/// launch. Pair with the Shortcuts "Take Screenshot" action, which is the only
/// thing that can capture the screen (an intent can't screenshot other apps).
@available(iOS 17.0, *)
struct SendScreenshotIntent: AppIntent {
    static let title: LocalizedStringResource = "Send Screenshot to Construct"
    static let description = IntentDescription("Send an image to Construct.")

    // supportedContentTypes: on a file parameter is iOS 18+, so this stays a
    // plain IntentFile — the Shortcuts "Take Screenshot" output passes fine.
    @Parameter(title: "Image")
    var image: IntentFile

    init() {}

    func perform() async throws -> some IntentResult {
        let d = IntentConfig.defaults
        guard let secret = d.string(forKey: IntentConfig.secret), !secret.isEmpty else {
            throw $image.needsValueError("Open Construct once to enable Shortcut sending.")
        }
        let apiBase = d.string(forKey: IntentConfig.apiBase) ?? "https://construct.kafagoz.com"
        let room = d.string(forKey: IntentConfig.room) ?? "!DpRWqhWOHJAxyvjOGI:matrix.org"

        let bytes = image.data
        let mime = image.type?.preferredMIMEType ?? "image/jpeg"
        let ext = image.type?.preferredFilenameExtension ?? "jpg"
        await intentUpload("\(apiBase)/api/send-file", secret: secret, room: room,
                           filename: "screenshot.\(ext)", contentType: mime, body: bytes)
        return .result()
    }
}

/// Used to show a "Thinking…" Live Activity after a Shortcut uploaded a
/// screenshot itself. Live Activities are now started only by the server, so
/// this does nothing; it stays so shortcuts that still end with it don't fail
/// on a missing action.
@available(iOS 17.0, *)
struct WatchConstructReplyIntent: AppIntent {
    static let title: LocalizedStringResource = "Watch Construct Reply"
    static let description = IntentDescription("No longer does anything. Safe to remove from your shortcuts.")

    init() {}

    func perform() async throws -> some IntentResult { .result() }
}

// MARK: - Live Activities

/// Storyboard entry point (Main.storyboard) — registers in-app plugins.
/// cap sync regenerates capacitor.config.json's packageClassList from npm
/// packages only, so custom plugins must be registered here instead.
@objc(MainViewController)
class MainViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(LiveActivityPlugin())
        bridge?.registerPluginInstance(SpeechRecognitionPlugin())
    }
}

// MARK: - Native speech recognition

/// SFSpeechRecognizer bridge with the same event shape the web hook expects:
/// 'result' {transcript, isFinal} (transcript is cumulative for the session),
/// 'end' when the session stops, 'error' {message}.
@objc(SpeechRecognitionPlugin)
public class SpeechRecognitionPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "SpeechRecognitionPlugin"
    public let jsName = "SpeechRecognition"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "available", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise)
    ]

    private var audioEngine: AVAudioEngine?
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?

    @objc func available(_ call: CAPPluginCall) {
        let recognizer = SFSpeechRecognizer(locale: Locale.current) ?? SFSpeechRecognizer()
        call.resolve(["available": recognizer?.isAvailable ?? false])
    }

    @objc func start(_ call: CAPPluginCall) {
        SFSpeechRecognizer.requestAuthorization { [weak self] status in
            guard status == .authorized else {
                call.reject("Speech recognition not authorized")
                return
            }
            AVAudioSession.sharedInstance().requestRecordPermission { granted in
                guard granted else {
                    call.reject("Microphone access not granted")
                    return
                }
                DispatchQueue.main.async {
                    self?.beginSession(call)
                }
            }
        }
    }

    private func beginSession(_ call: CAPPluginCall) {
        stopSession(notify: false)

        let localeId = call.getString("lang") ?? Locale.current.identifier
        guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: localeId)) ?? SFSpeechRecognizer(),
              recognizer.isAvailable else {
            call.reject("Speech recognizer unavailable")
            return
        }

        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.record, mode: .measurement, options: .duckOthers)
            try session.setActive(true, options: .notifyOthersOnDeactivation)

            let engine = AVAudioEngine()
            let req = SFSpeechAudioBufferRecognitionRequest()
            req.shouldReportPartialResults = true
            if recognizer.supportsOnDeviceRecognition {
                req.requiresOnDeviceRecognition = true
            }

            let inputNode = engine.inputNode
            let format = inputNode.outputFormat(forBus: 0)
            inputNode.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
                req.append(buffer)
            }

            engine.prepare()
            try engine.start()

            audioEngine = engine
            request = req
            task = recognizer.recognitionTask(with: req) { [weak self] result, error in
                if let result = result {
                    self?.notifyListeners("result", data: [
                        "transcript": result.bestTranscription.formattedString,
                        "isFinal": result.isFinal,
                    ])
                    if result.isFinal {
                        self?.stopSession(notify: true)
                    }
                } else if error != nil {
                    // Cancellation surfaces as an error — treat as session end.
                    self?.stopSession(notify: true)
                }
            }
            call.resolve()
        } catch {
            stopSession(notify: false)
            call.reject("Audio session failed: \(error.localizedDescription)")
        }
    }

    @objc func stop(_ call: CAPPluginCall) {
        stopSession(notify: true)
        call.resolve()
    }

    private func stopSession(notify: Bool) {
        task?.cancel()
        task = nil
        request?.endAudio()
        request = nil
        if let engine = audioEngine {
            engine.stop()
            engine.inputNode.removeTap(onBus: 0)
        }
        audioEngine = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        if notify {
            notifyListeners("end", data: [:])
        }
    }
}

// NOTE: intentionally duplicated in the widget target
// (ContructWidgets/ContructWidgetsLiveActivity.swift). ActivityKit matches
// attributes across processes by type name and Codable shape — the two
// definitions must stay identical.
struct ConstructActivityAttributes: ActivityAttributes {
    public struct ContentState: Codable, Hashable {
        var title: String = ""
        var body: String = ""
        // "neutral" | "success" | "warning" | "error"; anything else draws as neutral.
        var tone: String = "neutral"
        // 0...1. Shown as a bar when set.
        var progress: Double? = nil
        // e.g. "3/5". Shown as a label when set.
        var step: String? = nil
        // Up to 3 one-tap QuickReplyIntent buttons; `send` is posted to roomId.
        var actions: [Action] = []
        var roomId: String = ""
        var roomName: String = ""
        // Unix seconds (since 1970). Deliberately not Date: a Codable Date in
        // content-state decodes as seconds since 2001.
        var endsAt: Double? = nil

        struct Action: Codable, Hashable {
            var label: String = ""
            var send: String = ""
        }
    }

    var activityId: String
}

// Synthesized Decodable ignores property defaults and throws on any missing key,
// and ActivityKit drops a push whose content-state doesn't decode without a
// word. Decode every field leniently so a partial push still lands.
extension ConstructActivityAttributes.ContentState {
    private enum Keys: String, CodingKey {
        case title, body, tone, progress, step, actions, roomId, roomName, endsAt
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        title = try c.decodeIfPresent(String.self, forKey: .title) ?? ""
        body = try c.decodeIfPresent(String.self, forKey: .body) ?? ""
        tone = try c.decodeIfPresent(String.self, forKey: .tone) ?? "neutral"
        progress = try c.decodeIfPresent(Double.self, forKey: .progress)
        step = try c.decodeIfPresent(String.self, forKey: .step)
        actions = try c.decodeIfPresent([Action].self, forKey: .actions) ?? []
        roomId = try c.decodeIfPresent(String.self, forKey: .roomId) ?? ""
        roomName = try c.decodeIfPresent(String.self, forKey: .roomName) ?? ""
        endsAt = try c.decodeIfPresent(Double.self, forKey: .endsAt)
    }
}

extension ConstructActivityAttributes.ContentState.Action {
    private enum Keys: String, CodingKey { case label, send }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        label = try c.decodeIfPresent(String.self, forKey: .label) ?? ""
        send = try c.decodeIfPresent(String.self, forKey: .send) ?? ""
    }
}

/// Bridges ActivityKit to JS. Lives in AppDelegate.swift because the App
/// target uses explicit pbxproj file references — a separate file would
/// need to be added to the target in Xcode to compile.
@objc(LiveActivityPlugin)
public class LiveActivityPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "LiveActivityPlugin"
    public let jsName = "LiveActivity"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "isSupported", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "update", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "end", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "saveIntentConfig", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "donateShareTargets", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cacheRoomAvatars", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "isMacApp", returnType: CAPPluginReturnPromise)
    ]

    /// True when this iPad app is running on a Mac (Designed for iPad). The web
    /// layer uses it to scale the mobile-first UI up and hide the phantom
    /// software keyboard.
    @objc func isMacApp(_ call: CAPPluginCall) {
        call.resolve(["value": ProcessInfo.processInfo.isiOSAppOnMac])
    }

    /// Store every room's avatar for the Live Activity to draw.
    ///
    /// Deliberately separate from donateShareTargets: that one is capped and
    /// filtered by the share-sheet settings, so rooms excluded from sharing (or
    /// past the cap) had no avatar and fell back to the bundled placeholder.
    /// What the lock screen can draw shouldn't depend on sharing preferences.
    @objc func cacheRoomAvatars(_ call: CAPPluginCall) {
        let items: [(String, Data)] = (call.getArray("rooms", JSObject.self) ?? []).compactMap { room in
            guard let roomId = room["roomId"] as? String, !roomId.isEmpty,
                  let b64 = room["avatar"] as? String,
                  let data = Data(base64Encoded: b64) else { return nil }
            return (roomId, data)
        }
        call.resolve()
        DispatchQueue.global(qos: .utility).async {
            for (roomId, data) in items { AvatarCache.write(data, roomId: roomId) }
        }
    }

    /// Donate an INSendMessageIntent per room so iOS surfaces the rooms as
    /// direct-share targets (avatars + names) in the share sheet's suggestions
    /// row. The share extension reads the picked room from the intent's
    /// conversationIdentifier. Called from JS with the current room list.
    @objc func donateShareTargets(_ call: CAPPluginCall) {
        // Pull the values on the bridge thread, then donate off the main thread
        // — donating a dozen intents inline was hitching the UI.
        let items: [(String, String, Data?)] = (call.getArray("rooms", JSObject.self) ?? []).compactMap { room in
            guard let roomId = room["roomId"] as? String, !roomId.isEmpty,
                  let name = room["name"] as? String, !name.isEmpty else { return nil }
            let avatar = (room["avatar"] as? String).flatMap { Data(base64Encoded: $0) }
            return (roomId, name, avatar)
        }
        // Rooms turned off in Settings — delete just these by group id rather
        // than deleteAll'ing (which wiped every suggestion + its avatar and
        // reset iOS's ranking on every app open).
        let remove = call.getArray("remove", String.self) ?? []
        call.resolve()
        DispatchQueue.global(qos: .utility).async {
            if !remove.isEmpty { INInteraction.delete(with: remove) { _ in } }
            // Re-donating the same groupIdentifier updates that room's donation
            // in place (refreshing its avatar) without disturbing the others.
            for (roomId, name, avatar) in items {
                // Same bytes the share sheet uses, kept on disk for the Live
                // Activity — which can't load an image any other way.
                if let avatar { AvatarCache.write(avatar, roomId: roomId) }
                let intent = INSendMessageIntent(
                    recipients: nil,
                    outgoingMessageType: .outgoingMessageText,
                    content: nil,
                    speakableGroupName: INSpeakableString(spokenPhrase: name),
                    conversationIdentifier: roomId,
                    serviceName: nil,
                    sender: nil,
                    attachments: nil
                )
                if let avatar {
                    intent.setImage(INImage(imageData: avatar), forParameterNamed: \.speakableGroupName)
                }
                let interaction = INInteraction(intent: intent, response: nil)
                interaction.groupIdentifier = roomId
                interaction.donate(completion: nil)
            }
        }
    }

    /// Persist the config the background AskConstructIntent needs (it has no
    /// access to the webview's env). Called once per launch from JS.
    @objc func saveIntentConfig(_ call: CAPPluginCall) {
        let d = IntentConfig.defaults
        if let s = call.getString("secret") { d.set(s, forKey: IntentConfig.secret) }
        if let a = call.getString("apiBase") { d.set(a, forKey: IntentConfig.apiBase) }
        if let r = call.getString("room") { d.set(r, forKey: IntentConfig.room) }
        call.resolve()
    }

    @objc func isSupported(_ call: CAPPluginCall) {
        if #available(iOS 16.2, *) {
            call.resolve(["supported": ActivityAuthorizationInfo().areActivitiesEnabled])
        } else {
            call.resolve(["supported": false])
        }
    }

    /// Starts a local activity (the debug overlay's test path; real ones are
    /// started by the server). Missing activityId → a fresh UUID. Starting an id
    /// that is already on screen updates it rather than stacking a duplicate.
    @objc func start(_ call: CAPPluginCall) {
        guard #available(iOS 16.2, *) else {
            call.reject("Live Activities require iOS 16.2 or later")
            return
        }
        let activityId = call.getString("activityId") ?? UUID().uuidString
        if let existing = Self.liveActivity(activityId) {
            let state = Self.contentState(from: call, over: existing.content.state)
            Task {
                await existing.update(.init(state: state, staleDate: nil))
                call.resolve(["activityId": activityId])
            }
            return
        }
        do {
            let activity = try Activity.request(
                attributes: ConstructActivityAttributes(activityId: activityId),
                content: .init(state: Self.contentState(from: call, over: .init()), staleDate: nil),
                pushType: .token
            )
            trackLiveActivityToken(activity)
            call.resolve(["activityId": activityId])
        } catch {
            call.reject("Failed to start Live Activity: \(error.localizedDescription)")
        }
    }

    /// Merges the given fields into one activity's current state; fields left
    /// out keep their value.
    @objc func update(_ call: CAPPluginCall) {
        guard #available(iOS 16.2, *) else {
            call.reject("Live Activities require iOS 16.2 or later")
            return
        }
        guard let activityId = call.getString("activityId"),
              let activity = Self.liveActivity(activityId) else {
            call.reject("No Live Activity on screen with that activityId")
            return
        }
        let state = Self.contentState(from: call, over: activity.content.state)
        Task {
            await activity.update(.init(state: state, staleDate: nil))
            call.resolve()
        }
    }

    /// Ends one activity, or every one when no activityId is given. The token
    /// tracker sees each end and clears its server token.
    @objc func end(_ call: CAPPluginCall) {
        guard #available(iOS 16.2, *) else {
            call.reject("Live Activities require iOS 16.2 or later")
            return
        }
        let activityId = call.getString("activityId")
        Task {
            for activity in Activity<ConstructActivityAttributes>.activities
            where activityId == nil || activity.attributes.activityId == activityId {
                await activity.end(nil, dismissalPolicy: .immediate)
            }
            call.resolve()
        }
    }

    @available(iOS 16.2, *)
    private static func liveActivity(_ activityId: String) -> Activity<ConstructActivityAttributes>? {
        Activity<ConstructActivityAttributes>.activities.first {
            $0.attributes.activityId == activityId && $0.isLive
        }
    }

    private static func contentState(from call: CAPPluginCall,
                                     over base: ConstructActivityAttributes.ContentState)
        -> ConstructActivityAttributes.ContentState {
        var s = base
        if let v = call.getString("title") { s.title = v }
        if let v = call.getString("body") { s.body = v }
        if let v = call.getString("tone") { s.tone = v }
        if let v = call.getDouble("progress") { s.progress = v }
        if let v = call.getString("step") { s.step = v }
        if let v = call.getArray("actions", JSObject.self) {
            s.actions = v.prefix(3).map {
                .init(label: $0["label"] as? String ?? "", send: $0["send"] as? String ?? "")
            }
        }
        if let v = call.getString("roomId") { s.roomId = v }
        if let v = call.getString("roomName") { s.roomName = v }
        if let v = call.getDouble("endsAt") { s.endsAt = v }
        return s
    }
}

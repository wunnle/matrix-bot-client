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

    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        // Must be in place before iOS delivers a notification action to a
        // cold-launched app; re-asserted in didBecomeActive once Capacitor's
        // push plugin has installed its own delegate.
        if #available(iOS 15.0, *) { NotificationActionRouter.shared.install() }
        return true
    }

    func applicationWillResignActive(_ application: UIApplication) {
        // Sent when the application is about to move from active to inactive state. This can occur for certain types of temporary interruptions (such as an incoming phone call or SMS message) or when the user quits the application and it begins the transition to the background state.
        // Use this method to pause ongoing tasks, disable timers, and invalidate graphics rendering callbacks. Games should use this method to pause the game.
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
        // Use this method to release shared resources, save user data, invalidate timers, and store enough application state information to restore your application to its current state in case it is terminated later.
        // If your application supports background execution, this method is called instead of applicationWillTerminate: when the user quits.
    }

    func applicationWillEnterForeground(_ application: UIApplication) {
        // Called as part of the transition from the background to the active state; here you can undo many of the changes made on entering the background.
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        // Restart any tasks that were paused (or not yet started) while the application was inactive. If the application was previously in the background, optionally refresh the user interface.
        // Capacitor's push plugin claims the notification delegate when it
        // loads; take it back (chaining to it) so Reply keeps working.
        if #available(iOS 15.0, *) { NotificationActionRouter.shared.install() }
        // Clear any Live Activity token left over from a dismissed/killed
        // activity, so a stale token doesn't keep suppressing this room's
        // notifications.
        if #available(iOS 16.2, *) { Task { await reconcileLiveActivityTokens() } }
    }

    func applicationWillTerminate(_ application: UIApplication) {
        // Called when the application is about to terminate. Save data if appropriate. See also applicationDidEnterBackground:.
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        NotificationCenter.default.post(name: .capacitorDidRegisterForRemoteNotifications, object: deviceToken)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        NotificationCenter.default.post(name: .capacitorDidFailToRegisterForRemoteNotifications, object: error)
    }

    func application(_ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
        // Called when the app was launched with a url. Feel free to add additional processing here,
        // but if you want the App API to support tracking app url opens, make sure to keep this call
        return ApplicationDelegateProxy.shared.application(app, open: url, options: options)
    }

    func application(_ application: UIApplication, continue userActivity: NSUserActivity, restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void) -> Bool {
        // Called when the app was launched with an activity, including Universal Links.
        // Feel free to add additional processing here, but if you want the App API to support
        // tracking app url opens, make sure to keep this call
        return ApplicationDelegateProxy.shared.application(application, continue: userActivity, restorationHandler: restorationHandler)
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

/// Registers an Activity's APNs push token with the server so `matrix-push.js`
/// can update the Live Activity while the app is suspended — the only way to
/// move it past whatever state the app last set.
///
/// The token is per-activity and rotates, so this observes `pushTokenUpdates`
/// for the activity's lifetime rather than reading it once.
@available(iOS 16.2, *)
private func trackLiveActivityToken<T: ActivityAttributes>(_ activity: Activity<T>, room: String, question: String = "") {
    Task {
        for await tokenData in activity.pushTokenUpdates {
            _ = await postLiveActivityToken(tokenData, room: room, question: question)
        }
    }
    // When the activity ends or the user dismisses it, drop the server token.
    // A lingering token makes the gateway suppress the phone notification for
    // this room (it assumes a Live Activity will surface the message), so a
    // dismissed activity would silently swallow notifications until the token
    // expired. Only terminal states clear it — a `.stale` activity is still on
    // screen (dimmed) and should keep receiving pushes.
    Task {
        for await state in activity.activityStateUpdates {
            if state == .ended || state == .dismissed {
                await clearLiveActivityTokens(room: room)
                break
            }
        }
    }
}

/// Registers the activity's first push token and *waits* for it.
///
/// `AskConstructIntent` runs in a background shortcut process that is torn down
/// as soon as `perform()` returns, so a detached observer task can be killed
/// before it ever POSTs — leaving the server with no token and the activity
/// unreachable by push. Awaiting the first token inline closes that window;
/// `trackLiveActivityToken` then handles later rotations.
///
/// Bounded, because `pushTokenUpdates` never finishes on its own: if APNs is
/// slow or unavailable we give up rather than stall the intent.
@available(iOS 16.2, *)
private func awaitLiveActivityToken<T: ActivityAttributes>(_ activity: Activity<T>,
                                                           room: String,
                                                           question: String = "",
                                                           timeout: Duration = .seconds(5)) async -> String {
    return await withTaskGroup(of: String.self) { group -> String in
        group.addTask {
            for await tokenData in activity.pushTokenUpdates {
                return await postLiveActivityToken(tokenData, room: room, question: question)
            }
            return "stream-ended"
        }
        group.addTask {
            try? await Task.sleep(for: timeout)
            return "no-token"
        }
        let first = await group.next() ?? "none"
        group.cancelAll()
        return first
    }
}

/// Returns a short status string. NSLog from app code is not relayed to the
/// device syslog on iOS 26, so the only reliable way to see what happened here
/// is to surface it — currently into the Live Activity's own text.
private func postLiveActivityToken(_ tokenData: Data, room: String, question: String = "") async -> String {
    let d = IntentConfig.defaults
    guard let secret = d.string(forKey: IntentConfig.secret), !secret.isEmpty else {
        return "no-secret"
    }
    let apiBase = d.string(forKey: IntentConfig.apiBase) ?? "https://construct.kafagoz.com"
    let token = tokenData.map { String(format: "%02x", $0) }.joined()
    // question travels with the token so the gateway can echo it in the reply's
    // content-state — the gateway only knows the room and bender's reply, not
    // what was asked.
    guard let result = await intentPost("\(apiBase)/api/live-activity", secret: secret,
                                        body: ["roomId": room, "token": token, "question": question]) else {
        return "post-failed"
    }
    return (result["ok"] as? Bool) == true ? "registered" : "rejected:\(result)"
}

/// Clears the room's tokens once an activity ends, so the gateway stops pushing
/// into a dismissed activity.
private func clearLiveActivityTokens(room: String) async {
    let d = IntentConfig.defaults
    guard let secret = d.string(forKey: IntentConfig.secret), !secret.isEmpty else { return }
    let apiBase = d.string(forKey: IntentConfig.apiBase) ?? "https://construct.kafagoz.com"
    _ = await intentPost("\(apiBase)/api/live-activity", secret: secret,
                         body: ["roomId": room, "action": "end"])
}

/// Flips the room's Live Activity to the "Thinking…" loading state, echoing the
/// just-tapped quick reply as the question. Gives instant "sent" feedback (the
/// working ring appears) before bender's reply pushes in and replaces it.
@available(iOS 16.2, *)
private func markActivitySending(room: String, question: String) async {
    for activity in Activity<ConstructActivityAttributes>.activities
    where activity.content.state.roomId == room || activity.content.state.roomId.isEmpty {
        let sending = ConstructActivityAttributes.ContentState(
            status: "Thinking…", question: question, detail: "", roomId: room)
        await activity.update(.init(state: sending, staleDate: .now + 900))
    }
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

private func intentGet(_ urlString: String, secret: String) async -> [String: Any]? {
    guard let url = URL(string: urlString) else { return nil }
    var req = URLRequest(url: url)
    req.setValue(secret, forHTTPHeaderField: "x-intent-secret")
    req.timeoutInterval = 12
    guard let (data, _) = try? await URLSession.shared.data(for: req) else { return nil }
    return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
}

/// On app foreground, drop server-side Live Activity tokens whose activity is no
/// longer on screen — otherwise the gateway keeps suppressing this room's phone
/// notifications, thinking a Live Activity will show the message.
///
/// Only reconciles when NO activity is active: the loading ("Thinking…") state
/// carries no roomId, so an active activity can't be reliably mapped to a room,
/// and we won't risk clearing a live one. With none active, every registered
/// token is stale and safe to clear.
@available(iOS 16.2, *)
private func reconcileLiveActivityTokens() async {
    guard Activity<ConstructActivityAttributes>.activities.allSatisfy({ $0.activityState != .active }) else { return }
    let d = IntentConfig.defaults
    guard let secret = d.string(forKey: IntentConfig.secret), !secret.isEmpty else { return }
    let apiBase = d.string(forKey: IntentConfig.apiBase) ?? "https://construct.kafagoz.com"
    guard let result = await intentGet("\(apiBase)/api/live-activity", secret: secret),
          let rooms = result["rooms"] as? [[String: Any]] else { return }
    for entry in rooms {
        if let roomId = entry["roomId"] as? String {
            await clearLiveActivityTokens(room: roomId)
        }
    }
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

/// Shared "ask" flow behind the message and screenshot intents: start a
/// push-token Live Activity, run the caller's `send`, then watch the room ~30s
/// and update/wind down the activity (leaving it live for the gateway's push
/// if the reply is slower than the polling window).
@available(iOS 17.0, *)
private func runAskWatch(room: String, apiBase: String, secret: String,
                         initialDetail: String, send: () async -> Void) async {
    let attributes = ConstructActivityAttributes(roomName: "Bender")
    // The question rides in its own field so it stays visible (faded) once the
    // reply replaces `detail`; `detail` is empty while waiting.
    let thinking = ConstructActivityAttributes.ContentState(status: "Thinking…", question: initialDetail, detail: "")
    // Reuse a running activity rather than stacking a second one: asking again
    // while an activity is on screen should replace its content, not leave the
    // previous one orphaned.
    // Reuse an active or stale activity; dismiss anything else still on screen.
    // An ended activity lingers for its dismissal window and is still visible,
    // so leaving it there while starting a new one is what produced duplicates.
    let all = Activity<ConstructActivityAttributes>.activities
    let reusable = all.first { $0.activityState == .active || $0.activityState == .stale }
    for other in all where other.id != reusable?.id {
        await other.end(nil, dismissalPolicy: .immediate)
    }

    // Drop the stored token before registering a new one. Ending an activity
    // does not invalidate its push token server-side, so a token belonging to
    // the activity just dismissed would linger for its full TTL — and APNs
    // returns 200 for a push aimed at a dead activity, so the failure is
    // completely silent. Better to hold no token than a stale one.
    if reusable == nil { await clearLiveActivityTokens(room: room) }

    let activity: Activity<ConstructActivityAttributes>?
    if let existing = reusable {
        await existing.update(.init(state: thinking, staleDate: nil))
        activity = existing
    } else {
        // pushType: .token is what makes ActivityKit mint a push token; without
        // it the activity can only ever be updated from a running app.
        activity = try? Activity.request(attributes: attributes,
                                         content: .init(state: thinking, staleDate: nil),
                                         pushType: .token)
    }
    await send()

    // Register the activity's push token, then return. The intent's job is done
    // once the message is sent and the gateway knows where to push: the reply is
    // delivered by api/matrix-push.js whenever bender answers, however long that
    // takes.
    //
    // This used to poll wait-reply for 15–30s before returning, which was only
    // ever a stand-in for push. It cost a visible hang in the Dynamic Island, it
    // ran the action against the Shortcuts background budget (producing "an
    // unknown error occurred"), and its clear-on-reply deleted the token before
    // any push could use it — so the fast path actively prevented the slow path
    // from ever working.
    //
    // Awaited rather than detached: this process is torn down when perform()
    // returns, which would kill a fire-and-forget registration.
    let tokenStatus = activity == nil ? "no-activity"
                                      : await awaitLiveActivityToken(activity!, room: room, question: initialDetail)

    // staleDate dims the activity if the push never lands, rather than leaving a
    // confident working state on the lock screen indefinitely.
    if let activity {
        // Registration failures leave the activity unreachable by push, so
        // say so rather than waiting forever on a reply that can't arrive.
        let waiting = ConstructActivityAttributes.ContentState(
            status: "Thinking…",
            question: initialDetail,
            detail: tokenStatus == "registered" ? "" : "push unavailable (\(tokenStatus))")
        await activity.update(.init(state: waiting, staleDate: .now + 900))
    }
}

/// Shortcut entry point: send a dictated message and surface the reply in a
/// Live Activity — no app launch. LiveActivityIntent grants the background
/// permission to start/update Live Activities.
@available(iOS 17.0, *)
struct AskConstructIntent: AppIntent, LiveActivityIntent {
    static let title: LocalizedStringResource = "Ask Construct"
    static let description = IntentDescription("Send a message to Construct and watch for the reply on the lock screen.")

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

        await runAskWatch(room: room, apiBase: apiBase, secret: secret, initialDetail: message) {
            _ = await intentPost("\(apiBase)/api/send-message", secret: secret,
                                 body: ["room": room, "text": message, "source": "shortcut"])
        }
        return .result()
    }
}

/// One-tap quick reply from a Live Activity button: sends the chip's text back
/// to its room in the background — no app launch — over the same send-message
/// route the notification reply uses. The widget target holds a no-op twin
/// (ContructWidgetsLiveActivity.swift) that the button references; this copy is
/// what actually performs, resolved by type name in the app's AppIntents
/// metadata (same mechanism as ListenIntent).
@available(iOS 17.0, *)
struct QuickReplyIntent: AppIntent, LiveActivityIntent {
    static let title: LocalizedStringResource = "Quick Reply"
    static let description = IntentDescription("Send a suggested quick reply to Construct.")

    @Parameter(title: "Text")
    var text: String

    // Empty falls back to the default room, matching the other intents.
    @Parameter(title: "Room")
    var roomId: String

    init() {}
    init(text: String, roomId: String) {
        self.text = text
        self.roomId = roomId
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
        // Instant feedback before the network round-trip and bender's reply.
        await markActivitySending(room: room, question: trimmed)
        _ = await intentPost("\(apiBase)/api/send-message", secret: secret,
                             body: ["room": room, "text": trimmed, "source": "live-activity"])
        return .result()
    }
}

/// Shortcut entry point: send a screenshot (or any image) to Construct and
/// surface bender's reply in a Live Activity — no app launch. Pair with the
/// Shortcuts "Take Screenshot" action, which is the only thing that can capture
/// the screen (an intent can't screenshot other apps).
@available(iOS 17.0, *)
struct SendScreenshotIntent: AppIntent, LiveActivityIntent {
    static let title: LocalizedStringResource = "Send Screenshot to Construct"
    static let description = IntentDescription("Send an image to Construct and watch for the reply on the lock screen.")

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

        await runAskWatch(room: room, apiBase: apiBase, secret: secret, initialDetail: "Screenshot") {
            await intentUpload("\(apiBase)/api/send-file", secret: secret, room: room,
                               filename: "screenshot.\(ext)", contentType: mime, body: bytes)
        }
        return .result()
    }
}

/// Reliable companion to the screenshot flow: this takes no file parameter, so
/// it sidesteps the iOS-17 Shortcuts friction with IntentFile inputs. Pair it
/// with an upload done in the Shortcut itself (Take Screenshot → Get Contents
/// of URL → send-file) — this just shows the "Thinking…" Live Activity and
/// watches for bender's reply.
@available(iOS 17.0, *)
struct WatchConstructReplyIntent: AppIntent, LiveActivityIntent {
    static let title: LocalizedStringResource = "Watch Construct Reply"
    static let description = IntentDescription("Show a Live Activity and watch for Construct's reply on the lock screen.")

    init() {}

    func perform() async throws -> some IntentResult {
        let d = IntentConfig.defaults
        guard let secret = d.string(forKey: IntentConfig.secret), !secret.isEmpty else {
            throw NSError(domain: "construct", code: 1,
                          userInfo: [NSLocalizedDescriptionKey: "Open Construct once to enable this."])
        }
        let apiBase = d.string(forKey: IntentConfig.apiBase) ?? "https://construct.kafagoz.com"
        let room = d.string(forKey: IntentConfig.room) ?? "!DpRWqhWOHJAxyvjOGI:matrix.org"

        // The upload already happened in the Shortcut; just watch for the reply.
        await runAskWatch(room: room, apiBase: apiBase, secret: secret, initialDetail: "Screenshot") {}
        return .result()
    }
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
        var status: String
        var question: String = ""
        var detail: String
        // Room the reply came from, so a quick-reply button can send back to it.
        // Empty until the gateway's reply push fills it. Defaulted for decode.
        var roomId: String = ""
        // Bender's [[CTA]] chips, sent as one-tap QuickReplyIntent buttons.
        var actions: [String] = []
    }

    var roomName: String
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
        CAPPluginMethod(name: "donateShareTargets", returnType: CAPPluginReturnPromise)
    ]

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
        call.resolve()
        DispatchQueue.global(qos: .utility).async {
            // Resync: drop previous donations so rooms the user turned off in
            // Settings stop appearing, then donate the current enabled set.
            INInteraction.deleteAll { _ in }
            for (roomId, name, avatar) in items {
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

    @objc func start(_ call: CAPPluginCall) {
        guard #available(iOS 16.2, *) else {
            call.reject("Live Activities require iOS 16.2 or later")
            return
        }
        let attributes = ConstructActivityAttributes(roomName: call.getString("roomName") ?? "Construct")
        let question = call.getString("question") ?? ""
        let state = ConstructActivityAttributes.ContentState(
            status: call.getString("status") ?? "",
            question: question,
            detail: call.getString("detail") ?? ""
        )
        do {
            let activity = try Activity.request(
                attributes: attributes,
                content: .init(state: state, staleDate: nil),
                pushType: .token
            )
            // Only rooms we can address can receive pushed updates; without a
            // roomId the activity still works, just app-driven as before.
            if let room = call.getString("roomId") {
                trackLiveActivityToken(activity, room: room, question: question)
            }
            call.resolve(["activityId": activity.id])
        } catch {
            call.reject("Failed to start Live Activity: \(error.localizedDescription)")
        }
    }

    @objc func update(_ call: CAPPluginCall) {
        guard #available(iOS 16.2, *) else {
            call.reject("Live Activities require iOS 16.2 or later")
            return
        }
        let state = ConstructActivityAttributes.ContentState(
            status: call.getString("status") ?? "",
            question: call.getString("question") ?? "",
            detail: call.getString("detail") ?? ""
        )
        Task {
            for activity in Activity<ConstructActivityAttributes>.activities {
                await activity.update(.init(state: state, staleDate: nil))
            }
            call.resolve()
        }
    }

    @objc func end(_ call: CAPPluginCall) {
        guard #available(iOS 16.2, *) else {
            call.reject("Live Activities require iOS 16.2 or later")
            return
        }
        Task {
            // Clear tokens first, so the gateway can't push into an activity
            // that is about to be dismissed.
            if let room = call.getString("roomId") {
                await clearLiveActivityTokens(room: room)
            }
            for activity in Activity<ConstructActivityAttributes>.activities {
                await activity.end(nil, dismissalPolicy: .immediate)
            }
            call.resolve()
        }
    }
}

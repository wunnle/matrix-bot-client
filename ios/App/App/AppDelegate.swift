import UIKit
import Capacitor
import ActivityKit
import Speech
import AVFoundation
import AppIntents

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        // Override point for customization after application launch.
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
/// webview, so they can't reach import.meta.env). Persisted in UserDefaults.
enum IntentConfig {
    static let secret = "construct.intentSecret"
    static let apiBase = "construct.apiBase"
    static let room = "construct.defaultRoom"
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
        let d = UserDefaults.standard
        guard let secret = d.string(forKey: IntentConfig.secret), !secret.isEmpty else {
            throw $message.needsValueError("Open Construct once to enable Shortcut sending.")
        }
        let apiBase = d.string(forKey: IntentConfig.apiBase) ?? "https://construct.kafagoz.com"
        let room = d.string(forKey: IntentConfig.room) ?? "!DpRWqhWOHJAxyvjOGI:matrix.org"

        // 1. Start the Live Activity ("Thinking…").
        let attributes = ConstructActivityAttributes(roomName: "Bender")
        let thinking = ConstructActivityAttributes.ContentState(status: "Thinking…", detail: message)
        let activity = try? Activity.request(attributes: attributes, content: .init(state: thinking, staleDate: nil))

        let since = Int(Date().timeIntervalSince1970 * 1000)

        // 2. Send the message.
        _ = await intentPost("\(apiBase)/api/send-message", secret: secret,
                             body: ["room": room, "text": message, "source": "shortcut"])

        // 3. Watch for the reply (each call long-polls ~9s server-side).
        var reply: String?
        for _ in 0..<2 {
            if let r = await intentPost("\(apiBase)/api/wait-reply", secret: secret,
                                        body: ["room": room, "since": since]),
               let body = r["reply"] as? String {
                reply = body
                break
            }
        }

        // 4. Update + wind down the activity.
        if let activity = activity {
            let final = ConstructActivityAttributes.ContentState(
                status: reply != nil ? "Reply" : "Still thinking…",
                detail: reply ?? "Open Construct to see the reply."
            )
            await activity.update(.init(state: final, staleDate: nil))
            await activity.end(.init(state: final, staleDate: nil), dismissalPolicy: .after(.now + 30))
        }

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
        var detail: String
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
        CAPPluginMethod(name: "saveIntentConfig", returnType: CAPPluginReturnPromise)
    ]

    /// Persist the config the background AskConstructIntent needs (it has no
    /// access to the webview's env). Called once per launch from JS.
    @objc func saveIntentConfig(_ call: CAPPluginCall) {
        let d = UserDefaults.standard
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
        let state = ConstructActivityAttributes.ContentState(
            status: call.getString("status") ?? "",
            detail: call.getString("detail") ?? ""
        )
        do {
            let activity = try Activity.request(
                attributes: attributes,
                content: .init(state: state, staleDate: nil)
            )
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
            for activity in Activity<ConstructActivityAttributes>.activities {
                await activity.end(nil, dismissalPolicy: .immediate)
            }
            call.resolve()
        }
    }
}

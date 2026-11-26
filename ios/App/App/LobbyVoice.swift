import UIKit
import SwiftUI
import Speech
import AVFoundation
import NaturalLanguage

// MARK: - Lobby voice overlay
//
// "Listen in Lobby" (ListenInLobbyIntent, Action Button) opens this instead of
// the in-chat dictation: a full-screen native layer over the web view that
// listens, sends to the Lobby on a pause, waits for the expert's answer and
// reads it aloud, like a Siri answer. Native only, so it ships with a build;
// the web app underneath is untouched.

/// Presents the overlay over whatever is on screen. A cold launch from the
/// Action Button runs the intent before the window exists, so it retries for a
/// few seconds.
@MainActor
enum LobbyVoice {
    private static weak var current: UIViewController?

    /// False when the app has no homeserver session saved yet (never signed in
    /// on this build); the caller falls back to the in-chat dictation.
    static var canRun: Bool { LobbyMatrix.load() != nil }

    static func present(attempt: Int = 0) {
        guard current == nil else { return }
        guard let top = topViewController() else {
            if attempt < 40 {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { present(attempt: attempt + 1) }
            }
            return
        }
        let model = LobbyVoiceModel()
        let host = UIHostingController(rootView: LobbyVoiceView(model: model))
        host.modalPresentationStyle = .overFullScreen
        host.modalTransitionStyle = .crossDissolve
        host.view.backgroundColor = .clear
        model.onFinish = { [weak host] showLobby in
            host?.dismiss(animated: true)
            // Leave the chat on the Lobby so the conversation is right there.
            if showLobby, let url = lobbyURL("room") { UIApplication.shared.open(url) }
        }
        current = host
        top.present(host, animated: true) { model.start() }
    }

    static func lobbyURL(_ action: String) -> URL? {
        let unreserved = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-._~"))
        guard let room = LobbyRoom.id.addingPercentEncoding(withAllowedCharacters: unreserved) else { return nil }
        return URL(string: "construct://\(action)?room=\(room)")
    }

    private static func topViewController() -> UIViewController? {
        let windows = UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .filter { $0.activationState == .foregroundActive || $0.activationState == .foregroundInactive }
            .flatMap(\.windows)
        guard var top = (windows.first(where: \.isKeyWindow) ?? windows.first)?.rootViewController,
              top.isViewLoaded, top.view.window != nil else { return nil }
        while let presented = top.presentedViewController { top = presented }
        return top
    }
}

/// The signed-in account, as the web layer saved it for the intents.
struct LobbyMatrix {
    let homeserver: String
    let userId: String
    let token: String

    static func load() -> LobbyMatrix? {
        let d = IntentConfig.defaults
        guard let hs = d.string(forKey: IntentConfig.homeserver), !hs.isEmpty,
              let user = d.string(forKey: IntentConfig.userId), !user.isEmpty,
              let token = d.string(forKey: IntentConfig.matrixToken), !token.isEmpty else { return nil }
        return LobbyMatrix(homeserver: hs.hasSuffix("/") ? String(hs.dropLast()) : hs, userId: user, token: token)
    }

    private static let unreserved = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-._~"))

    func get(_ path: String) async -> [String: Any]? {
        guard let data = await getData(path) else { return nil }
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    }

    func getData(_ path: String) async -> Data? {
        guard let url = URL(string: homeserver + path) else { return nil }
        var req = URLRequest(url: url)
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.timeoutInterval = 10
        guard let (data, resp) = try? await URLSession.shared.data(for: req),
              (resp as? HTTPURLResponse)?.statusCode == 200 else { return nil }
        return data
    }

    /// Newest first, like the homeserver returns them.
    func recentEvents(room: String, limit: Int = 30) async -> [[String: Any]] {
        guard let r = room.addingPercentEncoding(withAllowedCharacters: Self.unreserved) else { return [] }
        let filter = #"{"types":["m.room.message","m.room.encrypted","com.construct.room_status"]}"#
            .addingPercentEncoding(withAllowedCharacters: Self.unreserved) ?? ""
        let json = await get("/_matrix/client/v3/rooms/\(r)/messages?dir=b&limit=\(limit)&filter=\(filter)")
        return json?["chunk"] as? [[String: Any]] ?? []
    }

    struct Profile {
        var name: String
        var avatar: UIImage?
    }

    /// Display name and a small avatar (authenticated media, so it needs the token).
    func profile(_ user: String) async -> Profile {
        let fallback = LobbyReplyText.localpart(user)
        guard let u = user.addingPercentEncoding(withAllowedCharacters: Self.unreserved),
              let json = await get("/_matrix/client/v3/profile/\(u)") else { return Profile(name: fallback) }
        var p = Profile(name: (json["displayname"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? fallback)
        if let mxc = json["avatar_url"] as? String, mxc.hasPrefix("mxc://") {
            let parts = mxc.dropFirst(6).split(separator: "/", maxSplits: 1)
            if parts.count == 2,
               let data = await getData("/_matrix/client/v1/media/thumbnail/\(parts[0])/\(parts[1])?width=96&height=96&method=crop") {
                p.avatar = UIImage(data: data)
            }
        }
        return p
    }
}

// MARK: Model

@MainActor
final class LobbyVoiceModel: NSObject, ObservableObject {
    enum Phase: Equatable { case starting, listening, sending, waiting, speaking, done, failed }

    @Published var phase: Phase = .starting
    @Published var transcript = ""
    @Published var level: CGFloat = 0
    @Published var status = ""
    @Published var replySender = ""
    @Published var replyAvatar: UIImage?
    /// Who looks like they're answering, while it waits.
    @Published var agentName = ""
    @Published var agentAvatar: UIImage?
    @Published var agentDoing = ""
    @Published var replyText = ""

    /// true: leave the chat on the Lobby afterwards.
    var onFinish: ((Bool) -> Void)?

    private let engine = AVAudioEngine()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var silenceTimer: Timer?
    private var noSpeechTimer: Timer?
    private let synth = AVSpeechSynthesizer()
    private var watch: Task<Void, Never>?
    private var finished = false

    /// Silence after the last word before it sends on its own.
    private let pauseToSend: TimeInterval = 1.6
    /// How long the overlay waits for an expert before handing over to the chat.
    private let replyTimeout: TimeInterval = 150

    override init() {
        super.init()
        synth.delegate = self
    }

    func start() {
        status = "Listening…"
        SFSpeechRecognizer.requestAuthorization { auth in
            AVAudioSession.sharedInstance().requestRecordPermission { mic in
                Task { @MainActor in
                    guard auth == .authorized, mic else {
                        self.fail("Allow the microphone and speech recognition for Construct in Settings.")
                        return
                    }
                    self.beginListening()
                }
            }
        }
    }

    private func beginListening() {
        guard let recognizer = SFSpeechRecognizer(locale: Locale.current) ?? SFSpeechRecognizer(),
              recognizer.isAvailable else {
            fail("Speech recognition isn't available right now.")
            return
        }
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playAndRecord, mode: .measurement, options: [.duckOthers, .defaultToSpeaker])
            try session.setActive(true, options: .notifyOthersOnDeactivation)

            let req = SFSpeechAudioBufferRecognitionRequest()
            req.shouldReportPartialResults = true
            if recognizer.supportsOnDeviceRecognition { req.requiresOnDeviceRecognition = true }
            request = req

            let input = engine.inputNode
            let format = input.outputFormat(forBus: 0)
            Self.installTap(on: input, format: format, request: req) { [weak self] level in
                Task { @MainActor in self?.level = level }
            }
            engine.prepare()
            try engine.start()
        } catch {
            fail("Couldn't start the microphone.")
            return
        }

        phase = .listening
        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
        task = recognizer.recognitionTask(with: request!) { [weak self] result, error in
            Task { @MainActor in
                guard let self, self.phase == .listening else { return }
                if let result {
                    self.transcript = result.bestTranscription.formattedString
                    self.armSilenceTimer()
                    if result.isFinal { self.finishListening() }
                } else if error != nil {
                    self.finishListening()
                }
            }
        }
        // Nothing said at all: close quietly.
        noSpeechTimer = Timer.scheduledTimer(withTimeInterval: 8, repeats: false) { [weak self] _ in
            Task { @MainActor in
                guard let self, self.phase == .listening,
                      self.transcript.trimmingCharacters(in: .whitespaces).isEmpty else { return }
                self.cancel()
            }
        }
    }

    private func armSilenceTimer() {
        noSpeechTimer?.invalidate()
        silenceTimer?.invalidate()
        silenceTimer = Timer.scheduledTimer(withTimeInterval: pauseToSend, repeats: false) { [weak self] _ in
            Task { @MainActor in self?.finishListening() }
        }
    }

    private func stopAudio() {
        silenceTimer?.invalidate(); silenceTimer = nil
        noSpeechTimer?.invalidate(); noSpeechTimer = nil
        if engine.isRunning {
            engine.stop()
            engine.inputNode.removeTap(onBus: 0)
        }
        request?.endAudio(); request = nil
        task?.cancel(); task = nil
        level = 0
    }

    /// Tap while listening: send what's there now.
    func finishListening() {
        guard phase == .listening else { return }
        stopAudio()
        let text = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { cancel(); return }
        send(text)
    }

    private func send(_ text: String) {
        phase = .sending
        status = "Sending…"
        let secret = IntentConfig.defaults.string(forKey: IntentConfig.secret) ?? ""
        watch = Task { [weak self] in
            let sentAt = Date().timeIntervalSince1970 * 1000
            // Same shape as SendToLobbyIntent: one 🎙️ asks for a short,
            // speakable answer.
            let eventId = await sendRoomText(room: LobbyRoom.id, text: "🎙️ \(text)", source: "siri", secret: secret)
            guard let self, !Task.isCancelled else { return }
            guard let eventId else {
                self.fail("Couldn't send to the Lobby.")
                return
            }
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            self.phase = .waiting
            self.status = "Waiting for a reply…"
            await self.waitForReplies(after: eventId, sentAt: sentAt)
        }
    }

    // MARK: Replies

    private struct Reply {
        let id: String
        let sender: String
        let ts: Double
        var body: String
        var encrypted: Bool
        var changedAt: Date
    }

    private var replies: [String: Reply] = [:]
    private var spoken: Set<String> = []
    private var speakingDone = Date.distantPast

    private func waitForReplies(after eventId: String, sentAt: Double) async {
        guard let mx = LobbyMatrix.load() else { fail("Not signed in."); return }
        var profiles: [String: LobbyMatrix.Profile] = [:]
        func profile(_ user: String) async -> LobbyMatrix.Profile {
            if let p = profiles[user] { return p }
            let p = await mx.profile(user)
            profiles[user] = p
            return p
        }
        let started = Date()
        while !Task.isCancelled && !finished {
            let events = await mx.recentEvents(room: LobbyRoom.id)
            // Newest first: the first sign of an agent at work since the send.
            var working: (sender: String, doing: String)?
            for e in events {
                guard let id = e["event_id"] as? String, id != eventId,
                      let sender = e["sender"] as? String, sender != mx.userId,
                      let ts = e["origin_server_ts"] as? Double, ts >= sentAt - 2000 else { continue }
                let type = e["type"] as? String
                let content = e["content"] as? [String: Any] ?? [:]
                if type == "com.construct.room_status" {
                    // Room state the Claude bot keeps (scripts/room-status.mjs).
                    if working == nil, let a = content["activity"] as? [String: Any] {
                        switch a["phase"] as? String {
                        case "thinking": working = (sender, "Thinking")
                        case "tool": working = (sender, (a["tool"] as? String).map { "Running \($0)" } ?? "Working")
                        default: break
                        }
                    }
                    continue
                }
                if working == nil, let body = (content["m.new_content"] as? [String: Any])?["body"] as? String
                    ?? content["body"] as? String, LobbyReplyText.isNoise(body) {
                    working = (sender, LobbyReplyText.toolName(body).map { "Running \($0)" } ?? "Working")
                }
                if type == "m.room.encrypted" {
                    if replies[id] == nil {
                        replies[id] = Reply(id: id, sender: sender, ts: ts, body: "", encrypted: true, changedAt: Date())
                    }
                    continue
                }
                // Streaming agents edit their message as they go; follow the
                // edit onto the message it replaces.
                if let rel = content["m.relates_to"] as? [String: Any], rel["rel_type"] as? String == "m.replace" {
                    guard let target = rel["event_id"] as? String,
                          let newBody = (content["m.new_content"] as? [String: Any])?["body"] as? String,
                          var r = replies[target], r.body != newBody else { continue }
                    r.body = newBody
                    r.changedAt = Date()
                    replies[target] = r
                    continue
                }
                guard replies[id] == nil, let body = content["body"] as? String,
                      content["com.construct.machine"] == nil else { continue }
                replies[id] = Reply(id: id, sender: sender, ts: ts, body: body, encrypted: false, changedAt: Date())
            }

            if phase == .waiting, let working {
                let p = await profile(working.sender)
                agentName = p.name
                agentAvatar = p.avatar
                agentDoing = working.doing
                status = ""
            }

            if phase == .waiting || phase == .done {
                // The earliest unspoken answer whose edits have settled.
                let next = replies.values
                    .filter { !spoken.contains($0.id) && ($0.encrypted || !LobbyReplyText.isNoise($0.body)) }
                    .sorted { $0.ts < $1.ts }
                    .first
                if let next, Date().timeIntervalSince(next.changedAt) > 2.5 {
                    spoken.insert(next.id)
                    let p = await profile(next.sender)
                    replyAvatar = p.avatar
                    speak(next, from: p.name)
                } else if let next, phase == .waiting {
                    let p = await profile(next.sender)
                    agentName = p.name
                    agentAvatar = p.avatar
                    agentDoing = "Answering"
                    status = ""
                } else if phase == .done, Date().timeIntervalSince(speakingDone) > 4 {
                    // Spoke everything and nothing more came: hand over to the chat.
                    close(showLobby: true)
                    return
                }
            }

            if spoken.isEmpty, Date().timeIntervalSince(started) > replyTimeout {
                status = "Still working. The reply will be in the Lobby."
                try? await Task.sleep(nanoseconds: 2_000_000_000)
                close(showLobby: true)
                return
            }
            try? await Task.sleep(nanoseconds: 1_500_000_000)
        }
    }

    private func speak(_ reply: Reply, from name: String) {
        let sameSpeaker = !replyText.isEmpty && replySender == name
        replySender = name
        phase = .speaking
        status = ""
        guard !reply.encrypted else {
            replyText = "Replied in an encrypted message. Open the Lobby to read it."
            phase = .done
            speakingDone = Date()
            return
        }
        let text = LobbyReplyText.forDisplay(reply.body)
        replyText = sameSpeaker ? replyText + "\n\n" + text : text
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .spokenAudio, options: [.duckOthers])
        try? AVAudioSession.sharedInstance().setActive(true)
        let utterance = AVSpeechUtterance(string: LobbyReplyText.forSpeech(reply.body))
        let pick = LobbyReplyText.voice(for: text)
        utterance.voice = pick.voice
        if !pick.downloaded {
            status = "For a better voice, download a Premium one in Settings → Accessibility → Read & Speak → Voices."
        }
        synth.speak(utterance)
    }

    // MARK: Ending

    /// Tap during the answer: stop talking and go to the chat.
    func skip() {
        synth.stopSpeaking(at: .immediate)
        close(showLobby: true)
    }

    func cancel() {
        close(showLobby: phase == .waiting || phase == .speaking || phase == .done)
    }

    private func fail(_ message: String) {
        stopAudio()
        phase = .failed
        status = message
        UINotificationFeedbackGenerator().notificationOccurred(.error)
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) { [weak self] in self?.close(showLobby: false) }
    }

    private func close(showLobby: Bool) {
        guard !finished else { return }
        finished = true
        watch?.cancel()
        stopAudio()
        synth.stopSpeaking(at: .immediate)
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        onFinish?(showLobby)
    }

    /// Built outside the main actor: the tap runs on the audio thread.
    nonisolated private static func installTap(on input: AVAudioInputNode, format: AVAudioFormat,
                                               request: SFSpeechAudioBufferRecognitionRequest,
                                               level: @escaping (CGFloat) -> Void) {
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
            request.append(buffer)
            level(rms(buffer))
        }
    }

    nonisolated private static func rms(_ buffer: AVAudioPCMBuffer) -> CGFloat {
        guard let data = buffer.floatChannelData?[0] else { return 0 }
        let n = Int(buffer.frameLength)
        guard n > 0 else { return 0 }
        var sum: Float = 0
        for i in 0..<n { sum += data[i] * data[i] }
        let db = 20 * log10(max(sqrt(sum / Float(n)), 0.000_01))
        // -50 dB (quiet room) … -10 dB (talking close) → 0…1
        return CGFloat(min(max((db + 50) / 40, 0), 1))
    }
}

extension LobbyVoiceModel: AVSpeechSynthesizerDelegate {
    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        Task { @MainActor in
            guard self.phase == .speaking else { return }
            self.phase = .done
            self.speakingDone = Date()
        }
    }
}

// MARK: Reply text

/// Port of api/_push.js suppressReason: tool progress, "thinking" lines and
/// code-only posts are not an answer.
enum LobbyReplyText {
    private static let toolProgress = try! NSRegularExpression(
        pattern: #"^(?:\*\s*)?\S\S?\s+\w[\w./-]*(?::\s+".{0,80}"(?:\s+\(×\d+\))?|\.\.\.)\s*$"#)
    private static let toolHead = try! NSRegularExpression(pattern: #"^[^\x00-\x7F]\S?\s+\w[\w./-]*$"#)

    private static func matches(_ re: NSRegularExpression, _ s: String) -> Bool {
        re.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)) != nil
    }

    private static func lines(_ s: String) -> [String] {
        s.components(separatedBy: "\n").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
    }

    static func isNoise(_ body: String) -> Bool {
        let all = lines(body)
        if all.isEmpty { return true }
        if all.allSatisfy({ matches(toolProgress, $0) }) { return true }
        if body.contains("```") {
            let prose = lines(replace(body, #"```[\s\S]*?(?:```|$)"#, ""))
            if prose.isEmpty { return true }
            if prose.allSatisfy({ matches(toolHead, $0) || matches(toolProgress, $0) }) { return true }
        }
        return false
    }

    private static func replace(_ s: String, _ pattern: String, _ with: String) -> String {
        s.replacingOccurrences(of: pattern, with: with, options: .regularExpression)
    }

    /// Markdown stripped, the way the notification shows it.
    static func forDisplay(_ body: String) -> String {
        var s = body
        s = replace(s, #"```[\s\S]*?(?:```|$)"#, "")
        s = replace(s, #"\[\[([^\]]{1,40})\]\]"#, "")          // quick-reply chips
        s = replace(s, #"!\[[^\]]*\]\([^)]*\)"#, "")            // images
        s = replace(s, #"\[([^\]]+)\]\([^)]*\)"#, "$1")         // links
        s = replace(s, #"`([^`]+)`"#, "$1")
        s = replace(s, #"(\*\*|__)(.+?)\1"#, "$2")
        s = replace(s, #"(?m)^\s{0,3}#{1,6}\s+"#, "")
        s = replace(s, #"(?m)^\s*[-*+]\s+"#, "• ")
        s = replace(s, #"(?m)^\s*>\s?"#, "")
        s = replace(s, #"\n{3,}"#, "\n\n")
        return s.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    static func forSpeech(_ body: String) -> String {
        var s = forDisplay(body)
        s = replace(s, #"https?://\S+"#, "")
        s = s.replacingOccurrences(of: "• ", with: "")
        s = s.replacingOccurrences(of: "*", with: "")
        s = s.replacingOccurrences(of: "🎙️", with: "")
        return s
    }

    /// The reply's language, English or Turkish only. Unconstrained, a short
    /// answer like "Living room: 22.5°C" read as Spanish; when it isn't sure,
    /// it's English.
    static func language(of text: String) -> String {
        let recognizer = NLLanguageRecognizer()
        recognizer.languageConstraints = [.english, .turkish]
        recognizer.languageHints = [.english: 0.7, .turkish: 0.3]
        recognizer.processString(text)
        let guess = recognizer.languageHypotheses(withMaximum: 1).first
        if let guess, guess.key == .turkish, guess.value > 0.8 { return "tr" }
        return "en"
    }

    /// The voice for this reply: the one picked in Settings, else the best installed.
    static func voice(for text: String) -> (voice: AVSpeechSynthesisVoice?, downloaded: Bool) {
        LobbyVoiceChoice.voice(language(of: text))
    }

    /// "💻 terminal: \"ls\"" → "terminal".
    static func toolName(_ body: String) -> String? {
        guard let line = lines(body.replacingOccurrences(of: "```", with: "\n")).first,
              matches(toolProgress, line) || matches(toolHead, line) else { return nil }
        let words = line.split(separator: " ")
        guard words.count >= 2 else { return nil }
        return String(words[1]).trimmingCharacters(in: CharacterSet(charactersIn: ":."))
    }

    static func localpart(_ user: String) -> String {
        let s = user.hasPrefix("@") ? String(user.dropFirst()) : user
        return String(s.split(separator: ":").first ?? Substring(s))
    }
}

// MARK: View

struct LobbyVoiceView: View {
    @ObservedObject var model: LobbyVoiceModel

    var body: some View {
        ZStack {
            Rectangle()
                .fill(.ultraThinMaterial)
                .environment(\.colorScheme, .dark)
                .overlay(Color.black.opacity(0.35))
                .ignoresSafeArea()

            SiriEdge(level: model.level, active: model.phase != .failed,
                     calm: model.phase == .waiting || model.phase == .sending)
                .ignoresSafeArea()

            VStack(alignment: .leading, spacing: 14) {
                HStack {
                    Label("Lobby", systemImage: "waveform")
                        .font(.subheadline.weight(.semibold))
                        .foregroundColor(.white.opacity(0.7))
                    Spacer()
                    Button(action: model.cancel) {
                        Image(systemName: "xmark")
                            .font(.system(size: 15, weight: .bold))
                            .foregroundColor(.white)
                            .frame(width: 34, height: 34)
                            .background(Circle().fill(Color.white.opacity(0.18)))
                    }
                    .accessibilityLabel("Close")
                }
                Spacer()

                if !model.replyText.isEmpty {
                    if !model.replySender.isEmpty {
                        AgentBadge(name: model.replySender, avatar: model.replyAvatar, doing: nil)
                    }
                    ScrollView {
                        Text(model.replyText)
                            .font(.system(size: 24, weight: .medium, design: .rounded))
                            .foregroundColor(.white)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .frame(maxHeight: 420)
                } else {
                    Text(model.transcript.isEmpty ? " " : model.transcript)
                        .font(.system(size: 30, weight: .semibold, design: .rounded))
                        .foregroundColor(model.phase == .listening ? .white : .white.opacity(0.6))
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .animation(.easeOut(duration: 0.15), value: model.transcript)
                }

                if model.replyText.isEmpty, !model.agentName.isEmpty,
                   model.phase == .waiting || model.phase == .speaking {
                    AgentBadge(name: model.agentName, avatar: model.agentAvatar, doing: model.agentDoing)
                        .transition(.opacity.combined(with: .move(edge: .bottom)))
                }

                if !model.status.isEmpty {
                    Text(model.status)
                        .font(.callout)
                        .foregroundColor(.white.opacity(0.6))
                }
            }
            .padding(.horizontal, 24)
            .padding(.top, 12)
            .padding(.bottom, 56)
        }
        .contentShape(Rectangle())
        .onTapGesture {
            switch model.phase {
            case .listening: model.finishListening()
            case .speaking, .done: model.skip()
            default: break
            }
        }
    }
}

/// Who's answering: avatar (or initial) in a capsule, with what they're doing.
struct AgentBadge: View {
    var name: String
    var avatar: UIImage?
    var doing: String?

    var body: some View {
        HStack(spacing: 8) {
            Group {
                if let avatar {
                    Image(uiImage: avatar).resizable().scaledToFill()
                } else {
                    Text(String(name.prefix(1)).uppercased())
                        .font(.system(size: 13, weight: .bold))
                        .foregroundColor(.white)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .background(Color.white.opacity(0.25))
                }
            }
            .frame(width: 26, height: 26)
            .clipShape(Circle())
            Text(name)
                .font(.subheadline.weight(.semibold))
                .foregroundColor(.white)
            if let doing, !doing.isEmpty {
                Text(doing)
                    .font(.subheadline)
                    .foregroundColor(.white.opacity(0.6))
                    .lineLimit(1)
            }
        }
        .padding(.leading, 4)
        .padding(.trailing, 12)
        .padding(.vertical, 4)
        .background(Capsule().fill(Color.white.opacity(0.14)))
        .animation(.easeOut(duration: 0.2), value: doing)
    }
}

/// The glowing, slowly turning rim around the screen. Thicker and brighter as
/// you speak; a slow breath while the answer is coming.
struct SiriEdge: View {
    var level: CGFloat
    var active: Bool
    var calm: Bool

    private let colors: [Color] = [
        Color(red: 0.98, green: 0.36, blue: 0.62), Color(red: 1.0, green: 0.62, blue: 0.25),
        Color(red: 0.35, green: 0.78, blue: 1.0), Color(red: 0.62, green: 0.42, blue: 1.0),
        Color(red: 0.98, green: 0.36, blue: 0.62),
    ]

    var body: some View {
        TimelineView(.animation) { timeline in
            let t = timeline.date.timeIntervalSinceReferenceDate
            let breath = calm ? (sin(t * 2.2) + 1) / 2 : 0
            let width = 6 + (calm ? breath * 6 : level * 22)
            let gradient = AngularGradient(colors: colors, center: .center, angle: .degrees(t * (calm ? 40 : 90)))
            let radius: CGFloat = 52
            ZStack {
                RoundedRectangle(cornerRadius: radius, style: .continuous)
                    .strokeBorder(gradient, lineWidth: width)
                    .blur(radius: 18)
                RoundedRectangle(cornerRadius: radius, style: .continuous)
                    .strokeBorder(gradient, lineWidth: max(width / 3, 2))
                    .blur(radius: 2)
            }
            .opacity(active ? 1 : 0.25)
            .animation(.easeOut(duration: 0.12), value: level)
        }
        .allowsHitTesting(false)
    }
}

// MARK: Voice choice

/// Which voice reads Lobby answers, per language. Settings → Lobby voice
/// (src/components/Settings.tsx) picks one through LiveActivityPlugin; with no
/// pick it's the best installed: Premium, then Enhanced (Turkish has no
/// Premium), then the basic one that ships.
enum LobbyVoiceChoice {
    static let languages = ["en", "tr"]
    private static func key(_ lang: String) -> String { "construct.lobbyVoice.\(lang)" }

    static func saved(_ lang: String) -> String? {
        IntentConfig.defaults.string(forKey: key(lang)).flatMap { $0.isEmpty ? nil : $0 }
    }

    static func save(_ lang: String, id: String?) {
        if let id, !id.isEmpty { IntentConfig.defaults.set(id, forKey: key(lang)) }
        else { IntentConfig.defaults.removeObject(forKey: key(lang)) }
    }

    /// Best first.
    static func installed(_ lang: String) -> [AVSpeechSynthesisVoice] {
        let region = Locale.current.regionCode ?? "US"
        return AVSpeechSynthesisVoice.speechVoices()
            .filter { v in
                guard v.language.hasPrefix(lang) else { return false }
                if #available(iOS 17.0, *) { return !v.voiceTraits.contains(.isNoveltyVoice) }
                return true
            }
            .sorted { a, b in
                if a.quality != b.quality { return a.quality.rawValue > b.quality.rawValue }
                let ar = a.language.hasSuffix(region), br = b.language.hasSuffix(region)
                if ar != br { return ar }
                return a.name < b.name
            }
    }

    static func quality(_ v: AVSpeechSynthesisVoice) -> String {
        switch v.quality {
        case .premium: return "premium"
        case .enhanced: return "enhanced"
        default: return "default"
        }
    }

    /// `downloaded` is false when only the basic voice is there.
    static func voice(_ lang: String) -> (voice: AVSpeechSynthesisVoice?, downloaded: Bool) {
        if let id = saved(lang), let v = AVSpeechSynthesisVoice(identifier: id) {
            return (v, v.quality != .default)
        }
        let best = installed(lang).first
        let fallback = AVSpeechSynthesisVoice(language: lang == "tr" ? "tr-TR" : "en-US")
        return (best ?? fallback, (best?.quality ?? .default) != .default)
    }

    private static let previewSynth = AVSpeechSynthesizer()

    static func preview(_ lang: String, id: String?) {
        previewSynth.stopSpeaking(at: .immediate)
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .spokenAudio, options: [.duckOthers])
        try? AVAudioSession.sharedInstance().setActive(true)
        let line = lang == "tr"
            ? "Merhaba, Lobi'deki yanıtlar böyle okunacak."
            : "Hi, this is how answers from the Lobby will sound."
        let u = AVSpeechUtterance(string: line)
        u.voice = id.flatMap { AVSpeechSynthesisVoice(identifier: $0) } ?? voice(lang).voice
        previewSynth.speak(u)
    }
}

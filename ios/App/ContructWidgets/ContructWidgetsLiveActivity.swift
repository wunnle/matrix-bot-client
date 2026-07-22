//
//  ContructWidgetsLiveActivity.swift
//  ContructWidgets
//

import ActivityKit
import AppIntents
import WidgetKit
import SwiftUI

// NOTE: this struct is intentionally duplicated in the app target
// (AppDelegate.swift). ActivityKit matches attributes across processes by
// type name and Codable shape — keep both definitions identical.
struct ConstructActivityAttributes: ActivityAttributes {
    public struct ContentState: Codable, Hashable {
        var status: String
        // The user's own message, shown faded above the reply. Defaulted so a
        // push whose content-state omits it (or an in-flight older activity)
        // still decodes.
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

/// "Reply" is the only terminal (non-working) status; everything else
/// (Listening…/Waiting…/Thinking…) shows the working ring.
private func isReply(_ status: String) -> Bool { status == "Reply" }

/// Extension-side twin of the app's QuickReplyIntent (AppDelegate.swift). The
/// quick-reply buttons below reference this so they compile; the app's copy is
/// what actually performs (resolved by type name, like ListenIntent). Keep the
/// type name and @Parameter names identical so the tap routes across.
@available(iOS 17.0, *)
struct QuickReplyIntent: AppIntent, LiveActivityIntent {
    static let title: LocalizedStringResource = "Quick Reply"

    @Parameter(title: "Text")
    var text: String

    @Parameter(title: "Room")
    var roomId: String

    init() {}
    init(text: String, roomId: String) {
        self.text = text
        self.roomId = roomId
    }

    func perform() async throws -> some IntentResult { .result() }
}

/// Fades the bottom edge to transparent, so a reply too long for the fixed
/// height trails off rather than being cut with a hard line.
private extension View {
    func bottomFade() -> some View {
        mask(
            LinearGradient(
                stops: [
                    .init(color: .black, location: 0),
                    .init(color: .black, location: 0.92),
                    .init(color: .clear, location: 1),
                ],
                startPoint: .top, endPoint: .bottom
            )
        )
    }
}

/// The reply, faded at the bottom ONLY when it's too long to fit. ViewThatFits
/// shows the full text at natural size when it fits the available height, and
/// falls back to the shrunk-and-faded version only when it doesn't — so a short
/// reply has no fade.
private struct ReplyText: View {
    let text: String
    var lines: Int
    var scale: CGFloat
    var body: some View {
        ViewThatFits(in: .vertical) {
            Text(text)
                .font(.subheadline)
                .frame(maxWidth: .infinity, alignment: .leading)
            Text(text)
                .font(.subheadline)
                .lineLimit(lines)
                .minimumScaleFactor(scale)
                .frame(maxWidth: .infinity, alignment: .leading)
                .bottomFade()
        }
    }
}

/// Bender's suggested quick-reply chips as one-tap buttons. Tapping fires
/// QuickReplyIntent, which sends the label back to the room from the background
/// without opening the app. iOS 17+ (interactive Live Activity buttons).
@available(iOS 17.0, *)
private struct QuickReplyButtons: View {
    let actions: [String]
    let roomId: String
    var body: some View {
        HStack(spacing: 8) {
            ForEach(actions.prefix(3), id: \.self) { action in
                Button(intent: QuickReplyIntent(text: action, roomId: roomId)) {
                    Text(action)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.white)
                        .lineLimit(1)
                        .minimumScaleFactor(0.8)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 7)
                        .frame(maxWidth: .infinity)
                        .background(Color.white.opacity(0.14), in: Capsule())
                }
                .buttonStyle(.plain)
            }
        }
    }
}

/// Circular room avatar.
private struct RoomAvatar: View {
    var size: CGFloat
    var body: some View {
        Image("RoomAvatar")
            .resizable()
            .scaledToFill()
            .frame(width: size, height: size)
            .clipShape(Circle())
    }
}

/// Animated activity ring. Plain ProgressView spinners render as a static
/// snapshot in Live Activities; only timer-driven progress actually animates,
/// so this fills slowly over a few minutes — enough perceptible motion.
private struct WorkingRing: View {
    var size: CGFloat = 16
    var body: some View {
        if isXcodePreview {
            // A timer-driven ProgressView is a live, always-ticking view, so the
            // Xcode canvas never settles and shows "loading" forever. Render a
            // static ring in previews; the real timer animation is on-device only.
            Circle()
                .trim(from: 0, to: 0.3)
                .stroke(Color.purple, style: StrokeStyle(lineWidth: 2, lineCap: .round))
                .rotationEffect(.degrees(-90))
                .frame(width: size, height: size)
        } else {
            ProgressView(timerInterval: Date()...Date().addingTimeInterval(180), countsDown: false) {
                EmptyView()
            } currentValueLabel: {
                EmptyView()
            }
            .progressViewStyle(.circular)
            .tint(.purple)
            .frame(width: size, height: size)
        }
    }
}

/// True when the view is rendering in Xcode's preview canvas rather than on a
/// device — used to swap out live/animating views that would stall the canvas.
private var isXcodePreview: Bool {
    ProcessInfo.processInfo.environment["XCODE_RUNNING_FOR_PREVIEWS"] == "1"
}

// MARK: - Extracted content views
//
// The Lock Screen body and the Dynamic Island bottom content are plain Views so
// they can be previewed directly (see the Previews section). ActivityKit's own
// ActivityConfiguration preview harness is unreliable and often hangs the
// canvas "loading forever"; plain-View previews render instantly.

/// Lock Screen / banner content.
struct LockScreenView: View {
    let state: ConstructActivityAttributes.ContentState
    var body: some View {
        let reply = isReply(state.status)
        HStack(alignment: .top, spacing: 12) {
            RoomAvatar(size: 40)
            if reply {
                // Answer phase. A plain line-limited Text (no ViewThatFits) so
                // the banner hugs the reply: ViewThatFits measured against a
                // smaller height than the system's final banner, truncating
                // early and leaving empty space below. Replies are gateway-
                // capped at 300 chars (~7 lines), so 10 lines shows them fully;
                // anything longer truncates with an ellipsis. Quick-reply chips
                // sit beneath it when bender suggests any.
                VStack(alignment: .leading, spacing: 12) {
                    Text(state.detail)
                        // The banner hard-caps at 160pt. With chips below, a tall
                        // reply would push them past the clip, so cap the reply's
                        // lines when actions are present to reserve room for them.
                        .font(.body)
                        .lineLimit(state.actions.isEmpty ? 10 : 3)
                        .minimumScaleFactor(0.85)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    if #available(iOS 17.0, *) {
                        if !state.actions.isEmpty {
                            QuickReplyButtons(actions: state.actions, roomId: state.roomId)
                        }
                    }
                }
            } else {
                // Loading phase: the question, faded, with a working
                // indicator beneath it.
                VStack(alignment: .leading, spacing: 6) {
                    if !state.question.isEmpty {
                        Text(state.question)
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .lineLimit(3)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    HStack(spacing: 8) {
                        WorkingRing(size: 14)
                        Text(state.detail.isEmpty ? state.status : state.detail)
                            .font(.caption)
                            .foregroundStyle(.tertiary)
                            .lineLimit(2)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .padding(.horizontal, 18)
        .padding(.vertical, 20)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// Dynamic Island expanded bottom region: the reply, or the faded question
/// while waiting. Shared by the real region and the preview mock.
struct IslandBottomView: View {
    let state: ConstructActivityAttributes.ContentState
    var body: some View {
        if isReply(state.status) {
            // Answer phase: reply, full width, with quick-reply chips beneath.
            // Fewer reply lines when chips are present so they aren't clipped.
            VStack(alignment: .leading, spacing: 12) {
                ReplyText(text: state.detail, lines: state.actions.isEmpty ? 8 : 4, scale: 0.75)
                if #available(iOS 17.0, *) {
                    if !state.actions.isEmpty {
                        QuickReplyButtons(actions: state.actions, roomId: state.roomId)
                    }
                }
            }
        } else {
            // Loading phase: the faded question.
            Text(state.question.isEmpty ? state.status : state.question)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .lineLimit(3)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

struct ContructWidgetsLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: ConstructActivityAttributes.self) { context in
            LockScreenView(state: context.state)
                // Our background is always dark, but on Mac the Live Activity
                // renders in the light color scheme, so .primary/.secondary text
                // resolved to black → black-on-black. Pin the content to dark so
                // the semantic text colors stay light everywhere.
                .environment(\.colorScheme, .dark)
                .activityBackgroundTint(Color(red: 0.07, green: 0.07, blue: 0.1))
                .activitySystemActionForegroundColor(Color.white)

        } dynamicIsland: { context in
            let reply = isReply(context.state.status)
            return DynamicIsland {
                // Room name fills the otherwise-empty top-left; the working ring
                // sits top-right while waiting.
                DynamicIslandExpandedRegion(.leading) {
                    Text(context.attributes.roomName)
                        .font(.footnote.weight(.medium))
                        .foregroundStyle(.secondary)
                        // Inset from the island's rounded top-left corner, which
                        // was clipping the name.
                        .padding(.leading, 10)
                        .padding(.top, 6)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    if !reply {
                        WorkingRing(size: 16)
                            .padding(.trailing, 4)
                    }
                }
                DynamicIslandExpandedRegion(.bottom) {
                    IslandBottomView(state: context.state)
                        // Match the room name's leading inset (10) so the reply's
                        // left edge lines up with the title above it.
                        .padding(.leading, 10)
                        .padding(.trailing, 4)
                }
            } compactLeading: {
                RoomAvatar(size: 20)
            } compactTrailing: {
                if reply {
                    Image(systemName: "bubble.left.fill")
                        .foregroundStyle(.purple)
                } else {
                    WorkingRing(size: 14)
                }
            } minimal: {
                RoomAvatar(size: 20)
            }
        }
    }
}

// MARK: - Previews
//
// Fast iteration lives here: edit a view above, and Xcode's canvas re-renders
// every state below without a build/install/push. Sample states cover the two
// phases (loading, reply) and short vs. overflow-length replies.

private extension ConstructActivityAttributes {
    static let preview = ConstructActivityAttributes(roomName: "Bender")
}

private extension ConstructActivityAttributes.ContentState {
    // Loading phase: still waiting on a reply. Non-"Reply" status shows the ring.
    static let loading = ConstructActivityAttributes.ContentState(
        status: "Thinking…",
        question: "What's the fastest way to iterate on the Live Activity UI?",
        detail: ""
    )
    // Answer phase, short: should sit solid on its last line, no fade.
    static let shortReply = ConstructActivityAttributes.ContentState(
        status: "Reply",
        question: "Is the deploy green?",
        detail: "Yes — all checks passed and it's live.",
        actions: ["Ship it", "Hold", "Details"]
    )
    // Answer phase, long: should shrink a touch then fade at the bottom.
    static let longReply = ConstructActivityAttributes.ContentState(
        status: "Reply",
        question: "Walk me through the push flow",
        detail: "The Shortcut starts an activity with a push token and registers it against the room. When bender replies, the gateway looks up the token and sends a liveactivity push with the reply in content-state plus an alert block for sound. The token is kept, so a follow-up message updates the same activity rather than starting a new one. This reply is deliberately long to exercise the shrink-then-fade behaviour."
    )
}

/// Simulated Lock Screen banner: the dark rounded container iOS draws around a
/// Live Activity, at a fixed height so the overflow/fade behaves as on device
/// (the real banner is a bounded box, not content-sized).
private struct PreviewBanner: View {
    let state: ConstructActivityAttributes.ContentState
    var body: some View {
        LockScreenView(state: state)
            .frame(width: 360, height: 150, alignment: .top)
            .background(Color(red: 0.07, green: 0.07, blue: 0.1))
            .clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
            .foregroundStyle(.white)
    }
}

/// Simulated expanded Dynamic Island: a black rounded pill with the same
/// regions the real island lays out (room name + ring on top, content below).
private struct IslandExpandedMock: View {
    let attributes: ConstructActivityAttributes
    let state: ConstructActivityAttributes.ContentState
    var body: some View {
        let reply = isReply(state.status)
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top) {
                Text(attributes.roomName)
                    .font(.footnote.weight(.medium))
                    .foregroundStyle(.secondary)
                Spacer()
                if !reply { WorkingRing(size: 16) }
            }
            IslandBottomView(state: state)
        }
        .padding(18)
        .frame(width: 360, height: 170, alignment: .top)
        .background(Color.black)
        .clipShape(RoundedRectangle(cornerRadius: 42, style: .continuous))
        .foregroundStyle(.white)
    }
}

#Preview("Lock Screen", traits: .sizeThatFitsLayout) {
    VStack(spacing: 20) {
        PreviewBanner(state: .loading)
        PreviewBanner(state: .shortReply)
        PreviewBanner(state: .longReply)
    }
    .padding()
    .preferredColorScheme(.dark)
}

#Preview("Island — expanded", traits: .sizeThatFitsLayout) {
    VStack(spacing: 20) {
        IslandExpandedMock(attributes: .preview, state: .loading)
        IslandExpandedMock(attributes: .preview, state: .shortReply)
        IslandExpandedMock(attributes: .preview, state: .longReply)
    }
    .padding()
    .preferredColorScheme(.dark)
}

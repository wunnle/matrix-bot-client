//
//  ContructWidgetsLiveActivity.swift
//  ContructWidgets
//

import ActivityKit
import AppIntents
import WidgetKit
import SwiftUI
import UIKit
import ImageIO

// NOTE: this struct is intentionally duplicated in the app target
// (AppDelegate.swift). ActivityKit matches attributes across processes by
// type name and Codable shape — keep both definitions identical.
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
        // Morning card: at most 2 tiles. When present the card draws them in
        // place of the title, and shows no countdown or buttons.
        var tiles: [Tile]? = nil

        struct Action: Codable, Hashable {
            var label: String = ""
            var send: String = ""
        }

        struct Tile: Codable, Hashable {
            // An SF Symbol name, e.g. "sun.max.fill". Anything that isn't one
            // is drawn as text, so an emoji still works.
            var icon: String = ""
            // Drawn large, e.g. "21° / 24°".
            var value: String = ""
            var sub: String? = nil
            // Same values as the card's tone; tints `sub`.
            var tone: String? = nil
        }
    }

    var activityId: String
}

// Synthesized Decodable ignores property defaults and throws on any missing key,
// and ActivityKit drops a push whose content-state doesn't decode without a
// word. Decode every field leniently so a partial push still lands.
extension ConstructActivityAttributes.ContentState {
    private enum Keys: String, CodingKey {
        case title, body, tone, progress, step, actions, roomId, roomName, endsAt, tiles
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
        tiles = try c.decodeIfPresent([Tile].self, forKey: .tiles)
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

extension ConstructActivityAttributes.ContentState.Tile {
    private enum Keys: String, CodingKey { case icon, value, sub, tone }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        icon = try c.decodeIfPresent(String.self, forKey: .icon) ?? ""
        value = try c.decodeIfPresent(String.self, forKey: .value) ?? ""
        sub = try c.decodeIfPresent(String.self, forKey: .sub)
        tone = try c.decodeIfPresent(String.self, forKey: .tone)
    }
}

/// Deep link that opens the activity's room. Same URL the app builds for a
/// notification tap, and RoomsLayout already routes it — without one, a tap
/// just opens the app wherever it happened to be.
private func roomDeepLink(_ roomId: String) -> URL? {
    guard !roomId.isEmpty else { return nil }
    var allowed = CharacterSet.urlQueryAllowed
    allowed.remove(charactersIn: "&+=?")
    guard let encoded = roomId.addingPercentEncoding(withAllowedCharacters: allowed) else { return nil }
    return URL(string: "construct://room?room=\(encoded)")
}

private extension ConstructActivityAttributes.ContentState {
    /// The tone's accent. Unknown tones fall back to neutral.
    var accent: Color { toneColor(tone) ?? .purple }

    /// The morning card's tiles (at most 3); empty on every other card.
    var shownTiles: [Tile] { Array((tiles ?? []).prefix(3)) }

    /// endsAt as a Date, only while it's still ahead — a timer view needs a
    /// non-empty range, and a finished countdown has nothing to show. Never on
    /// the morning card, which has no countdown.
    var endDate: Date? {
        guard let endsAt, shownTiles.isEmpty else { return nil }
        let date = Date(timeIntervalSince1970: endsAt)
        return date > Date() ? date : nil
    }
}

/// A tone's colour; nil for "neutral" and anything unknown, so each caller
/// picks its own neutral (the card's purple, a tile's secondary text).
private func toneColor(_ tone: String?) -> Color? {
    switch tone {
    case "success": return .green
    case "warning": return Color(red: 1.0, green: 0.72, blue: 0.2)
    case "error": return .red
    default: return nil
    }
}

/// Extension-side twin of the app's QuickReplyIntent (AppDelegate.swift). The
/// buttons below reference this so they compile; the app's copy is what
/// actually performs (resolved by type name, like ListenIntent). Keep the type
/// name and @Parameter names identical so the tap routes across.
@available(iOS 17.0, *)
struct QuickReplyIntent: AppIntent, LiveActivityIntent {
    static let title: LocalizedStringResource = "Quick Reply"

    @Parameter(title: "Text")
    var text: String

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

    func perform() async throws -> some IntentResult { .result() }
}

/// The activity's action buttons. Tapping fires QuickReplyIntent, which posts
/// the action's `send` text to the room from the background without opening
/// the app. iOS 17+ (interactive Live Activity buttons).
@available(iOS 17.0, *)
private struct ActionButtons: View {
    let state: ConstructActivityAttributes.ContentState
    let activityId: String
    var body: some View {
        HStack(spacing: 8) {
            ForEach(Array(state.actions.prefix(3).enumerated()), id: \.offset) { _, action in
                Button(intent: QuickReplyIntent(text: action.send, roomId: state.roomId,
                                                activityId: activityId)) {
                    Text(action.label)
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(.white)
                        .lineLimit(1)
                        // Three buttons share the width, so a long label shrinks
                        // rather than truncating.
                        .minimumScaleFactor(0.7)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 7)
                        .frame(maxWidth: .infinity)
                        .background(state.accent.opacity(0.3), in: Capsule())
                }
                .buttonStyle(.plain)
            }
        }
    }
}

/// Room avatars cached as files in the shared App Group container.
///
/// A Live Activity's views can't fetch anything — widget rendering has no
/// network — and the avatar is far too big for the ~4KB push payload, so the
/// image has to already be on disk when the activity draws. The app writes
/// these when it donates share targets, and the notification service extension
/// writes them when it decorates a push, which covers rooms the app has never
/// opened. Keyed by room id, which ContentState already carries.
enum AvatarCache {
    static let appGroup = "group.com.wunnle.construct"

    /// Room ids contain characters that can't go in a path (`!`, `:`), and the
    /// localpart is unique, so a straight character filter is enough.
    static func fileName(for roomId: String) -> String {
        String(roomId.map { $0.isLetter || $0.isNumber ? $0 : "_" }) + ".png"
    }

    static func url(for roomId: String) -> URL? {
        guard !roomId.isEmpty,
              let dir = FileManager.default
                .containerURL(forSecurityApplicationGroupIdentifier: appGroup)?
                .appendingPathComponent("avatars", isDirectory: true)
        else { return nil }
        return dir.appendingPathComponent(fileName(for: roomId))
    }

    /// Decoded through ImageIO at a bounded size rather than with
    /// `UIImage(data:)`. A Live Activity renders in a tiny memory budget, and a
    /// full-resolution avatar expands to tens of megabytes once decoded — enough
    /// for the system to SIGKILL the extension mid-render, which shows up as an
    /// activity that never appears rather than as a crash.
    static func image(for roomId: String) -> UIImage? {
        guard let url = url(for: roomId),
              let source = CGImageSourceCreateWithURL(url as CFURL, nil) else { return nil }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: 180,
        ]
        guard let thumb = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { return nil }
        return UIImage(cgImage: thumb)
    }
}

/// Circular room avatar — the room's own picture when one has been cached,
/// otherwise the bundled placeholder.
private struct RoomAvatar: View {
    var size: CGFloat
    var roomId: String = ""
    var body: some View {
        Group {
            if let image = AvatarCache.image(for: roomId) {
                Image(uiImage: image).resizable()
            } else {
                Image("RoomAvatar").resizable()
            }
        }
        .scaledToFill()
        .frame(width: size, height: size)
        .clipShape(Circle())
    }
}

// MARK: - Extracted content views
//
// The Lock Screen body and the Dynamic Island bottom content are plain Views so
// they can be previewed directly (see the Previews section). ActivityKit's own
// ActivityConfiguration preview harness is unreliable and often hangs the
// canvas "loading forever"; plain-View previews render instantly.

/// The step label and the endsAt countdown, in the tone's accent. Empty when
/// neither is set. The countdown is a timer-driven Text, which keeps ticking in
/// a Live Activity without any pushes. `showsTimer: false` where BigCountdown
/// already shows it.
private struct MetaLabel: View {
    let state: ConstructActivityAttributes.ContentState
    var showsTimer = true
    var body: some View {
        HStack(spacing: 6) {
            if let step = state.step, !step.isEmpty {
                Text(step)
            }
            if showsTimer, let end = state.endDate {
                // A timer Text lays out at its widest possible value and
                // left-aligns inside that, which parked it at the far left.
                // Right-align it and cap the width so it hugs the edge.
                Text(timerInterval: Date()...end, countsDown: true)
                    .multilineTextAlignment(.trailing)
                    .frame(maxWidth: 44, alignment: .trailing)
            }
        }
        .font(.caption.weight(.semibold).monospacedDigit())
        .foregroundStyle(state.accent)
        .lineLimit(1)
        .frame(maxWidth: .infinity, alignment: .trailing)
    }
}

/// The endsAt countdown as the card's hero, while it is still ahead.
///
/// A timer Text lays out at its widest possible value, so it gets a fixed
/// frame sized for the longest form it can show ("59:59" under an hour,
/// "9:59:59" beyond) and is aligned inside that: leading on the lock screen,
/// trailing in the island.
private struct BigCountdown: View {
    let state: ConstructActivityAttributes.ContentState
    let end: Date
    var trailing = false
    var body: some View {
        Text(timerInterval: Date()...end, countsDown: true)
            .font(.system(size: 34, weight: .semibold).monospacedDigit())
            .foregroundStyle(state.accent)
            .multilineTextAlignment(trailing ? .trailing : .leading)
            .lineLimit(1)
            .minimumScaleFactor(0.6)
            .frame(width: end.timeIntervalSinceNow >= 3600 ? 128 : 96,
                   alignment: trailing ? .trailing : .leading)
    }
}

/// Card title. One step above the 13pt body: no text style sits there.
private struct TitleText: View {
    let state: ConstructActivityAttributes.ContentState
    let lines: Int
    var body: some View {
        if !state.title.isEmpty {
            Text(state.title)
                .font(.system(size: 14, weight: .semibold))
                .lineLimit(lines)
        }
    }
}

/// Title over body. Fewer lines when buttons need the room: the lock screen
/// banner hard-caps its height, and overflow clips the buttons first. With a
/// countdown the title sits beside BigCountdown instead (`showsTitle: false`)
/// and the body takes at most three lines.
private struct MessageText: View {
    let state: ConstructActivityAttributes.ContentState
    var showsTitle = true
    var maxBodyLines = Int.max
    var body: some View {
        let hasActions = !state.actions.isEmpty
        VStack(alignment: .leading, spacing: 2) {
            if showsTitle {
                TitleText(state: state, lines: hasActions ? 1 : 2)
            }
            if !state.body.isEmpty {
                Text(state.body)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .lineLimit(min(hasActions ? 2 : 4, maxBodyLines))
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// A tile's icon: the SF Symbol when `name` is one (white, hierarchical),
/// otherwise the string itself as text (an emoji). `size` gives every icon
/// the same box: glyphs differ in height (moon.zzz is taller than calendar),
/// and an unboxed one shifts its tile's lines out of step with the others.
private struct TileIcon: View {
    let name: String
    var size: CGFloat? = nil
    var body: some View {
        Group {
            if UIImage(systemName: name) != nil {
                Image(systemName: name)
                    .symbolRenderingMode(.hierarchical)
                    .foregroundStyle(.white)
            } else {
                Text(name)
            }
        }
        .frame(width: size, height: size)
    }
}

/// One morning-card tile: icon and value large, `sub` small beneath it,
/// tinted by the tile's tone.
private struct TileView: View {
    let tile: ConstructActivityAttributes.ContentState.Tile
    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 6) {
                TileIcon(name: tile.icon, size: 24)
                Text(tile.value)
            }
            .font(.system(size: 20, weight: .semibold))
            .lineLimit(1)
            .minimumScaleFactor(0.6)
            // A fixed row height, so each tile's sub line starts at the same y.
            .frame(height: 26)
            if let sub = tile.sub, !sub.isEmpty {
                Text(sub)
                    .font(.caption2.weight(.medium))
                    .foregroundStyle(toneColor(tile.tone) ?? .secondary)
                    .lineLimit(1)
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(Color.white.opacity(0.08), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    }
}

/// The morning card's tiles side by side, equal width and height.
private struct TilesRow: View {
    let state: ConstructActivityAttributes.ContentState
    var body: some View {
        HStack(spacing: 8) {
            ForEach(Array(state.shownTiles.enumerated()), id: \.offset) { _, tile in
                TileView(tile: tile)
            }
        }
        .fixedSize(horizontal: false, vertical: true)
    }
}

/// Progress bar in the tone's accent, when the state carries progress.
private struct ProgressBar: View {
    let state: ConstructActivityAttributes.ContentState
    var body: some View {
        if let progress = state.progress {
            ProgressView(value: min(max(progress, 0), 1))
                .tint(state.accent)
        }
    }
}

/// Lock Screen / banner content.
struct LockScreenView: View {
    let state: ConstructActivityAttributes.ContentState
    let activityId: String
    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            // The morning card spends the whole width on its tiles.
            if state.shownTiles.isEmpty {
                RoomAvatar(size: 40, roomId: state.roomId)
            }
            VStack(alignment: .leading, spacing: 10) {
                if !state.shownTiles.isEmpty {
                    // Morning card: tiles, then the body. No avatar, room
                    // name, title, countdown, progress or buttons.
                    VStack(alignment: .leading, spacing: 8) {
                        TilesRow(state: state)
                        MessageText(state: state, showsTitle: false, maxBodyLines: 2)
                    }
                } else if let end = state.endDate {
                    // Countdown as the hero, between the room and the title;
                    // the body below at its usual size.
                    VStack(alignment: .leading, spacing: 2) {
                        roomRow(showsTimer: false)
                        BigCountdown(state: state, end: end)
                        TitleText(state: state, lines: 1)
                        MessageText(state: state, showsTitle: false, maxBodyLines: 3)
                    }
                } else {
                    VStack(alignment: .leading, spacing: 2) {
                        roomRow(showsTimer: true)
                        MessageText(state: state)
                    }
                }
                if state.shownTiles.isEmpty {
                    ProgressBar(state: state)
                    if #available(iOS 17.0, *) {
                        if !state.actions.isEmpty {
                            ActionButtons(state: state, activityId: activityId)
                        }
                    }
                }
            }
        }
        .padding(.horizontal, 18)
        .padding(.vertical, 20)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func roomRow(showsTimer: Bool) -> some View {
        HStack(spacing: 8) {
            Text(state.roomName)
                .font(.caption2.weight(.semibold))
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .layoutPriority(1)
            MetaLabel(state: state, showsTimer: showsTimer)
        }
    }
}

/// Dynamic Island expanded bottom region. Shared by the real region and the
/// preview mock.
/// With a countdown the title has moved up to the leading region.
struct IslandBottomView: View {
    let state: ConstructActivityAttributes.ContentState
    let activityId: String
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if !state.shownTiles.isEmpty {
                // Morning card: tiles and body only.
                TilesRow(state: state)
                MessageText(state: state, showsTitle: false, maxBodyLines: 2)
            } else if state.endDate != nil {
                MessageText(state: state, showsTitle: false, maxBodyLines: 3)
            } else {
                MessageText(state: state)
            }
            if state.shownTiles.isEmpty {
                ProgressBar(state: state)
                if #available(iOS 17.0, *) {
                    if !state.actions.isEmpty {
                        ActionButtons(state: state, activityId: activityId)
                    }
                }
            }
        }
    }
}

/// Dynamic Island expanded top-left: avatar and room name.
private struct IslandRoomLabel: View {
    let state: ConstructActivityAttributes.ContentState
    var body: some View {
        HStack(spacing: 6) {
            RoomAvatar(size: 18, roomId: state.roomId)
            Text(state.roomName)
                .font(.caption.weight(.medium))
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
    }
}

/// Dynamic Island expanded leading region: the room label, plus the title when
/// a countdown takes the trailing region.
private struct IslandLeading: View {
    let state: ConstructActivityAttributes.ContentState
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            IslandRoomLabel(state: state)
            if state.endDate != nil {
                TitleText(state: state, lines: 2)
            }
        }
    }
}

/// Dynamic Island expanded trailing region: the countdown large when there is
/// one (step, if any, small above it), else the usual meta label.
private struct IslandTrailing: View {
    let state: ConstructActivityAttributes.ContentState
    var body: some View {
        if let end = state.endDate {
            VStack(alignment: .trailing, spacing: 0) {
                if let step = state.step, !step.isEmpty {
                    MetaLabel(state: state, showsTimer: false)
                }
                BigCountdown(state: state, end: end, trailing: true)
            }
        } else {
            MetaLabel(state: state)
        }
    }
}

/// Compact island, right of the notch: the morning card's first tile, else the
/// most time-sensitive thing the state has — countdown, then step, then
/// progress, else a plain tone-tinted glyph.
private struct CompactTrailing: View {
    let state: ConstructActivityAttributes.ContentState
    var body: some View {
        if let tile = state.shownTiles.first {
            HStack(spacing: 3) {
                TileIcon(name: tile.icon)
                Text(tile.value)
            }
                .font(.caption.weight(.semibold))
                .lineLimit(1)
                .minimumScaleFactor(0.7)
                .frame(maxWidth: 72, alignment: .trailing)
        } else if let end = state.endDate {
            // Timer Text reserves its widest layout; cap it to the compact slot.
            Text(timerInterval: Date()...end, countsDown: true)
                .font(.caption.weight(.semibold).monospacedDigit())
                .multilineTextAlignment(.trailing)
                .frame(maxWidth: 40)
                .foregroundStyle(state.accent)
        } else if let step = state.step, !step.isEmpty {
            Text(step)
                .font(.caption.weight(.semibold))
                .lineLimit(1)
                .foregroundStyle(state.accent)
        } else if let progress = state.progress {
            ProgressView(value: min(max(progress, 0), 1))
                .progressViewStyle(.circular)
                .tint(state.accent)
                .frame(width: 16, height: 16)
        } else {
            Image(systemName: "bubble.left.fill")
                .foregroundStyle(state.accent)
        }
    }
}

struct ContructWidgetsLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: ConstructActivityAttributes.self) { context in
            LockScreenView(state: context.state, activityId: context.attributes.activityId)
                // Our background is always dark, but on Mac the Live Activity
                // renders in the light color scheme, so .primary/.secondary text
                // resolved to black → black-on-black. Pin the content to dark so
                // the semantic text colors stay light everywhere.
                .environment(\.colorScheme, .dark)
                .activityBackgroundTint(Color(red: 0.07, green: 0.07, blue: 0.1))
                .activitySystemActionForegroundColor(Color.white)
                .widgetURL(roomDeepLink(context.state.roomId))

        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    IslandLeading(state: context.state)
                        // Inset from the island's rounded top-left corner, which
                        // was clipping the name.
                        .padding(.leading, 10)
                        .padding(.top, 6)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    IslandTrailing(state: context.state)
                        .padding(.trailing, 4)
                        .padding(.top, 6)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    IslandBottomView(state: context.state, activityId: context.attributes.activityId)
                        // Match the room label's leading inset (10) so the text's
                        // left edge lines up with it.
                        .padding(.leading, 10)
                        .padding(.trailing, 4)
                }
            } compactLeading: {
                RoomAvatar(size: 20, roomId: context.state.roomId)
            } compactTrailing: {
                CompactTrailing(state: context.state)
            } minimal: {
                RoomAvatar(size: 20, roomId: context.state.roomId)
            }
            // The island routes its own taps, separately from the lock screen.
            .widgetURL(roomDeepLink(context.state.roomId))
        }
    }
}

// MARK: - Previews
//
// Fast iteration lives here: edit a view above, and Xcode's canvas re-renders
// every state below without a build/install/push. Samples cover each tone and
// the combinations that stress the banner's height.

private extension ConstructActivityAttributes.ContentState {
    // Neutral, step + progress, no buttons.
    static let running = ConstructActivityAttributes.ContentState(
        title: "Deploying construct",
        body: "Building the web bundle and uploading to Vercel.",
        progress: 0.6,
        step: "3/5",
        roomName: "Bender"
    )
    // Success with the full three buttons.
    static let done = ConstructActivityAttributes.ContentState(
        title: "Deploy is live",
        body: "All checks passed. Promote to production?",
        tone: "success",
        actions: [.init(label: "Ship it", send: "ship it"),
                  .init(label: "Hold", send: "hold"),
                  .init(label: "Details", send: "details")],
        roomName: "Bender"
    )
    // Warning with a countdown, progress and buttons: the tallest case.
    static let approval = ConstructActivityAttributes.ContentState(
        title: "Approve rm -rf build/?",
        body: "The agent wants to clear the build directory before a clean rebuild. It will wait for an answer, then skip the step.",
        tone: "warning",
        progress: 0.3,
        actions: [.init(label: "Approve", send: "approve"),
                  .init(label: "Deny", send: "deny")],
        roomName: "agent: clean rebuild",
        endsAt: Date().addingTimeInterval(299).timeIntervalSince1970
    )
    // Pre-meeting card: big countdown (hours, so the widest timer) + a body
    // past three lines. The tallest countdown case without buttons.
    static let countdown = ConstructActivityAttributes.ContentState(
        title: "Design review starts",
        body: "Sinan, Bender and the agent. Agenda: Live Activity layout, the countdown hero, and whether the island should show the step. Bring screenshots of the lock screen on a small phone.",
        step: "Next",
        roomName: "calendar",
        endsAt: Date().addingTimeInterval(2 * 3600 + 17 * 60).timeIntervalSince1970
    )
    // Morning card, a normal day.
    static let morning = ConstructActivityAttributes.ContentState(
        body: "Standup at 10:00, design review at 16:30. Nothing urgent overnight.",
        roomName: "Morning",
        tiles: [.init(icon: "sun.max.fill", value: "21° / 24°", sub: "Clear all day"),
                .init(icon: "moon.zzz.fill", value: "7h 12", sub: "Slept well", tone: "success")]
    )
    // Morning card, short night + rain: warning tone on the sleep tile, and a
    // body long enough to hit the two-line cap.
    static let morningRough = ConstructActivityAttributes.ContentState(
        body: "Rain until the afternoon, take an umbrella. Standup at 10:00, design review at 16:30, and two PRs are waiting for review.",
        roomName: "Morning",
        tiles: [.init(icon: "cloud.rain.fill", value: "14° / 17°", sub: "Rain from 10:00"),
                .init(icon: "moon.zzz.fill", value: "5h 04", sub: "Short night", tone: "warning")]
    )
    // Three columns: weather, sleep, first event.
    static let morning3 = ConstructActivityAttributes.ContentState(
        body: "Design review at 16:30. Nothing urgent overnight.",
        roomName: "Morning",
        tiles: [.init(icon: "sun.max.fill", value: "21°", sub: "Clear"),
                .init(icon: "moon.zzz.fill", value: "7h 12", sub: "Slept well", tone: "success"),
                .init(icon: "calendar", value: "10:00", sub: "Standup")]
    )
    static let morning3Rough = ConstructActivityAttributes.ContentState(
        body: "Rain until the afternoon, take an umbrella. Design review at 16:30, and two PRs are waiting for review.",
        roomName: "Morning",
        tiles: [.init(icon: "cloud.rain.fill", value: "14°", sub: "Rain at 10"),
                .init(icon: "moon.zzz.fill", value: "5h 04", sub: "Short night", tone: "warning"),
                .init(icon: "calendar", value: "09:30", sub: "Dentist", tone: "warning")]
    )
    // Error, long body, no buttons: should truncate, not clip.
    static let failed = ConstructActivityAttributes.ContentState(
        title: "Build failed",
        body: "tsc exited with 2 errors in src/lib/liveActivity.ts. The first one is a type mismatch on the plugin's start options; the second follows from it. This body is deliberately long to exercise truncation.",
        tone: "error",
        roomName: "Bender"
    )
}

/// Simulated Lock Screen banner: the dark rounded container iOS draws around a
/// Live Activity, at a fixed height so overflow behaves as on device (the real
/// banner is a bounded box, not content-sized).
private struct PreviewBanner: View {
    let state: ConstructActivityAttributes.ContentState
    var body: some View {
        LockScreenView(state: state, activityId: "preview")
            .frame(width: 360, height: 160, alignment: .top)
            .background(Color(red: 0.07, green: 0.07, blue: 0.1))
            .clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
            .foregroundStyle(.white)
    }
}

/// Simulated expanded Dynamic Island: a black rounded pill with the same
/// regions the real island lays out (room label + meta on top, content below).
private struct IslandExpandedMock: View {
    let state: ConstructActivityAttributes.ContentState
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top) {
                IslandLeading(state: state)
                Spacer(minLength: 8)
                IslandTrailing(state: state)
            }
            IslandBottomView(state: state, activityId: "preview")
        }
        .padding(18)
        .frame(width: 360, height: 180, alignment: .top)
        .background(Color.black)
        .clipShape(RoundedRectangle(cornerRadius: 42, style: .continuous))
        .foregroundStyle(.white)
    }
}

#Preview("Lock Screen", traits: .sizeThatFitsLayout) {
    VStack(spacing: 20) {
        PreviewBanner(state: .running)
        PreviewBanner(state: .done)
        PreviewBanner(state: .approval)
        PreviewBanner(state: .countdown)
        PreviewBanner(state: .morning)
        PreviewBanner(state: .morningRough)
        PreviewBanner(state: .morning3)
        PreviewBanner(state: .morning3Rough)
        PreviewBanner(state: .failed)
    }
    .padding()
    .preferredColorScheme(.dark)
}

#Preview("Island — expanded", traits: .sizeThatFitsLayout) {
    VStack(spacing: 20) {
        IslandExpandedMock(state: .running)
        IslandExpandedMock(state: .done)
        IslandExpandedMock(state: .approval)
        IslandExpandedMock(state: .countdown)
        IslandExpandedMock(state: .morning)
        IslandExpandedMock(state: .morningRough)
        IslandExpandedMock(state: .morning3)
        IslandExpandedMock(state: .morning3Rough)
        IslandExpandedMock(state: .failed)
    }
    .padding()
    .preferredColorScheme(.dark)
}

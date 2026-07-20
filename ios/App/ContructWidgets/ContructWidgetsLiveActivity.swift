//
//  ContructWidgetsLiveActivity.swift
//  ContructWidgets
//

import ActivityKit
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
    }

    var roomName: String
}

/// "Reply" is the only terminal (non-working) status; everything else
/// (Listening…/Waiting…/Thinking…) shows the working ring.
private func isReply(_ status: String) -> Bool { status == "Reply" }

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

struct ContructWidgetsLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: ConstructActivityAttributes.self) { context in
            // Lock screen / banner
            let reply = isReply(context.state.status)
            // The user's message sits faded on top; bender's reply below in full
            // colour. No room name (the avatar covers that) and no status icon —
            // the presence of the reply is the state. A small ring shows only
            // while still waiting.
            HStack(alignment: .top, spacing: 12) {
                RoomAvatar(size: 40)
                VStack(alignment: .leading, spacing: 5) {
                    if !context.state.question.isEmpty {
                        Text(context.state.question)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                            .lineLimit(2)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    if reply {
                        Text(context.state.detail)
                            .font(.subheadline)
                            .lineLimit(10)
                            .fixedSize(horizontal: false, vertical: true)
                    } else {
                        HStack(alignment: .top, spacing: 8) {
                            WorkingRing(size: 14)
                            Text(context.state.detail.isEmpty ? context.state.status : context.state.detail)
                                .font(.caption)
                                .foregroundStyle(.tertiary)
                                .lineLimit(3)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 18)
            .padding(.vertical, 20)
            .frame(maxWidth: .infinity, alignment: .leading)
            .activityBackgroundTint(Color(red: 0.07, green: 0.07, blue: 0.1))
            .activitySystemActionForegroundColor(Color.white)

        } dynamicIsland: { context in
            let reply = isReply(context.state.status)
            return DynamicIsland {
                // No leading avatar in the expanded view: it duplicates the
                // compact/minimal icon and steals width the reply wants. A
                // single status/reply row with the indicator on the trailing
                // side reads cleaner.
                DynamicIslandExpandedRegion(.center) {
                    // Faded question on top, working ring only while waiting.
                    HStack(spacing: 8) {
                        if !context.state.question.isEmpty {
                            Text(context.state.question)
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                                .lineLimit(2)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        if !reply { WorkingRing(size: 15) }
                    }
                    .padding(.horizontal, 4)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    let text = reply ? context.state.detail
                                     : (context.state.detail.isEmpty ? context.state.status : context.state.detail)
                    Text(text)
                        .font(reply ? .subheadline : .caption)
                        .foregroundStyle(reply ? .primary : .secondary)
                        .lineLimit(reply ? 8 : 2)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 4)
                }
            } compactLeading: {
                RoomAvatar(size: 20)
            } compactTrailing: {
                if reply {
                    Image(systemName: "checkmark")
                        .foregroundStyle(.green)
                } else {
                    WorkingRing(size: 14)
                }
            } minimal: {
                RoomAvatar(size: 20)
            }
        }
    }
}

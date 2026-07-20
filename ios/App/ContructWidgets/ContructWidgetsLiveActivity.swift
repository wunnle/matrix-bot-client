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
            HStack(alignment: .top, spacing: 12) {
                RoomAvatar(size: 40)
                if reply {
                    // Answer phase: the reply gets the whole container — no faded
                    // question competing for height. minimumScaleFactor lets a
                    // long answer shrink to fit before it has to truncate.
                    Text(context.state.detail)
                        .font(.subheadline)
                        .lineLimit(12)
                        .minimumScaleFactor(0.8)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                } else {
                    // Loading phase: the question, faded, with a working
                    // indicator beneath it.
                    VStack(alignment: .leading, spacing: 6) {
                        if !context.state.question.isEmpty {
                            Text(context.state.question)
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                                .lineLimit(3)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        HStack(spacing: 8) {
                            WorkingRing(size: 14)
                            Text(context.state.detail.isEmpty ? context.state.status : context.state.detail)
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
            .activityBackgroundTint(Color(red: 0.07, green: 0.07, blue: 0.1))
            .activitySystemActionForegroundColor(Color.white)

        } dynamicIsland: { context in
            let reply = isReply(context.state.status)
            return DynamicIsland {
                // Room name fills the otherwise-empty top-left; the working ring
                // sits top-right while waiting.
                DynamicIslandExpandedRegion(.leading) {
                    Text(context.attributes.roomName)
                        .font(.headline)
                        .padding(.leading, 4)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    if !reply {
                        WorkingRing(size: 16)
                            .padding(.trailing, 4)
                    }
                }
                DynamicIslandExpandedRegion(.bottom) {
                    if reply {
                        // Answer phase: reply only, full width, shrink-to-fit.
                        Text(context.state.detail)
                            .font(.subheadline)
                            .lineLimit(10)
                            .minimumScaleFactor(0.8)
                            .fixedSize(horizontal: false, vertical: true)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal, 4)
                    } else {
                        // Loading phase: the faded question.
                        Text(context.state.question.isEmpty ? context.state.status : context.state.question)
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .lineLimit(3)
                            .fixedSize(horizontal: false, vertical: true)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal, 4)
                    }
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

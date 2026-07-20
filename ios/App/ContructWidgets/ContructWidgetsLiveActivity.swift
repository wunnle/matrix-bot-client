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
            // The room name is not shown: the avatar already identifies the
            // room, and in a one-bot room it only repeated what the reply
            // itself makes obvious. That space goes to the message.
            HStack(alignment: .top, spacing: 12) {
                RoomAvatar(size: 44)
                VStack(alignment: .leading, spacing: 3) {
                    if reply {
                        Text(context.state.detail)
                            .font(.subheadline)
                            .lineLimit(8)
                            .fixedSize(horizontal: false, vertical: true)
                    } else {
                        Text(context.state.status)
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                        if !context.state.detail.isEmpty {
                            Text(context.state.detail)
                                .font(.caption)
                                .foregroundStyle(.tertiary)
                                .lineLimit(3)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }
                Spacer(minLength: 8)
                if reply {
                    Image(systemName: "checkmark.circle.fill")
                        .font(.title3)
                        .foregroundStyle(.green)
                } else {
                    WorkingRing(size: 18)
                }
            }
            .padding(.horizontal, 18)
            .padding(.vertical, 16)
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
                    // Only the working status needs a centre line; on a reply
                    // the text below is the content and a header just crowds it.
                    if !reply {
                        HStack {
                            Text(context.state.status)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                            Spacer()
                            WorkingRing(size: 15)
                        }
                    }
                }
                DynamicIslandExpandedRegion(.bottom) {
                    if reply {
                        HStack(alignment: .top, spacing: 8) {
                            Text(context.state.detail)
                                .font(.subheadline)
                                .lineLimit(8)
                                .fixedSize(horizontal: false, vertical: true)
                                .frame(maxWidth: .infinity, alignment: .leading)
                            Image(systemName: "checkmark.circle.fill")
                                .foregroundStyle(.green)
                        }
                        .padding(.horizontal, 4)
                    } else if !context.state.detail.isEmpty {
                        Text(context.state.detail)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(2)
                            .fixedSize(horizontal: false, vertical: true)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal, 4)
                    }
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

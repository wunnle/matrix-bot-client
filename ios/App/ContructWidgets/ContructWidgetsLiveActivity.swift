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
            HStack(alignment: .center, spacing: 12) {
                RoomAvatar(size: 44)
                VStack(alignment: .leading, spacing: 3) {
                    Text(context.attributes.roomName)
                        .font(.headline)
                    if reply {
                        Text(context.state.detail)
                            .font(.subheadline)
                            .lineLimit(3)
                    } else {
                        Text(context.state.status)
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                        if !context.state.detail.isEmpty {
                            Text(context.state.detail)
                                .font(.caption)
                                .foregroundStyle(.tertiary)
                                .lineLimit(1)
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
            .padding()
            .activityBackgroundTint(Color(red: 0.07, green: 0.07, blue: 0.1))
            .activitySystemActionForegroundColor(Color.white)

        } dynamicIsland: { context in
            let reply = isReply(context.state.status)
            return DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    RoomAvatar(size: 36)
                        .padding(.leading, 4)
                }
                DynamicIslandExpandedRegion(.center) {
                    VStack(spacing: 2) {
                        Text(context.attributes.roomName)
                            .font(.headline)
                        if !reply {
                            Text(context.state.status)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
                DynamicIslandExpandedRegion(.trailing) {
                    if reply {
                        Image(systemName: "checkmark.circle.fill")
                            .foregroundStyle(.green)
                            .padding(.trailing, 4)
                    } else {
                        WorkingRing(size: 16)
                            .padding(.trailing, 4)
                    }
                }
                DynamicIslandExpandedRegion(.bottom) {
                    if reply {
                        Text(context.state.detail)
                            .font(.subheadline)
                            .lineLimit(3)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    } else if !context.state.detail.isEmpty {
                        Text(context.state.detail)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(2)
                            .frame(maxWidth: .infinity, alignment: .leading)
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

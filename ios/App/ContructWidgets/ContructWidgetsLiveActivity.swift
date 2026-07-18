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

struct ContructWidgetsLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: ConstructActivityAttributes.self) { context in
            // Lock screen / notification banner presentation
            HStack(spacing: 12) {
                Image(systemName: "bubble.left.and.bubble.right.fill")
                    .font(.title2)
                    .foregroundStyle(.purple)
                VStack(alignment: .leading, spacing: 2) {
                    Text(context.attributes.roomName)
                        .font(.headline)
                    Text(context.state.status)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                    if !context.state.detail.isEmpty {
                        Text(context.state.detail)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }
                Spacer()
            }
            .padding()
            .activityBackgroundTint(Color(red: 0.07, green: 0.07, blue: 0.1))
            .activitySystemActionForegroundColor(Color.white)

        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    Image(systemName: "bubble.left.and.bubble.right.fill")
                        .font(.title3)
                        .foregroundStyle(.purple)
                        .padding(.leading, 6)
                }
                DynamicIslandExpandedRegion(.center) {
                    VStack(spacing: 2) {
                        Text(context.attributes.roomName)
                            .font(.headline)
                        Text(context.state.status)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                DynamicIslandExpandedRegion(.bottom) {
                    if !context.state.detail.isEmpty {
                        Text(context.state.detail)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(2)
                    }
                }
            } compactLeading: {
                Image(systemName: "bubble.left.fill")
                    .foregroundStyle(.purple)
            } compactTrailing: {
                Image(systemName: "ellipsis")
                    .foregroundStyle(.purple)
            } minimal: {
                Image(systemName: "bubble.left.fill")
                    .foregroundStyle(.purple)
            }
        }
    }
}

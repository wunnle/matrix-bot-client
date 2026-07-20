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

/// Fades the bottom edge to transparent, so a reply too long for the fixed
/// height trails off rather than being cut with a hard line.
private extension View {
    func bottomFade() -> some View {
        mask(
            LinearGradient(
                stops: [
                    .init(color: .black, location: 0),
                    .init(color: .black, location: 0.82),
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
                    // Answer phase: reply gets the whole container. Fades only
                    // when it's actually too long to fit (see ReplyText).
                    ReplyText(text: context.state.detail, lines: 6, scale: 0.7)
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
                        .font(.footnote.weight(.medium))
                        .foregroundStyle(.secondary)
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
                        // Answer phase: reply only, full width. Fades only when
                        // too long to fit.
                        ReplyText(text: context.state.detail, lines: 8, scale: 0.75)
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

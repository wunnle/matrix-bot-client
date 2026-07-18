//
//  ContructWidgetsControl.swift
//  ContructWidgets
//
//  "Listen" control — Control Center / Lock Screen / Action Button entry
//  point. Deep-links into the app, which navigates to the room and starts
//  dictation (see appUrlOpen handling in the web app).
//
//  ListenIntent is defined in BOTH targets (here and AppDelegate.swift) with
//  the same type name: launcher controls resolve the action identifier in the
//  MAIN APP's AppIntents metadata (verified via siriactionsd logs — "action
//  missing" when only the extension declares it). The app's copy runs.
//

import AppIntents
import SwiftUI
import WidgetKit

struct ContructWidgetsControl: ControlWidget {
    static let kind: String = "com.wunnle.construct.listen"

    var body: some ControlWidgetConfiguration {
        StaticControlConfiguration(kind: Self.kind) {
            ControlWidgetButton(action: ListenIntent()) {
                Label("Listen", systemImage: "mic.fill")
            }
        }
        .displayName("Construct Listen")
        .description("Dictate a message to Construct.")
    }
}

/// Extension-side twin — must exist for the control to compile/reference the
/// action; the app-side copy (AppDelegate.swift) is what actually performs.
struct ListenIntent: AppIntent {
    static let title: LocalizedStringResource = "Listen"
    static let description = IntentDescription("Open Construct and start dictating a message.")
    static let openAppWhenRun = true

    func perform() async throws -> some IntentResult {
        return .result()
    }
}

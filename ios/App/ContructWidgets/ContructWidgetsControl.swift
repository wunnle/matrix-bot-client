//
//  ContructWidgetsControl.swift
//  ContructWidgets
//
//  "Listen" control — Control Center / Lock Screen / Action Button entry
//  point. Deep-links into the app, which navigates to the room and starts
//  dictation (see appUrlOpen handling in the web app).
//

import AppIntents
import SwiftUI
import WidgetKit

/// Default room the control dictates into (Bender).
private let defaultListenRoom = "!DpRWqhWOHJAxyvjOGI:matrix.org"

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

struct ListenIntent: AppIntent {
    static let title: LocalizedStringResource = "Listen"
    static let description = IntentDescription("Open Construct and start dictating a message.")
    static let openAppWhenRun = true

    @MainActor
    func perform() async throws -> some IntentResult & OpensIntent {
        let encoded = defaultListenRoom.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? defaultListenRoom
        return .result(opensIntent: OpenURLIntent(URL(string: "construct://listen?room=\(encoded)")!))
    }
}

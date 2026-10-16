//
//  AppIntent.swift
//  ContructWidgets
//
//  Created by Sinan on 17.07.2026.
//

import WidgetKit
import AppIntents

/// Which board a home-screen widget shows. Bots name boards when they set them
/// (`construct-widget set --id discord …`); long-press the widget → Edit Widget
/// to point it at one.
struct ConfigurationAppIntent: WidgetConfigurationIntent {
    static var title: LocalizedStringResource { "Board" }
    static var description: IntentDescription { "What a bot has put on one of your boards." }

    @Parameter(title: "Board", default: "main")
    var board: String
}

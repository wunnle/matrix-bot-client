//
//  ContructWidgets.swift
//  ContructWidgets
//
//  The home-screen board: a title, up to 4 tiles and up to 3 lines that a bot
//  sets through /api/widget (scripts/construct-widget.mjs). The tiles are the
//  Live Activity's (TileBox, TileIcon in ContructWidgetsLiveActivity.swift).
//
//  There's no push for these: the timeline fetches the board, iOS reloads it on
//  its own budget, and the app reloads it whenever it comes to the foreground.
//

import WidgetKit
import SwiftUI

/// One board, as /api/widget?id= returns it. Keep in step with api/_widgets.js.
/// Decoded leniently: a field the server adds later, or drops, can't blank it.
struct Board: Codable, Hashable {
    var title: String = ""
    var tone: String = "neutral"
    var tiles: [ConstructActivityAttributes.ContentState.Tile] = []
    var lines: [String] = []
    var roomId: String = ""
    var updatedAt: Double? = nil

    init(title: String = "", tone: String = "neutral",
         tiles: [ConstructActivityAttributes.ContentState.Tile] = [],
         lines: [String] = [], roomId: String = "", updatedAt: Double? = nil) {
        self.title = title
        self.tone = tone
        self.tiles = tiles
        self.lines = lines
        self.roomId = roomId
        self.updatedAt = updatedAt
    }

    private enum Keys: String, CodingKey { case title, tone, tiles, lines, roomId, updatedAt }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        title = try c.decodeIfPresent(String.self, forKey: .title) ?? ""
        tone = try c.decodeIfPresent(String.self, forKey: .tone) ?? "neutral"
        tiles = try c.decodeIfPresent([ConstructActivityAttributes.ContentState.Tile].self, forKey: .tiles) ?? []
        lines = try c.decodeIfPresent([String].self, forKey: .lines) ?? []
        roomId = try c.decodeIfPresent(String.self, forKey: .roomId) ?? ""
        updatedAt = try c.decodeIfPresent(Double.self, forKey: .updatedAt)
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: Keys.self)
        try c.encode(title, forKey: .title)
        try c.encode(tone, forKey: .tone)
        try c.encode(tiles, forKey: .tiles)
        try c.encode(lines, forKey: .lines)
        try c.encode(roomId, forKey: .roomId)
        try c.encodeIfPresent(updatedAt, forKey: .updatedAt)
    }

    static let sample = Board(
        title: "Work",
        tiles: [
            .init(icon: "linear", value: "3", sub: "in progress"),
            .init(icon: "discord", value: "2", sub: "need you", tone: "warning"),
        ],
        lines: ["COL-412 review is waiting on you"]
    )
}

/// Reads boards from /api/widget with the credential the app keeps in the App
/// Group (IntentConfig in AppDelegate.swift: same suite and keys), and keeps the
/// last good copy of each so a failed fetch shows that rather than nothing.
enum BoardStore {
    static let appGroup = "group.com.wunnle.construct"
    private static var defaults: UserDefaults { UserDefaults(suiteName: appGroup) ?? .standard }

    enum Result {
        case board(Board)
        /// The server has nothing under this id.
        case empty
        /// No credential yet: the app hasn't signed in since install.
        case signedOut
    }

    private static func cacheKey(_ id: String) -> String { "construct.board.\(id)" }

    static func cached(_ id: String) -> Board? {
        guard let data = defaults.data(forKey: cacheKey(id)) else { return nil }
        return try? JSONDecoder().decode(Board.self, from: data)
    }

    static func fetch(_ id: String) async -> Result {
        let d = defaults
        guard let secret = d.string(forKey: "construct.intentSecret"), !secret.isEmpty else {
            return .signedOut
        }
        let apiBase = d.string(forKey: "construct.apiBase") ?? "https://construct.kafagoz.com"
        var components = URLComponents(string: "\(apiBase)/api/widget")
        components?.queryItems = [URLQueryItem(name: "id", value: id)]
        guard let url = components?.url else { return cachedResult(id) }

        var req = URLRequest(url: url, timeoutInterval: 15)
        req.setValue(secret, forHTTPHeaderField: "x-intent-secret")
        req.cachePolicy = .reloadIgnoringLocalCacheData

        struct Reply: Decodable { var board: Board? }
        do {
            let (data, response) = try await URLSession.shared.data(for: req)
            guard (response as? HTTPURLResponse)?.statusCode == 200 else { return cachedResult(id) }
            guard let board = try JSONDecoder().decode(Reply.self, from: data).board else {
                d.removeObject(forKey: cacheKey(id))
                return .empty
            }
            if let encoded = try? JSONEncoder().encode(board) { d.set(encoded, forKey: cacheKey(id)) }
            return .board(board)
        } catch {
            return cachedResult(id)
        }
    }

    private static func cachedResult(_ id: String) -> Result {
        cached(id).map { .board($0) } ?? .empty
    }
}

struct BoardEntry: TimelineEntry {
    let date: Date
    let boardId: String
    let result: BoardStore.Result
}

struct Provider: AppIntentTimelineProvider {
    /// iOS treats this as a request; the real cadence is its reload budget.
    static let refresh: TimeInterval = 15 * 60

    func placeholder(in context: Context) -> BoardEntry {
        BoardEntry(date: Date(), boardId: "main", result: .board(.sample))
    }

    func snapshot(for configuration: ConfigurationAppIntent, in context: Context) async -> BoardEntry {
        // The widget gallery: show what a board looks like, not whatever this
        // id happens to hold (usually nothing yet).
        if context.isPreview { return placeholder(in: context) }
        return BoardEntry(date: Date(), boardId: configuration.board, result: await BoardStore.fetch(configuration.board))
    }

    func timeline(for configuration: ConfigurationAppIntent, in context: Context) async -> Timeline<BoardEntry> {
        let entry = BoardEntry(date: Date(), boardId: configuration.board,
                               result: await BoardStore.fetch(configuration.board))
        return Timeline(entries: [entry], policy: .after(Date().addingTimeInterval(Self.refresh)))
    }
}

// MARK: - Views

/// The board's title with its tone's dot, and how long ago a bot set it: there
/// is no push, so a board can be a while old and should say so.
private struct BoardHeader: View {
    let board: Board
    var body: some View {
        HStack(spacing: 5) {
            if let accent = toneColor(board.tone) {
                Circle().fill(accent).frame(width: 7, height: 7)
            }
            if !board.title.isEmpty {
                Text(board.title)
                    .font(.system(size: 14, weight: .semibold))
                    .lineLimit(1)
            }
            Spacer(minLength: 4)
            if let updatedAt = board.updatedAt {
                Text(Date(timeIntervalSince1970: updatedAt), style: .relative)
                    .font(.caption2.monospacedDigit())
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .multilineTextAlignment(.trailing)
                    .frame(maxWidth: 64, alignment: .trailing)
            }
        }
    }
}

private struct BoardTile: View {
    let tile: ConstructActivityAttributes.ContentState.Tile
    var body: some View {
        TileBox(icon: tile.icon, sub: tile.sub, tone: tile.tone) { Text(tile.value) }
    }
}

private struct BoardLines: View {
    let lines: [String]
    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            ForEach(Array(lines.enumerated()), id: \.offset) { _, line in
                Text(line)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// Tiles in rows of `columns`, each row equal width, rows equal height.
private struct TileGrid: View {
    let tiles: [ConstructActivityAttributes.ContentState.Tile]
    let columns: Int
    var body: some View {
        let rows = stride(from: 0, to: tiles.count, by: columns).map { Array(tiles[$0..<min($0 + columns, tiles.count)]) }
        VStack(spacing: 8) {
            ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                HStack(spacing: 8) {
                    ForEach(Array(row.enumerated()), id: \.offset) { _, tile in BoardTile(tile: tile) }
                    // A short last row keeps the columns' width.
                    ForEach(row.count..<columns, id: \.self) { _ in Color.clear.frame(maxWidth: .infinity) }
                }
                .fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}

private struct BoardView: View {
    let board: Board
    let family: WidgetFamily

    var body: some View {
        let tiles = board.tiles
        VStack(alignment: .leading, spacing: 8) {
            if !board.title.isEmpty || board.updatedAt != nil {
                BoardHeader(board: board)
            }
            switch family {
            case .systemSmall:
                // Two tiles stacked, or one with a line under it.
                TileGrid(tiles: Array(tiles.prefix(2)), columns: 1)
                if tiles.count < 2 { BoardLines(lines: Array(board.lines.prefix(tiles.isEmpty ? 3 : 1))) }
            case .systemMedium:
                // Up to 3 in a row with lines under; 4 as a 2×2 grid, no room left.
                if tiles.count == 4 {
                    TileGrid(tiles: tiles, columns: 2)
                } else {
                    TileGrid(tiles: tiles, columns: max(tiles.count, 1))
                    BoardLines(lines: Array(board.lines.prefix(tiles.isEmpty ? 3 : 2)))
                }
            default:
                TileGrid(tiles: tiles, columns: 2)
                BoardLines(lines: board.lines)
            }
            Spacer(minLength: 0)
        }
    }
}

/// Nothing to draw: a centred note in the board's place.
private struct BoardNote: View {
    let symbol: String
    let text: String
    var body: some View {
        VStack(spacing: 6) {
            Image(systemName: symbol)
                .font(.system(size: 22))
                .foregroundStyle(.white)
            Text(text)
                .font(.footnote)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

struct ContructWidgetsEntryView: View {
    var entry: Provider.Entry
    @Environment(\.widgetFamily) private var family

    var body: some View {
        switch entry.result {
        case .board(let board):
            BoardView(board: board, family: family)
                .widgetURL(roomDeepLink(board.roomId))
        case .empty:
            BoardNote(symbol: "square.grid.2x2", text: "Nothing on “\(entry.boardId)” yet")
        case .signedOut:
            BoardNote(symbol: "person.crop.circle", text: "Open Construct to sign in")
        }
    }
}

struct ContructWidgets: Widget {
    let kind: String = "ContructWidgets"

    var body: some WidgetConfiguration {
        AppIntentConfiguration(kind: kind, intent: ConfigurationAppIntent.self, provider: Provider()) { entry in
            ContructWidgetsEntryView(entry: entry)
                // Tiles are drawn for a dark card (white glyphs on white-tinted
                // fills), so the board is dark whatever the phone's appearance.
                .environment(\.colorScheme, .dark)
                .containerBackground(Color(red: 0.07, green: 0.07, blue: 0.1), for: .widget)
        }
        .configurationDisplayName("Board")
        .description("What a bot has put on one of your boards.")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge])
    }
}

// MARK: - Previews

private extension Board {
    static let four = Board(
        title: "Today",
        tone: "warning",
        tiles: [
            .init(icon: "linear", value: "3", sub: "in progress"),
            .init(icon: "discord", value: "2", sub: "need you", tone: "warning"),
            .init(icon: "checkmark.circle.fill", value: "5", sub: "done", tone: "success"),
            .init(icon: "exclamationmark.triangle.fill", value: "1", sub: "blocked", tone: "error"),
        ],
        lines: ["COL-412 review is waiting on you"],
        updatedAt: Date().addingTimeInterval(-600).timeIntervalSince1970
    )
}

#Preview(as: .systemSmall) {
    ContructWidgets()
} timeline: {
    BoardEntry(date: .now, boardId: "main", result: .board(.sample))
    BoardEntry(date: .now, boardId: "linear", result: .empty)
}

#Preview(as: .systemMedium) {
    ContructWidgets()
} timeline: {
    BoardEntry(date: .now, boardId: "main", result: .board(.sample))
    BoardEntry(date: .now, boardId: "main", result: .board(.four))
}

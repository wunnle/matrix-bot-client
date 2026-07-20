import UIKit
import UserNotifications
import UserNotificationsUI

/// Custom expanded view for MESSAGE notifications (long-press / pull-down).
///
/// The collapsed notification shows `aps.alert.body`, which the gateway strips
/// to plain text — iOS renders no formatting there. This view instead renders
/// the original markdown carried in `userInfo["md"]`, so bold reads as bold and
/// code reads as code.
///
/// Kept deliberately simple: no scrolling (iOS sizes the view to its content and
/// handles overflow), no interactivity. The Reply field the system draws below
/// this view keeps working untouched.
class NotificationViewController: UIViewController, UNNotificationContentExtension {

    private let bodyLabel = UILabel()

    private enum Metrics {
        static let bodySize: CGFloat = 16
        static let codeSize: CGFloat = 14
        static let lineSpacing: CGFloat = 4
        static let margin: CGFloat = 16
    }

    override func viewDidLoad() {
        super.viewDidLoad()

        // Sender and room are NOT drawn here: the system renders the title and
        // subtitle in the notification header above this view even when
        // UNNotificationExtensionDefaultContentHidden hides the default body.
        // A header label here duplicates them.
        bodyLabel.numberOfLines = 0
        bodyLabel.lineBreakMode = .byWordWrapping
        bodyLabel.font = .systemFont(ofSize: Metrics.bodySize)
        bodyLabel.textColor = .label
        // Diagnostic placeholder: if this text is what shows, the extension
        // loaded but didReceive never ran.
        bodyLabel.text = "(waiting for content)"
        bodyLabel.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(bodyLabel)

        NSLayoutConstraint.activate([
            bodyLabel.topAnchor.constraint(equalTo: view.topAnchor, constant: Metrics.margin),
            bodyLabel.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: Metrics.margin),
            bodyLabel.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -Metrics.margin),
            bodyLabel.bottomAnchor.constraint(equalTo: view.bottomAnchor, constant: -Metrics.margin),
        ])
    }

    func didReceive(_ notification: UNNotification) {
        let content = notification.request.content
        let info = content.userInfo

        // Prefer the original markdown; fall back to the stripped body if the
        // gateway didn't send it (older payloads).
        let source = (info["md"] as? String) ?? content.body

        // Plain text first, so the message is on screen regardless of what the
        // renderer does next. Anything that goes wrong below leaves this
        // standing rather than blanking the view.
        bodyLabel.text = source.isEmpty ? "(empty message)" : source

        let rendered = Self.render(source)
        if rendered.length > 0 {
            bodyLabel.attributedText = rendered
        }

        // Content extensions are sized by UNNotificationExtensionInitialContent-
        // SizeRatio until told otherwise; without this the view can end up far
        // shorter than its text.
        let width = view.bounds.width > 0 ? view.bounds.width : UIScreen.main.bounds.width
        let fitted = bodyLabel.sizeThatFits(
            CGSize(width: width - Metrics.margin * 2, height: .greatestFiniteMagnitude))
        preferredContentSize = CGSize(width: width, height: fitted.height + Metrics.margin * 2)
    }

    // MARK: - Markdown rendering

    /// Renders a markdown subset: fenced code blocks as monospaced runs, and
    /// everything else via `AttributedString(markdown:)` for inline bold,
    /// italic, links and inline code.
    ///
    /// Fenced blocks are split out first because the system parser flattens
    /// them into plain paragraphs — it models block-level intent but applies no
    /// styling, so code would be indistinguishable from prose.
    static func render(_ markdown: String) -> NSAttributedString {
        let out = NSMutableAttributedString()

        for segment in splitFencedCode(markdown) {
            if out.length > 0 {
                out.append(NSAttributedString(string: "\n"))
            }
            switch segment {
            case .code(let code):
                out.append(codeAttributed(code))
            case .text(let text):
                out.append(inlineAttributed(text))
            }
        }

        let paragraph = NSMutableParagraphStyle()
        paragraph.lineSpacing = Metrics.lineSpacing
        out.addAttribute(.paragraphStyle, value: paragraph,
                         range: NSRange(location: 0, length: out.length))
        return out
    }

    private enum Segment {
        case text(String)
        case code(String)
    }

    private static func splitFencedCode(_ markdown: String) -> [Segment] {
        var segments: [Segment] = []
        // Alternating split on ``` — even indices are prose, odd are code.
        let parts = markdown.components(separatedBy: "```")
        for (index, part) in parts.enumerated() {
            let isCode = index % 2 == 1
            if isCode {
                // Drop a leading language hint ("js\nconst x = 1").
                var body = part
                if let newline = body.firstIndex(of: "\n") {
                    let firstLine = body[body.startIndex..<newline]
                    if !firstLine.contains(" "), firstLine.count < 20 {
                        body = String(body[body.index(after: newline)...])
                    }
                }
                let trimmed = body.trimmingCharacters(in: .newlines)
                if !trimmed.isEmpty { segments.append(.code(trimmed)) }
            } else {
                let trimmed = part.trimmingCharacters(in: .newlines)
                if !trimmed.isEmpty { segments.append(.text(trimmed)) }
            }
        }
        // An unterminated fence leaves an odd trailing part; treating it as
        // prose is wrong but harmless, and beats dropping the text entirely.
        return segments.isEmpty ? [.text(markdown)] : segments
    }

    private static func inlineAttributed(_ text: String) -> NSAttributedString {
        let base: [NSAttributedString.Key: Any] = [
            .font: UIFont.systemFont(ofSize: Metrics.bodySize),
            .foregroundColor: UIColor.label,
        ]
        // .inlineOnlyPreservingWhitespace keeps hard line breaks, which the
        // default option collapses — bender's replies rely on them for lists.
        guard let parsed = try? AttributedString(
            markdown: text,
            options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        ) else {
            return NSAttributedString(string: text, attributes: base)
        }

        let result = NSMutableAttributedString(parsed)
        result.addAttributes(base, range: NSRange(location: 0, length: result.length))

        // Collect first, apply after: mutating an NSMutableAttributedString
        // inside its own enumerateAttribute is undefined behaviour.
        var styling: [(NSRange, InlinePresentationIntent)] = []
        result.enumerateAttribute(.inlinePresentationIntent,
                                  in: NSRange(location: 0, length: result.length)) { value, range, _ in
            guard let raw = value as? NSNumber else { return }
            styling.append((range, InlinePresentationIntent(rawValue: raw.uintValue)))
        }

        for (range, intent) in styling {
            var traits: UIFontDescriptor.SymbolicTraits = []
            if intent.contains(.stronglyEmphasized) { traits.insert(.traitBold) }
            if intent.contains(.emphasized) { traits.insert(.traitItalic) }

            if intent.contains(.code) {
                result.addAttribute(.font,
                                    value: UIFont.monospacedSystemFont(ofSize: Metrics.codeSize, weight: .regular),
                                    range: range)
                result.addAttribute(.foregroundColor, value: UIColor.secondaryLabel, range: range)
            } else if !traits.isEmpty,
                      let descriptor = UIFont.systemFont(ofSize: Metrics.bodySize)
                          .fontDescriptor.withSymbolicTraits(traits) {
                result.addAttribute(.font, value: UIFont(descriptor: descriptor, size: Metrics.bodySize), range: range)
            }
        }
        return result
    }

    private static func codeAttributed(_ code: String) -> NSAttributedString {
        NSAttributedString(string: code, attributes: [
            .font: UIFont.monospacedSystemFont(ofSize: Metrics.codeSize, weight: .regular),
            .foregroundColor: UIColor.label,
            .backgroundColor: UIColor.secondarySystemBackground,
        ])
    }
}

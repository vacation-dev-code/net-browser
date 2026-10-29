import AppKit

/// The slim top bar. By design it contains exactly three controls:
/// back, forward, and the ⋯ options menu. Nothing else.
///
/// How the "almost 99% transparent liquid glass" works:
/// the bar itself is a clear NSView. Behind the buttons, as a
/// *sibling* (not a parent), sits an NSVisualEffectView whose
/// alpha is set to `Settings.topBarGlassOpacity` (~0.02). The
/// glass is therefore barely visible and the web page shows
/// through it, while the buttons themselves stay fully opaque
/// and readable. On macOS 26 this material renders as liquid
/// glass; on earlier releases it falls back to the standard
/// header material, same code path.
///
/// The bar floats over the web view instead of pushing it down,
/// which is what buys the extra content height. The window's
/// traffic lights live in the top-left corner, so the buttons
/// start after a 76pt inset for them.
final class TopBarView: NSView {
    var onBack: (() -> Void)?
    var onForward: (() -> Void)?
    var onOptions: ((NSButton) -> Void)?

    private let glassView = NSVisualEffectView()
    private let backButton: NSButton
    private let forwardButton: NSButton
    private let optionsButton: NSButton
    private let progressView = NSBox()

    /// A 2pt line at the bottom of the bar. Not a control, just
    /// loading feedback, and hidden entirely when disabled.
    var progress: Double = 0 {
        didSet {
            let width = bounds.width * CGFloat(min(max(progress, 0), 1))
            progressView.frame = NSRect(x: 0, y: 0, width: width, height: 2)
            progressView.isHidden = progress <= 0 || progress >= 1
        }
    }

    init(settings: Settings) {
        super.init(frame: .zero)
        wantsLayer = true
        layer?.backgroundColor = NSColor.clear.cgColor

        // Glass sibling, behind the buttons.
        glassView.material = .headerView
        glassView.blendingMode = .behindWindow
        glassView.state = .active
        glassView.alphaValue = settings.topBarGlassOpacity
        glassView.translatesAutoresizingMaskIntoConstraints = false
        addSubview(glassView)
        NSLayoutConstraint.activate([
            glassView.leadingAnchor.constraint(equalTo: leadingAnchor),
            glassView.trailingAnchor.constraint(equalTo: trailingAnchor),
            glassView.topAnchor.constraint(equalTo: topAnchor),
            glassView.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])

        func makeButton(symbol: String, action: Selector) -> NSButton {
            let button = NSButton()
            button.image = NSImage(systemSymbolName: symbol, accessibilityDescription: symbol)
            button.bezelStyle = .roundRect
            button.isBordered = false
            button.imageScaling = .scaleProportionallyDown
            button.contentTintColor = .secondaryLabelColor
            button.translatesAutoresizingMaskIntoConstraints = false
            button.target = self
            button.action = action
            return button
        }

        backButton = makeButton(symbol: "chevron.backward", action: #selector(didTapBack))
        forwardButton = makeButton(symbol: "chevron.forward", action: #selector(didTapForward))
        optionsButton = makeButton(symbol: "ellipsis", action: #selector(didTapOptions))
        // Options is the only button that should read as a control
        // rather than a glyph, so give it a touch more presence.
        optionsButton.contentTintColor = .labelColor

        for button in [backButton, forwardButton, optionsButton] {
            addSubview(button)
        }

        // Progress line, above the glass but below nothing else.
        progressView.boxType = .custom
        progressView.borderType = .noBorder
        progressView.fillColor = .controlAccentColor
        progressView.isHidden = true
        // Intentionally frame-based, not constraint-based, so the
        // progress setter can resize it directly.
        addSubview(progressView)

        NSLayoutConstraint.activate([
            backButton.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 76),
            backButton.centerYAnchor.constraint(equalTo: centerYAnchor),
            backButton.widthAnchor.constraint(equalToConstant: 28),
            backButton.heightAnchor.constraint(equalToConstant: 22),

            forwardButton.leadingAnchor.constraint(equalTo: backButton.trailingAnchor, constant: 2),
            forwardButton.centerYAnchor.constraint(equalTo: centerYAnchor),
            forwardButton.widthAnchor.constraint(equalToConstant: 28),
            forwardButton.heightAnchor.constraint(equalToConstant: 22),

            optionsButton.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -10),
            optionsButton.centerYAnchor.constraint(equalTo: centerYAnchor),
            optionsButton.widthAnchor.constraint(equalToConstant: 28),
            optionsButton.heightAnchor.constraint(equalToConstant: 22),
        ])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("TopBarView is code-only") }

    func setGlassOpacity(_ opacity: CGFloat) {
        glassView.alphaValue = opacity
    }

    func setCanGoBack(_ can: Bool) {
        backButton.isEnabled = can
        backButton.contentTintColor = can ? .labelColor : .tertiaryLabelColor
    }

    func setCanGoForward(_ can: Bool) {
        forwardButton.isEnabled = can
        forwardButton.contentTintColor = can ? .labelColor : .tertiaryLabelColor
    }

    @objc private func didTapBack() { onBack?() }
    @objc private func didTapForward() { onForward?() }
    @objc private func didTapOptions() { onOptions?(optionsButton) }
}

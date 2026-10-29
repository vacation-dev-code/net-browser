import AppKit

/// The vertical tab bar, hidden on the right edge.
///
/// Behaviour, exactly as specified: it is invisible by default
/// (width 0, not just transparent) and slides out when the mouse
/// hovers near the right edge of the window. It slides back when
/// the mouse leaves the sidebar and the edge zone. The controller
/// owns the show/hide decision; this view only renders the list
/// and reports taps.
///
/// It floats over the web view, so revealing it never reflows
/// the page. That keeps the "more content" goal intact even
/// when the sidebar is open.
final class SidebarView: NSView {
    var onSelect: ((Tab) -> Void)?
    var onClose: ((Tab) -> Void)?
    var onNewTab: (() -> Void)?

    private let glassView = NSVisualEffectView()
    private let scrollView = NSScrollView()
    private let stackView = NSStackView()
    private let newTabButton = NSButton(title: "+ New Tab", target: nil, action: nil)

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        wantsLayer = true

        glassView.material = .sidebar
        glassView.blendingMode = .behindWindow
        glassView.state = .active
        glassView.translatesAutoresizingMaskIntoConstraints = false
        addSubview(glassView)
        NSLayoutConstraint.activate([
            glassView.leadingAnchor.constraint(equalTo: leadingAnchor),
            glassView.trailingAnchor.constraint(equalTo: trailingAnchor),
            glassView.topAnchor.constraint(equalTo: topAnchor),
            glassView.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])

        stackView.orientation = .vertical
        stackView.spacing = 4
        stackView.alignment = .leading
        stackView.translatesAutoresizingMaskIntoConstraints = false

        scrollView.documentView = stackView
        scrollView.hasVerticalScroller = true
        scrollView.drawsBackground = false
        scrollView.translatesAutoresizingMaskIntoConstraints = false
        addSubview(scrollView)

        newTabButton.bezelStyle = .roundRect
        newTabButton.isBordered = false
        newTabButton.contentTintColor = .secondaryLabelColor
        newTabButton.alignment = .left
        newTabButton.target = self
        newTabButton.action = #selector(didTapNewTab)
        newTabButton.translatesAutoresizingMaskIntoConstraints = false
        addSubview(newTabButton)

        NSLayoutConstraint.activate([
            scrollView.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 8),
            scrollView.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -8),
            scrollView.topAnchor.constraint(equalTo: topAnchor, constant: 36),
            scrollView.bottomAnchor.constraint(equalTo: newTabButton.topAnchor, constant: -8),

            newTabButton.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 8),
            newTabButton.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -8),
            newTabButton.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -10),
            newTabButton.heightAnchor.constraint(equalToConstant: 28),
        ])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("SidebarView is code-only") }

    /// Rebuild the row list. Tabs are normally few, so a rebuild
    /// on every change is simpler and safer than diffing rows.
    func render(tabs: [Tab], active: Tab?) {
        for view in stackView.arrangedSubviews {
            stackView.removeArrangedSubview(view)
            view.removeFromSuperview()
        }
        for tab in tabs {
            let row = TabRowView(tab: tab, isActive: tab.id == active?.id)
            row.onSelect = { [weak self] in self?.onSelect?(tab) }
            row.onClose = { [weak self] in self?.onClose?(tab) }
            row.translatesAutoresizingMaskIntoConstraints = false
            stackView.addArrangedSubview(row)
            row.widthAnchor.constraint(equalTo: stackView.widthAnchor).isActive = true
        }
    }

    @objc private func didTapNewTab() { onNewTab?() }
}

/// One row in the sidebar: a letter avatar, the title, and a
/// close button that only appears on hover, to keep the list quiet.
private final class TabRowView: NSView {
    var onSelect: (() -> Void)?
    var onClose: (() -> Void)?

    private let selectButton = NSButton()
    private let closeButton = NSButton()

    init(tab: Tab, isActive: Bool) {
        super.init(frame: .zero)
        wantsLayer = true
        layer?.cornerRadius = 8
        layer?.backgroundColor = isActive
            ? NSColor.controlAccentColor.withAlphaComponent(0.15).cgColor
            : NSColor.clear.cgColor

        selectButton.title = "\(tab.shortLabel)  \(tab.title)"
        selectButton.bezelStyle = .roundRect
        selectButton.isBordered = false
        selectButton.alignment = .left
        selectButton.lineBreakMode = .byTruncatingTail
        selectButton.contentTintColor = isActive ? .labelColor : .secondaryLabelColor
        selectButton.target = self
        selectButton.action = #selector(didTapSelect)
        selectButton.translatesAutoresizingMaskIntoConstraints = false
        addSubview(selectButton)

        closeButton.title = "×"
        closeButton.bezelStyle = .roundRect
        closeButton.isBordered = false
        closeButton.contentTintColor = .secondaryLabelColor
        closeButton.target = self
        closeButton.action = #selector(didTapClose)
        closeButton.translatesAutoresizingMaskIntoConstraints = false
        closeButton.isHidden = true
        addSubview(closeButton)

        NSLayoutConstraint.activate([
            selectButton.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 6),
            selectButton.trailingAnchor.constraint(equalTo: closeButton.leadingAnchor, constant: -2),
            selectButton.topAnchor.constraint(equalTo: topAnchor),
            selectButton.bottomAnchor.constraint(equalTo: bottomAnchor),
            selectButton.heightAnchor.constraint(equalToConstant: 30),

            closeButton.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -4),
            closeButton.centerYAnchor.constraint(equalTo: centerYAnchor),
            closeButton.widthAnchor.constraint(equalToConstant: 22),
        ])

        let tracking = NSTrackingArea(rect: bounds, options: [.mouseEnteredAndExited, .activeInKeyWindow, .inVisibleRect], owner: self, userInfo: nil)
        addTrackingArea(tracking)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("TabRowView is code-only") }

    override func mouseEntered(with event: NSEvent) { closeButton.isHidden = false }
    override func mouseExited(with event: NSEvent) { closeButton.isHidden = true }

    @objc private func didTapSelect() { onSelect?() }
    @objc private func didTapClose() { onClose?() }
}

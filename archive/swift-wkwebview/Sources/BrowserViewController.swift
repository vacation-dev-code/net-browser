import AppKit
import QuartzCore
import WebKit

/// The single-window browser view controller.
///
/// Layout, in one sentence: the web view fills the whole window,
/// the slim top bar floats over its top edge, and the tab sidebar
/// floats over its right edge. Nothing pushes the page down or
/// sideways, which is what keeps the content area maximal.
final class BrowserViewController: NSViewController {
    private var settings = Settings.load()
    private let tabManager = TabManager()

    private var topBar: TopBarView!
    private var sidebar: SidebarView!
    private var webContainer = NSView()
    private var sidebarWidthConstraint: NSLayoutConstraint!
    private var topBarHeightConstraint: NSLayoutConstraint!

    private var progressObservation: NSKeyValueObservation?
    private var hideSidebarWorkItem: DispatchWorkItem?
    private var sidebarVisible = false
    private var keyMonitor: Any?
    private var mouseMonitor: Any?

    // MARK: - View setup

    override func loadView() {
        view = NSView()
        view.wantsLayer = true
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        settings.save() // Seeds config.json + custom-filters.txt on first run.

        webContainer.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(webContainer)
        NSLayoutConstraint.activate([
            webContainer.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            webContainer.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            webContainer.topAnchor.constraint(equalTo: view.topAnchor),
            webContainer.bottomAnchor.constraint(equalTo: view.bottomAnchor),
        ])

        topBar = TopBarView(settings: settings)
        topBar.translatesAutoresizingMaskIntoConstraints = false
        topBar.onBack = { [weak self] in self?.tabManager.activeTab?.webView.goBack() }
        topBar.onForward = { [weak self] in self?.tabManager.activeTab?.webView.goForward() }
        topBar.onOptions = { [weak self] button in self?.showOptionsMenu(from: button) }
        view.addSubview(topBar)
        topBarHeightConstraint = topBar.heightAnchor.constraint(equalToConstant: settings.topBarHeight)
        NSLayoutConstraint.activate([
            topBar.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            topBar.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            topBar.topAnchor.constraint(equalTo: view.topAnchor),
            topBarHeightConstraint,
        ])

        sidebar = SidebarView()
        sidebar.translatesAutoresizingMaskIntoConstraints = false
        sidebar.onSelect = { [weak self] tab in
            self?.tabManager.select(tab)
            self?.scheduleSidebarHide()
        }
        sidebar.onClose = { [weak self] tab in self?.tabManager.close(tab) }
        sidebar.onNewTab = { [weak self] in self?.newTab() }
        view.addSubview(sidebar)
        sidebarWidthConstraint = sidebar.widthAnchor.constraint(equalToConstant: 0)
        NSLayoutConstraint.activate([
            sidebar.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            sidebar.topAnchor.constraint(equalTo: view.topAnchor),
            sidebar.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            sidebarWidthConstraint,
        ])
        // The sidebar floats over the page, but it must never cover
        // the top bar: otherwise opening it would hide the ⋯ button
        // at the top-right, exactly when the mouse is on that side.
        view.bringSubviewToFront(topBar)

        tabManager.onTabsChange = { [weak self] in self?.renderTabs() }
        tabManager.onActiveTabChange = { [weak self] _ in self?.renderActiveTab() }
        tabManager.configuration.userContentController.add(self, name: "navigate")

        renderTabs()
        tabManager.newTab()
    }

    override func viewDidAppear() {
        super.viewDidAppear()
        view.window?.acceptsMouseMovedEvents = true
        installMouseMonitor()
        installKeyMonitor()
    }

    // MARK: - Tabs

    func newTab(url: URL? = nil) {
        tabManager.newTab(url: url)
    }

    private func renderTabs() {
        sidebar.render(tabs: tabManager.tabs, active: tabManager.activeTab)
    }

    private func renderActiveTab() {
        for subview in webContainer.subviews { subview.removeFromSuperview() }
        progressObservation = nil
        guard let tab = tabManager.activeTab else { return }

        let webView = tab.webView
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.translatesAutoresizingMaskIntoConstraints = false
        webContainer.addSubview(webView)
        NSLayoutConstraint.activate([
            webView.leadingAnchor.constraint(equalTo: webContainer.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: webContainer.trailingAnchor),
            webView.topAnchor.constraint(equalTo: webContainer.topAnchor),
            webView.bottomAnchor.constraint(equalTo: webContainer.bottomAnchor),
        ])

        topBar.setCanGoBack(webView.canGoBack)
        topBar.setCanGoForward(webView.canGoForward)
        progressObservation = webView.observe(\.estimatedProgress, options: [.new]) { [weak self] _, _ in
            guard let self = self else { return }
            if self.settings.showProgressLine {
                self.topBar.progress = webView.estimatedProgress
            }
        }
        renderTabs()
    }

    // MARK: - Sidebar hover

    private func installMouseMonitor() {
        guard mouseMonitor == nil, let window = view.window else { return }
        mouseMonitor = NSEvent.addLocalMonitorForEvents(matching: [.mouseMoved]) { [weak self] event in
            self?.handleMouseMoved(event, in: window)
            return event
        }
    }

    private func handleMouseMoved(_ event: NSEvent, in window: NSWindow) {
        let location = event.locationInWindow
        let width = window.contentView?.bounds.width ?? window.frame.width
        let inEdgeZone = location.x >= width - settings.sidebarHoverEdgeWidth
        let inSidebarZone = sidebarVisible && location.x >= width - settings.sidebarWidth
        if inEdgeZone || inSidebarZone {
            hideSidebarWorkItem?.cancel()
            setSidebarVisible(true)
        } else {
            scheduleSidebarHide()
        }
    }

    private func scheduleSidebarHide() {
        hideSidebarWorkItem?.cancel()
        let work = DispatchWorkItem { [weak self] in self?.setSidebarVisible(false) }
        hideSidebarWorkItem = work
        DispatchQueue.main.asyncAfter(deadline: .now() + settings.sidebarHideDelay, execute: work)
    }

    private func setSidebarVisible(_ visible: Bool, animated: Bool = true) {
        guard visible != sidebarVisible else { return }
        sidebarVisible = visible
        let target = visible ? settings.sidebarWidth : 0
        if animated {
            NSAnimationContext.runAnimationGroup { context in
                context.duration = 0.18
                context.timingFunction = CAMediaTimingFunction(name: .easeOut)
                sidebarWidthConstraint.animator().constant = target
            }
        } else {
            sidebarWidthConstraint.constant = target
        }
    }

    func toggleSidebar() {
        setSidebarVisible(!sidebarVisible)
        if sidebarVisible { scheduleSidebarHide() }
    }

    // MARK: - Keyboard shortcuts (there is no address bar to steal them)

    private func installKeyMonitor() {
        guard keyMonitor == nil else { return }
        keyMonitor = NSEvent.addLocalMonitorForEvents(matching: [.keyDown]) { [weak self] event in
            guard let self = self, event.modifierFlags.contains(.command) else { return event }
            let key = event.charactersIgnoringModifiers?.lowercased() ?? ""
            switch key {
            case "t": self.newTab(); return nil
            case "w": self.tabManager.closeActiveTab(); return nil
            case "l": self.showGoToURL(); return nil
            case "r": self.tabManager.activeTab?.webView.reload(); return nil
            case "[": self.tabManager.activeTab?.webView.goBack(); return nil
            case "]": self.tabManager.activeTab?.webView.goForward(); return nil
            default: return event
            }
        }
    }

    // MARK: - Options (⋯) menu

    private func showOptionsMenu(from button: NSButton) {
        let menu = NSMenu()

        func item(_ title: String, key: String = "", action: Selector) -> NSMenuItem {
            let item = NSMenuItem(title: title, action: action, keyEquivalent: key)
            item.target = self
            return item
        }

        menu.addItem(item("New Tab", action: #selector(menuNewTab)))
        menu.addItem(item("New Window", action: #selector(menuNewWindow)))
        menu.addItem(NSMenuItem.separatorItem())
        menu.addItem(item("Go to URL…", action: #selector(menuGoToURL)))
        menu.addItem(item("Reload", action: #selector(menuReload)))
        menu.addItem(NSMenuItem.separatorItem())
        let blockerItem = item("Block Ads & Trackers", action: #selector(menuToggleBlocker))
        blockerItem.state = settings.blockerEnabled ? .on : .off
        menu.addItem(blockerItem)
        menu.addItem(item("Toggle Sidebar", action: #selector(menuToggleSidebar)))
        menu.addItem(NSMenuItem.separatorItem())
        menu.addItem(item("Open Config Folder…", action: #selector(menuOpenConfigFolder)))
        menu.addItem(item("Reload Config", action: #selector(menuReloadConfig)))
        menu.addItem(NSMenuItem.separatorItem())
        menu.addItem(item("Close Tab", action: #selector(menuCloseTab)))

        menu.popUp(positioning: nil, at: NSPoint(x: 0, y: button.bounds.height), in: button)
    }

    @objc private func menuNewTab() { newTab() }
    @objc private func menuNewWindow() { (NSApp.delegate as? AppDelegate)?.openNewWindow() }
    @objc private func menuGoToURL() { showGoToURL() }
    @objc private func menuReload() { tabManager.activeTab?.webView.reload() }
    @objc private func menuCloseTab() { tabManager.closeActiveTab() }
    @objc private func menuToggleSidebar() { toggleSidebar() }

    @objc private func menuToggleBlocker() {
        settings.blockerEnabled.toggle()
        settings.save()
        let controller = tabManager.configuration.userContentController
        if settings.blockerEnabled {
            controller.addUserScript(ContentBlocker.cosmeticUserScript())
            ContentBlocker.install(into: tabManager.configuration)
        } else {
            controller.removeAllContentRuleLists()
            controller.removeAllUserScripts()
            // Removing all scripts also removed nothing else we need:
            // the "navigate" handler is a message handler, not a script.
        }
        tabManager.activeTab?.webView.reload()
    }

    @objc private func menuOpenConfigFolder() {
        NSWorkspace.shared.open(Settings.supportDirectory)
    }

    @objc private func menuReloadConfig() {
        settings = Settings.load()
        topBarHeightConstraint.constant = settings.topBarHeight
        topBar.setGlassOpacity(settings.topBarGlassOpacity)
        setSidebarVisible(false, animated: false)
    }

    // MARK: - Go to URL

    func showGoToURL() {
        let popover = NSPopover()
        popover.behavior = .transient
        let controller = GoToURLViewController { [weak self, weak popover] text in
            popover?.close()
            guard let self = self, let url = StartPage.url(for: text, settings: self.settings) else { return }
            if let tab = self.tabManager.activeTab, tab.title == "New Tab", tab.url == nil {
                tab.webView.load(URLRequest(url: url))
            } else {
                self.tabManager.newTab(url: url)
            }
        }
        popover.contentViewController = controller
        // Anchor it to the top bar, centred, so it reads as part of
        // the bar rather than a floating window.
        popover.show(relativeTo: NSRect(x: view.bounds.midX - 160, y: view.bounds.height - settings.topBarHeight, width: 320, height: 1), of: view, preferredEdge: .minY)
        controller.focus()
    }
}

// MARK: - Web view delegates

extension BrowserViewController: WKNavigationDelegate {
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        topBar.setCanGoBack(webView.canGoBack)
        topBar.setCanGoForward(webView.canGoForward)
        if let tab = tabManager.activeTab, tab.webView == webView {
            tab.url = webView.url
        }
        renderTabs()
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        renderTabs()
    }
}

extension BrowserViewController: WKUIDelegate {
    /// Links that want a new window become a new tab instead.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        guard let url = navigationAction.request.url else { return nil }
        return tabManager.newTab(url: url).webView
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "OK")
        alert.beginSheetModal(for: view.window!) { _ in completionHandler() }
    }
}

extension BrowserViewController: WKScriptMessageHandler {
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "navigate",
              let text = message.body as? String,
              let url = StartPage.url(for: text, settings: settings),
              let tab = tabManager.activeTab
        else { return }
        tab.webView.load(URLRequest(url: url))
    }
}

/// The small URL entry field shown by Cmd+L and by ⋯ → Go to URL….
private final class GoToURLViewController: NSViewController {
    private let textField = NSTextField()
    private let onSubmit: (String) -> Void

    init(onSubmit: @escaping (String) -> Void) {
        self.onSubmit = onSubmit
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("GoToURLViewController is code-only") }

    override func loadView() {
        let container = NSView(frame: NSRect(x: 0, y: 0, width: 320, height: 44))
        textField.placeholderString = "Search or type a URL"
        textField.translatesAutoresizingMaskIntoConstraints = false
        textField.target = self
        textField.action = #selector(submit)
        container.addSubview(textField)
        NSLayoutConstraint.activate([
            textField.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: 12),
            textField.trailingAnchor.constraint(equalTo: container.trailingAnchor, constant: -12),
            textField.centerYAnchor.constraint(equalTo: container.centerYAnchor),
        ])
        view = container
    }

    func focus() {
        view.window?.makeFirstResponder(textField)
    }

    @objc private func submit() {
        onSubmit(textField.stringValue)
    }
}

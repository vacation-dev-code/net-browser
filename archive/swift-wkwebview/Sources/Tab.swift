import Foundation
import WebKit

/// One browser tab: a WKWebView plus the metadata the sidebar shows.
///
/// Web views are kept alive when they are not active (hidden, not
/// destroyed) so switching back is instant. That is the main memory
/// trade-off of this design; if tab counts ever get large, the
/// obvious next step is to suspend inactive web views and reload
/// them on selection, which TabManager can do without changing
/// the sidebar or top bar.
final class Tab: NSObject {
    let id = UUID()
    let webView: WKWebView
    var title: String = "New Tab" {
        didSet { onChange?() }
    }
    var url: URL? {
        didSet { onChange?() }
    }
    var isLoading = false {
        didSet { onChange?() }
    }

    /// Called whenever title / url / loading state changes.
    /// The sidebar observes this instead of polling.
    var onChange: (() -> Void)?

    private var titleObservation: NSKeyValueObservation?
    private var progressObservation: NSKeyValueObservation?
    private var loadingObservation: NSKeyValueObservation?

    init(configuration: WKWebViewConfiguration) {
        self.webView = WKWebView(frame: .zero, configuration: configuration)
        super.init()
        webView.allowsBackForwardNavigationGestures = true
        // Note: WKWebView has no drawsBackground property on macOS,
        // so do not try to set it via KVC — that would crash on tab
        // creation. The start page itself handles its own background.

        titleObservation = webView.observe(\.title, options: [.new]) { [weak self] _, _ in
            guard let self = self else { return }
            let new = self.webView.title ?? ""
            if !new.isEmpty { self.title = new }
        }
        loadingObservation = webView.observe(\.isLoading, options: [.new]) { [weak self] _, change in
            self?.isLoading = change.newValue
        }
    }

    /// The one-letter label the sidebar shows when there is no favicon.
    /// WKWebView does not expose favicons, so this is the honest
    /// placeholder until a favicon fetcher is added later.
    var shortLabel: String {
        let clean = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let first = clean.first else { return "·" }
        return String(first).uppercased()
    }
}

/// Owns the tab list and the shared web view configuration.
///
/// Sharing one WKProcessPool across tabs is deliberate: it keeps
/// cookies / logins working across tabs, and it is lighter than
/// one process pool per tab.
final class TabManager {
    private(set) var tabs: [Tab] = []
    private(set) var activeTab: Tab? {
        didSet { onActiveTabChange?(activeTab) }
    }

    var onTabsChange: (() -> Void)?
    var onActiveTabChange: ((Tab?) -> Void)?
    /// Called when a link wants a new window: the browser turns it
    /// into a new tab instead of a new window.
    var onOpenNewTabRequest: ((URL) -> Void)?

    let configuration: WKWebViewConfiguration = {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()
        config.preferences.javaScriptCanOpenWindowsAutomatically = true
        // The blocker and the start page are installed per-tab below,
        // because WKUserContentController is shared via this config:
        // adding them once here covers every tab created from it.
        if Settings.load().blockerEnabled {
            config.userContentController.addUserScript(ContentBlocker.cosmeticUserScript())
            ContentBlocker.install(into: config)
        }
        return config
    }()

    @discardableResult
    func newTab(url: URL? = nil) -> Tab {
        let tab = Tab(configuration: configuration)
        tab.onChange = { [weak self] in self?.onTabsChange?() }
        tabs.append(tab)
        if let url = url {
            tab.webView.load(URLRequest(url: url))
        } else {
            tab.webView.loadHTMLString(StartPage.html, baseURL: nil)
            tab.title = "New Tab"
        }
        select(tab)
        onTabsChange?()
        return tab
    }

    func select(_ tab: Tab) {
        guard tabs.contains(where: { $0.id == tab.id }) else { return }
        activeTab = tab
        onTabsChange?()
    }

    func close(_ tab: Tab) {
        guard let index = tabs.firstIndex(where: { $0.id == tab.id }) else { return }
        tabs.remove(at: index)
        tab.webView.stopLoading()
        if activeTab?.id == tab.id {
            // Prefer the neighbour to the right, else the last tab.
            let next = tabs.indices.contains(index) ? tabs[index] : tabs.last
            if let next = next {
                select(next)
            } else {
                activeTab = nil
                // Never leave the user with zero tabs: open a fresh one.
                newTab()
            }
        }
        onTabsChange?()
    }

    func closeActiveTab() {
        if let tab = activeTab { close(tab) }
    }
}

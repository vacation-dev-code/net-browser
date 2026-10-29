import Foundation
import WebKit

/// A uBlock-*style* content blocker for WKWebView.
///
/// Honest limitation, stated up front: WKWebView cannot load a real
/// Safari / Chrome extension, so the actual uBlock Origin extension
/// cannot run inside this app. What this does instead is the same job
/// with the tools WKWebView does offer:
///
///   1. Network blocking via WKContentRuleList — requests to known
///      ad / tracker domains are dropped before they are even sent,
///      which is also why this stays lightweight.
///   2. Cosmetic hiding via a small injected stylesheet — common ad
///      containers are hidden even when they are served first-party.
///
/// The built-in domain list is intentionally a starter set, inspired
/// by EasyList-style lists, not a copy of them. Users add their own
/// domains in `custom-filters.txt` (see Settings) and those are
/// merged in on every launch, so the list grows without recompiling.
///
/// Future extension point, if you ever want the real thing: add a
/// Safari Web Extension target that ships uBlock Origin Lite's rules,
/// and let the user pick "built-in" vs "Safari extension" in Settings.
/// The rest of the browser does not need to change for that.
enum ContentBlocker {

    /// Starter ad / tracker domains. Third-party only, so a site
    /// serving its own images is never blocked by these rules.
    static let builtInDomains: [String] = [
        // Google ads / tracking
        "doubleclick.net", "googlesyndication.com", "googleadservices.com",
        "google-analytics.com", "googletagmanager.com", "googletagservices.com",
        "adservice.google.com", "pagead2.googlesyndication.com",
        // Meta
        "facebook.net", "connect.facebook.net",
        // Other common ad networks / trackers
        "amazon-adsystem.com", "adsystem.com", "criteo.com", "adsrvr.org",
        "adnxs.com", "rubiconproject.com", "moatads.com", "scorecardresearch.com",
        "quantserve.com", "outbrain.com", "taboola.com", "ads.yahoo.com",
        "advertising.com", "pubmatic.com", "openx.net", "smartadserver.com",
        "ads-twitter.com", "analytics.twitter.com", "hotjar.com",
        "fullstory.com", "mixpanel.com", "segment.io", "amplitude.com",
        "newrelic.com", "nr-data.net", "optimizely.com", "crazyegg.com",
        "mouseflow.com", "chartbeat.com", "parsely.com", "matomo.cloud",
        "adroll.com", "bidswitch.net", "casalemedia.com", "simpli.fi",
        "media.net", "revcontent.com", "mgid.com", "zedo.com",
        "popads.net", "popcash.net", "propellerads.com", "adcash.com",
        "doubleverify.com", "integralads.com", "adsafeprotected.com",
    ]

    /// Common ad-container selectors, hidden with CSS. Kept short on
    /// purpose: an over-broad list is how cosmetic filters break
    /// real page layouts. Add selectors in the stylesheet below.
    static let cosmeticCSS = """
    [id^="google_ads"], [class*="google-ad"], .ad-container, .ad-banner,
    .advertisement, #advertisement, .adsbygoogle, .ad-slot, .ad-wrapper,
    [data-ad], [aria-label="Advertisement"] { display: none !important; }
    """

    /// Domains from the user's custom-filters.txt, if present.
    static func customDomains() -> [String] {
        guard let text = try? String(contentsOf: Settings.customFiltersURL, encoding: .utf8) else {
            return []
        }
        return text
            .components(separatedBy: .newlines)
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty && !$0.hasPrefix("!") && !$0.hasPrefix("#") }
            // Allow "||example.com^" style lines: take just the domain.
            .map { $0.trimmingCharacters(in: CharacterSet(charactersIn: "|^")) }
            .filter { $0.contains(".") }
    }

    /// Build the WKContentRuleList JSON for the full domain set.
    /// Each rule: if a third-party request's *URL* matches the domain
    /// (or a subdomain of it), block it, for any resource type.
    /// Note the WKContentRuleList distinction that matters here:
    /// `url-filter` matches the resource being loaded, while
    /// `if-domain` matches the page you are on — so the domain
    /// has to go in `url-filter`, not `if-domain`.
    static func ruleJSON() -> String {
        let domains = Array(Set(builtInDomains + customDomains())).sorted()
        var rules: [[String: Any]] = domains.map { domain in
            let escaped = domain.replacingOccurrences(of: ".", with: "\\.")
            return [
                "trigger": [
                    "url-filter": "^https?://([^/]*\\.)?\(escaped)(/|\\?|$)",
                    "load-type": ["third-party"],
                    "resource-type": ["script", "image", "style-sheet", "font",
                                      "media", "raw", "popup", "other"],
                ],
                "action": ["type": "block"],
            ]
        }
        // Also block obvious ad paths even when first-party, but only
        // for scripts and images, so page content itself is untouched.
        rules.append([
            "trigger": [
                "url-filter": ".*/(ads|adserver|advertising|doubleclick)/.*",
                "resource-type": ["script", "image"],
            ],
            "action": ["type": "block"],
        ])
        let data = try! JSONSerialization.data(withJSONObject: rules, options: [])
        return String(data: data, encoding: .utf8)!
    }

    /// Compile and install the rule list on a configuration.
    /// Runs asynchronously; the web view works fine while it compiles,
    /// it just gets the blocker a moment after launch.
    static func install(into configuration: WKWebViewConfiguration,
                        completion: (() -> Void)? = nil) {
        let store = WKContentRuleListStore.default()
        let identifier = "MinimalBrowserBlocker"
        store.compileContentRuleList(
            forIdentifier: identifier,
            encodedContentRuleList: ruleJSON()
        ) { list, error in
            if let list = list {
                configuration.userContentController.add(list)
            } else if let error = error {
                // Blocking is best-effort: a failed compile must
                // never stop the browser from opening.
                NSLog("MinimalBrowser: blocker compile failed: \(error)")
            }
            completion?()
        }
    }

    /// The cosmetic stylesheet, injected at document start.
    static func cosmeticUserScript() -> WKUserScript {
        let js = """
        (function() {
            var s = document.createElement('style');
            s.textContent = \(cosmeticCSS.debugDescription);
            (document.head || document.documentElement).appendChild(s);
        })();
        """
        return WKUserScript(source: js,
                            injectionTime: .atDocumentStart,
                            forMainFrameOnly: false)
    }
}

import Foundation

/// All user-facing tuning lives here, in one place.
///
/// The point of this file: "highly customisable later" should not mean
/// hunting through view code. Change a default here, or drop a
/// `config.json` in Application Support, and the app picks it up
/// without touching the browser logic.
///
/// Config file location (created on first launch):
///   ~/Library/Application Support/MinimalBrowser/config.json
///   ~/Library/Application Support/MinimalBrowser/custom-filters.txt
struct Settings: Codable {
    /// Height of the slim top bar, in points. 28 is the default:
    /// tall enough for the traffic lights, small enough to disappear.
    var topBarHeight: CGFloat = 28

    /// Opacity of the glass behind the top bar, 0.0 - 1.0.
    /// 0.02 is ~98% transparent: the blur is barely there, the
    /// buttons on top stay fully opaque because they are siblings
    /// of the glass view, not children of it. See TopBarView.
    var topBarGlassOpacity: CGFloat = 0.02

    /// Width of the vertical tab sidebar when it is revealed.
    var sidebarWidth: CGFloat = 220

    /// How close to the right edge (in points) the mouse has to be
    /// before the sidebar slides out.
    var sidebarHoverEdgeWidth: CGFloat = 24

    /// Seconds to wait after the mouse leaves before hiding again.
    /// Small delay so the sidebar does not flicker when you overshoot.
    var sidebarHideDelay: TimeInterval = 0.35

    /// Page shown for a new tab. "start" is the built-in minimal page.
    /// Set this to any URL to use that as your home page instead.
    var homePage: String = "start"

    /// Search engine used when Go to URL gets plain words, not a URL.
    var searchEngineURL: String = "https://duckduckgo.com/?q=%@"

    /// The uBlock-style blocker. On by default, toggleable from the
    /// three-dot menu, and persisted in UserDefaults.
    var blockerEnabled: Bool = true

    /// Show the 2pt loading progress line under the top bar.
    /// This is not a control, just feedback, and it costs nothing.
    var showProgressLine: Bool = true

    static var defaults: Settings { Settings() }

    // MARK: - Loading

    static var supportDirectory: URL {
        let dir = FileManager.default.urls(for: .applicationSupportDirectory,
                                           in: .userDomainMask).first!
            .appendingPathComponent("MinimalBrowser", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir,
                                                 withIntermediateDirectories: true)
        return dir
    }

    static var configURL: URL { supportDirectory.appendingPathComponent("config.json") }
    static var customFiltersURL: URL { supportDirectory.appendingPathComponent("custom-filters.txt") }

    /// Load from config.json if it exists and parses, otherwise defaults.
    /// A broken config never breaks the browser: it falls back silently
    /// and the next save overwrites it with something valid.
    static func load() -> Settings {
        guard let data = try? Data(contentsOf: configURL),
              let decoded = try? JSONDecoder().decode(Settings.self, from: data)
        else { return .defaults }
        return decoded
    }

    /// Write the current settings back, and seed the example
    /// custom-filters file on first launch so users can see the format.
    func save() {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        if let data = try? encoder.encode(self) {
            try? data.write(to: Self.configURL, options: .atomic)
        }
        if !FileManager.default.fileExists(atPath: Self.customFiltersURL.path) {
            let example = """
            ! MinimalBrowser custom filters.
            ! One blocked domain per line. Lines starting with ! are comments.
            ! These are merged with the built-in list on every launch.
            ! Example:
            ! ads.example.com
            ! tracker.example.net
            """
            try? example.write(to: Self.customFiltersURL, atomically: true, encoding: .utf8)
        }
    }
}

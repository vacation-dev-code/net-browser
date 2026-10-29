import Foundation

/// The built-in new-tab page.
///
/// Why a start page at all? Because the top bar deliberately has
/// no address bar — only back, forward, and ⋯. So somewhere has
/// to accept a URL, and the new-tab page is the least intrusive
/// place for it, alongside Cmd+L / the ⋯ menu's "Go to URL…".
///
/// The page talks back to Swift through the "navigate" message
/// handler (see BrowserViewController), which receives whatever
/// was typed and turns it into a URL or a search.
enum StartPage {
    static let html = """
    <!doctype html>
    <html><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>New Tab</title>
    <style>
      * { box-sizing: border-box; }
      body {
        margin: 0; min-height: 100vh; display: flex;
        flex-direction: column; align-items: center; justify-content: center;
        font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif;
        background: #f5f5f7; color: #1d1d1f;
        padding-top: 28px; /* clear the slim top bar */
      }
      @media (prefers-color-scheme: dark) {
        body { background: #1c1c1e; color: #f5f5f7; }
        input { background: #2c2c2e !important; color: #f5f5f7 !important; border-color: #3a3a3c !important; }
      }
      h1 { font-weight: 600; font-size: 28px; letter-spacing: -0.5px; margin: 0 0 24px; opacity: 0.9; }
      form { width: min(560px, 86vw); }
      input {
        width: 100%; padding: 12px 18px; font-size: 16px; border-radius: 999px;
        border: 1px solid #d2d2d7; background: #fff; outline: none;
        box-shadow: 0 1px 4px rgba(0,0,0,0.06);
      }
      input:focus { border-color: #007aff; box-shadow: 0 0 0 3px rgba(0,122,255,0.15); }
      p { margin-top: 20px; font-size: 13px; opacity: 0.55; }
      kbd { font-family: inherit; background: rgba(127,127,127,0.18); padding: 1px 6px; border-radius: 4px; }
    </style></head>
    <body>
      <h1>Minimal</h1>
      <form id="f"><input id="q" type="text" placeholder="Search or type a URL" autocomplete="off" autofocus></form>
      <p><kbd>⌘L</kbd> go to a URL &nbsp;·&nbsp; <kbd>⌘T</kbd> new tab &nbsp;·&nbsp; hover the right edge for tabs</p>
      <script>
        document.getElementById('f').addEventListener('submit', function(e) {
          e.preventDefault();
          var v = document.getElementById('q').value.trim();
          if (v) window.webkit.messageHandlers.navigate.postMessage(v);
        });
      </script>
    </body></html>
    """

    /// Turn typed text into a URL: a full URL as-is, a bare domain
    /// gets https://, and anything else becomes a search query.
    static func url(for input: String, settings: Settings) -> URL? {
        let text = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return nil }
        if let url = URL(string: text), url.scheme != nil {
            return url
        }
        if text.contains(".") && !text.contains(" ") {
            return URL(string: "https://\(text)")
        }
        let query = text.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? text
        return URL(string: settings.searchEngineURL.replacingOccurrences(of: "%@", with: query))
    }
}

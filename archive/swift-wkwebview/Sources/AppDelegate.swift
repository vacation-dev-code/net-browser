import AppKit

/// Minimal, native, no Electron, no bundled Chromium.
///
/// The whole app is AppKit + WKWebView (the system Safari engine),
/// which is why it can stay lightweight: no second browser engine
/// is shipped, started, or updated by this app.
@main
final class AppDelegate: NSObject, NSApplicationDelegate {
    private var windows: [NSWindow] = []

    func applicationDidFinishLaunching(_ notification: Notification) {
        openNewWindow()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }

    /// One window = one BrowserViewController = one TabManager.
    /// Kept in `windows` so windows are not deallocated the moment
    /// this function returns (NSWindow is not retained by its
    /// content view controller alone in this setup).
    func openNewWindow() {
        let controller = BrowserViewController()
        let window = NSWindow(contentViewController: controller)
        window.styleMask = [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView]
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.isMovableByWindowBackground = false
        window.minSize = NSSize(width: 480, height: 320)
        window.setContentSize(NSSize(width: 1100, height: 750))
        window.center()
        window.makeKeyAndOrderFront(nil)
        windows.append(window)
    }
}

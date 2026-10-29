---
name: verify
description: Launch Net (Electron) on macOS, drive the UI through CDP, and screenshot the real window including the native traffic lights.
---

# Verify Net on macOS

## Launch
```bash
npm install                                   # first time; downloads Electron
npm start -- --remote-debugging-port=9333     # prestart renames Electron.app's plist to "Net"
bash assets/build-mac-app.sh                  # packaged: dist/Net.app -> /Applications/Net.app
```
Wait for `curl -s localhost:9333/json` to answer before driving.

## Drive
- Evaluate in the UI page: connect to the `renderer/index.html` target from
  `/json` and send `Runtime.evaluate` (Node 22+ has global `WebSocket`).
  Renderer globals such as `tabs`, `newTab(url)`, `selectTab(id)`, `settings` are reachable.
- Real input: `Input.dispatchMouseEvent` (mouseMoved at x≈5 or x≈width-4 opens the tabs pane).

## Screenshot
`screencapture -x -o -l <windowId> out.png`. Bring the window forward first
(`osascript ... set frontmost of (first process whose unix id is PID)`) and pick the
window id from `CGWindowListCopyWindowInfo` (owner PID, named, >600px wide).
Electron's `capturePage` misses the native traffic lights, so use screencapture.

## Gotchas
- Focusing the window makes macOS send a mousemove from the REAL cursor, which
  closes the hover pane. Pin it (⋯ → Keep pane open, or `#pin-pane` click) for stills.
- Dev runs and Net.app share userData `~/Library/Application Support/net-browser`
  with the user's real profile. Restore any settings you change
  (`localStorage['net-browser.settings']`).
- Traffic lights: probe the FIRST pane open after launch. Positioning bugs show up there.
- The Dock auto-hides here and osascript lacks accessibility access, so the Dock tile
  itself can't be screenshotted. Check the bundle plist/icon and the process name instead.

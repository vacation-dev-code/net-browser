# Minimal — a minimalist macOS browser

Native, lightweight, no Electron, no bundled Chromium. It is AppKit +
WKWebView (the system Safari engine), so there is no second browser
to ship, start, or update.

## What it does

- **Slim, almost-invisible top bar** — 28pt tall by default, floating
  over the page (not pushing it down), with liquid-glass material at
  ~2% opacity. The buttons stay fully opaque; only the glass is faint.
- **Exactly three controls in that bar** — back, forward, and ⋯.
  No address bar, no toolbar clutter. macOS traffic lights stay in
  the top-left corner, as usual.
- **Hidden vertical tabs on the right** — width 0 until your mouse
  hovers near the right edge, then the sidebar slides out over the
  page (it never reflows the page). Move away and it slides back.
  Click a tab to switch, hover a row for its ×, `+ New Tab` at the bottom.
- **uBlock-style blocking, built in** — see the honest note below.
  Toggle it from ⋯, add your own domains without recompiling.
- **No address bar, on purpose** — navigate from:
  - the new-tab page's search / URL field,
  - `⌘L` or ⋯ → Go to URL…,
  - a link, a bookmark you paste in, or a search.

## Build and run (on a Mac)

```bash
cd minimal-browser
./build.sh run
```

Requires only the Xcode Command Line Tools (`swiftc`). No Xcode
project is needed for v1; if you want one later, create a macOS App
project in Xcode and drop `Sources/*.swift` + `Info.plist` into it.

This workspace runs on Linux, so the code was written and checked
here but **not compiled here** — the first real compile happens
on your Mac with `./build.sh`. If `swiftc` reports an error, paste
it back and I will fix that exact line; the structure is small
enough that a compile error is a one-file fix, not a redesign.

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `⌘T` | New tab |
| `⌘W` | Close tab |
| `⌘L` | Go to URL / search |
| `⌘R` | Reload |
| `⌘[` / `⌘]` | Back / forward |

## The uBlock Origin question, answered honestly

WKWebView cannot load a real Safari or Chrome extension, so the
actual uBlock Origin extension cannot run inside this app, and
this project does not pretend otherwise.

What it ships instead, in `Sources/ContentBlocker.swift`, is the
same job with WKWebView's own tools:

1. **Network blocking** via `WKContentRuleList` — requests to known
   ad/tracker domains are dropped before they are sent.
2. **Cosmetic hiding** via an injected stylesheet for common ad containers.

The starter list is EasyList-*inspired* (Google/Meta ad and tracker
domains, common ad networks), not a copy of EasyList. If you want
the real uBlock Origin, the path is Safari + its App Store extension
— a different app shape — and that is noted as a future extension
point in the code, not shipped as a claim.

## Customising it (the "later" part, already wired up)

All tuning lives in one struct: `Sources/Settings.swift`.

On first launch the app creates:

```
~/Library/Application Support/MinimalBrowser/config.json
~/Library/Application Support/MinimalBrowser/custom-filters.txt
```

Edit `config.json`, then ⋯ → Reload Config (no rebuild needed):

```json
{
  "topBarHeight": 28,
  "topBarGlassOpacity": 0.02,
  "sidebarWidth": 220,
  "sidebarHoverEdgeWidth": 24,
  "sidebarHideDelay": 0.35,
  "homePage": "start",
  "searchEngineURL": "https://duckduckgo.com/?q=%@",
  "blockerEnabled": true,
  "showProgressLine": true
}
```

- `topBarGlassOpacity`: 0.0–1.0. 0.02 is ~98% transparent.
  Raise it (e.g. 0.25) if you want the glass to read more.
- `sidebarWidth` / `sidebarHoverEdgeWidth`: how wide the tab bar
  is, and how close to the edge triggers it.
- `homePage`: `"start"` for the built-in page, or any URL.
- `searchEngineURL`: swap DuckDuckGo for anything with a `%@` query slot.

For the blocker, add one domain per line to `custom-filters.txt`
(lines starting with `!` are comments). Those domains are merged
with the built-in list on every launch. Turning the blocker off
and on again in ⋯ applies to new loads without a restart; a page
already open needs a reload.

## File map

```
Sources/
  AppDelegate.swift            window creation, full-size content view
  BrowserViewController.swift  layout, hover logic, ⋯ menu, shortcuts, delegates
  TopBarView.swift             28pt glass bar: back, forward, ⋯ only
  SidebarView.swift            right-edge vertical tabs
  Tab.swift                    Tab + TabManager (shared process pool)
  ContentBlocker.swift         network rules + cosmetic hiding + custom filters
  Settings.swift               every tunable, plus config.json loading
  StartPage.swift              new-tab page + URL-or-search parsing
build.sh                       swiftc → Minimal.app, no Xcode needed
Info.plist                     bundle metadata
```

## Deliberately not in v1

- Downloads UI, Find in page, per-site blocker exceptions, favicons,
  tab suspension for very large tab counts, and sync. Each is a
  small, named next step in its file — none of them requires
  restructuring the window, the bar, or the sidebar.
- A real address bar. That is a product decision, not an omission:
  the bar is specified as back / forward / ⋯ only, and adding an
  address field later is one view change in `TopBarView.swift`.

## Next steps you might ask for

- A theme / accent system on top of `Settings`
- Sidebar in "push" mode (page shrinks instead of being overlaid)
- Per-site blocker toggle, or importing a full EasyList file
- An Xcode project file, so it opens as a normal Xcode app
- Favicon fetching for the tab rows

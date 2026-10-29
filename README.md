# Net Browser v0.1

A minimalist browser, versioned **0.1.0**, with **uBlock Origin / EasyList ad blocking** — the real filter lists, not a hand-written lookalike. macOS first, Arch Linux supported too: see [README-arch.md](README-arch.md) for the Arch install, PKGBUILD, and how liquid glass works there without macOS vibrancy.

## What v0.1 is

- **No top bar — one floating liquid-glass tabs pane** — all of the browser's chrome lives in a glass panel that stays off-screen until your mouse touches the window edge, then slides out over the page. It is layered: a frosted nav capsule up top (back, reload, forward), your tabs in the middle (the active one raised as its own glass chip), and the logo plus a round ⋯ button at the bottom. No window buttons — close the window from your window manager, or quit with `⌘Q` / `Ctrl+Q`. On macOS the traffic lights move into the pane while it is open.
- **Settings in ⋯** — Theme (Auto / Light / Dark — also switches websites that support dark mode), Tabs pane (Left / Right), Keep pane open. They survive restarts.
- **Right-click menu** — on a link: Open Link in New Tab (opens in the background; the pane peeks open to show it), Copy Link. On selected text: Copy. In a text field: Cut / Copy / Paste. Links that ask for a new window (`target=_blank`, `window.open`) open as tabs.
- **No address bar, on purpose** — navigate from the new-tab page, `⌘L`, or ⋯ → Go to URL….
- **uBlock Origin / EasyList filters on every tab** — requests blocked and ad containers hidden. See the next section, because the details matter and they are easy to get wrong.

## The ad-blocking part — read this, it is the whole point of v0.1

### What v0.1 ships

**[@ghostery/adblocker-electron](https://github.com/ghostery/adblocker)**, a filter engine that reads uBlock Origin and EasyList syntax, running Ghostery's prebuilt ads + tracking lists: EasyList, EasyPrivacy, uBlock Origin's filters, and uBlock's privacy list.

`main.js` enables it on the `persist:minimal` session that every tab uses. It works at two levels: it cancels ad and tracker requests before they leave the browser, and a page preload hides ad containers (cosmetic filters). The lists download on first launch, are cached in Electron's userData folder (`~/.config/net-browser/` on Linux, `~/Library/Application Support/net-browser/` on macOS), and refresh weekly. On/off is in Net Browser's ⋯ menu.

### Why not the uBlock extension itself

An earlier v0.1 build loaded **uBlock Origin Lite**, the official Manifest V3 build by Raymond Hill, as an unpacked extension. It loaded without error and blocked nothing:

- Electron supports only a subset of Chrome's extension APIs. It has no `chrome.permissions`, so Lite's service worker crashes on startup.
- Electron did not apply Lite's built-in `declarativeNetRequest` rulesets either. Tested Oct 2026: with Lite "loaded", `adsbygoogle.js` still loaded.

Full uBlock Origin is no way out. It is Manifest V2, and Google disabled MV2 in Chrome 138 (July 2025), removed the MV2 code in Chrome 150/151 (June–July 2026), and removed all remaining MV2 extensions from the Chrome Web Store on 31 August 2026. Electron runs current Chromium, so it inherits that removal. Pinning an old, insecure Chromium to keep MV2 alive would be shipping known vulnerabilities to users who trust this browser to block things — v0.1 does not do that.

Its limits, stated plainly:

- Same filter syntax and lists as uBlock, not uBlock's engine: no dynamic filtering, no element picker, no per-site exceptions in v0.1.
- Lists refresh weekly, not continuously, so it adapts to YouTube's anti-adblock changes **slower** than full uBlock on Firefox. Expect **most** ads blocked — but "most" is not "never, reliably, forever." No Chromium blocker can honestly promise that in Oct 2026, and this README will not.

### If stable YouTube blocking is the #1 requirement

Then the honest answer, also in Oct 2026, is **not Chromium**:

- **Firefox + full uBlock Origin** still runs the complete MV2 build, with dynamic filtering and CNAME uncloaking, and Mozilla has said that support is not going anywhere.
- **Brave** self-hosts MV2 uBlock Origin and has its own built-in Rust adblock engine that also blocks most YouTube ads.

That is the obvious v0.2 fork: a Firefox edition of Minimal with full uBlock Origin, keeping the same hidden tabs pane. v0.1 is the Chromium edition.

## Run v0.1

```bash
git clone https://github.com/vacation-dev-code/net-browser.git
cd net-browser
./net.sh     # first run installs dependencies, then starts the browser
```

Needs Node.js and npm — macOS: `brew install node`; Arch: `bash arch/install-arch.sh` installs them for you (see [README-arch.md](README-arch.md)). `./net.sh` is just `npm install` (first run only) and `npm start`, if you prefer to type those.

The first launch downloads Electron's binary and the filter lists (about 7 MB, then cached), so it needs a network connection.

Tested on Arch Linux with Electron 45 (Oct 2026): inside a tab, the blocker cancels `adsbygoogle.js` and hides list-targeted ad containers while leaving ordinary page elements alone. The first real macOS run is still yours.

## Test YouTube blocking

1. `npm start`, confirm the ⋯ menu says "Ad blocker: On" and no yellow warning bar appears.
2. Open youtube.com, play a video that normally shows a pre-roll ad.
3. What to expect in v0.1: most pre-roll/mid-roll ads blocked. If an ad slips through on a new YouTube experiment, the lists may not have caught up yet — delete `adblocker-engine.bin` from the userData folder to fetch the newest lists before the weekly refresh.
4. To compare against the strongest option, open the same video in Firefox + full uBlock Origin. If that difference matters to your users, that is the signal to build the Firefox edition next.

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `⌘T` | New tab |
| `⌘W` | Close tab |
| `⌘L` | Go to URL / search |
| `⌘R` | Reload |
| `⌘[` / `⌘]` | Back / forward |
| `⌘1` … `⌘9` | Go to tab 1 … 9 |

Shortcuts are native menu accelerators in `main.js`, so they work even when a web page has focus (renderer key listeners alone would not). `⌘1`…`⌘9` are caught in `main.js` before any page sees the key, for the same reason. On Linux every `⌘` is `Ctrl`.

## File map — v0.1

```
package.json                  version 0.1.0, electron ^45, @ghostery/adblocker-electron
main.js                       window, native menu, ad blocker on the tabs' session
preload.js                    UI-only bridge (pages get no Node access)
renderer/
  index.html                  start page, tabs pane skeleton, ⋯ menu
  styles.css                  layered liquid-glass tabs pane, light + dark
  renderer.js                 tabs, hover pane, ⋯ menu + settings, navigation
  net-logo.png                pane logo (from net-logo.svg — which is a PNG)
archive/swift-wkwebview/      pre-v0.1 Swift version, uBlock-style only
```

## What changed from the Swift version, and why

The Swift/WKWebView version is archived, not deleted. It was lighter and more native, but WKWebView cannot load extensions at all, so it could only ever do a uBlock-*style* rule list. Users who choose a browser *for* uBlock do not want a lookalike — they want uBlock's actual filter lists and their updates. Chromium/Electron hands every request to the main process, which is what makes running those real lists possible, at the cost of a heavier app bundle. That trade-off is the v0.1 decision, and it is reversible: if the Firefox edition wins, the UI spec (hidden tabs pane, no top bar, no address bar) ports over unchanged.

## Deliberately not in v0.1

- Element picker and custom filter lists (the engine supports both; v0.1 has no UI for them)
- Packaged `.dmg` / auto-update (run from source with `npm start` for now)
- Downloads UI, Find in page, per-site exceptions, favicons, sync
- Migration from `<webview>` (deprecated) to WebContentsView + push sidebar — planned, see the comment at the top of `renderer/renderer.js`

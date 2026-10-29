# Net Browser v0.1 on Arch Linux

Yes — the same v0.1, on Arch, with liquid glass. Electron is cross-platform, so the app code did not need a rewrite. What Arch *did* need was: a frameless window (no macOS traffic lights), a glass implementation that does not depend on macOS, and proper Arch packaging. All of that is in this folder.

## Quick run (recommended first)

```bash
git clone https://github.com/vacation-dev-code/net-browser.git
cd net-browser
bash arch/install-arch.sh
./net.sh
```

That installs `nodejs`, `npm`, `git` with pacman, and runs `npm install` (bundled Electron + the ad blocker). The filter lists download on first launch. The browser itself is unchanged from the macOS v0.1: no top bar, one hidden tabs pane (left or right) holding back / reload / forward, the tabs and ⋯, no address bar, uBlock Origin / EasyList ad blocking on every tab, and the Claude pane (a terminal running Claude Code beside the page, which needs Claude Code installed — see the main README).

## Proper package (optional)

```bash
bash arch/build-pkg.sh
sudo pacman -U arch/build/net-browser-0.1.0-1-x86_64.pkg.tar.zst
net-browser
```

This builds a real `.pkg.tar.zst` with `makepkg`. It uses Arch's system `electron` package instead of the npm-bundled one, installs the app to `/usr/share/net-browser`, the launcher to `/usr/bin/net-browser`, the desktop entry to `/usr/share/applications/`, and the icon to `/usr/share/icons/hicolor/512x512/apps/`. The ad blocker and the Claude pane's terminal (xterm.js, and node-pty's prebuilt x86_64 binary, which works with any Electron) ship inside the package as a production-only `node_modules` (no bundled Electron); the filter lists download on first launch.

Note: the PKGBUILD in this folder is a *local* build, not AUR-ready yet — its `url` is a placeholder and its checksum is `SKIP`. Replace both with your real repo URL and tarball checksum before submitting it to the AUR. That is stated in the PKGBUILD header too, so it does not silently ship that way.

## Liquid glass on Arch — the important part

On macOS, Net Browser gets glass from the window system (`vibrancy: 'sidebar'` in Electron). **Electron's vibrancy is macOS-only — it does nothing on Linux.** So on Arch, the glass is rebuilt in CSS, in `renderer/styles.css`, and it is the same glass on both platforms now:

- The tabs pane **overlays** the page instead of reserving space beside it, so the page actually runs underneath the glass.
- `backdrop-filter: blur(28px) saturate(180%) brightness(1.12)` — blur, saturation and brightness, the three things that make a panel read as glass rather than just translucent.
- A translucent white base, a specular top highlight (`inset 0 1px 0 rgba(255,255,255,0.65)`), and a soft shadow. That highlight is what keeps it looking like *liquid* glass even where true backdrop blur is unavailable.
- A `@supports` fallback: if the browser/compositor cannot do `backdrop-filter` at all, the bars become solid translucent panels instead of invisible ones.

### What makes it look best, by desktop

- **KDE Plasma (KWin, X11 or Wayland):** blur works out of the box in most setups. If it looks flat, check System Settings → Window Management → Desktop Effects → Blur is on.
- **GNOME (Mutter):** blur for Chromium content works; window-level blur extensions are not required for the pane's glass, because the glass is in the page, not the window frame.
- **Hyprland / tiling WMs:** enable blur in `hyprland.conf` (`decoration { blur { enabled = true } }`) for the best result, and make sure you are actually running a compositor — Hyprland is one, so you already are.
- **i3 / bspwm / other non-compositing WMs:** install and run a compositor, e.g. `sudo pacman -S picom && picom &`, or the glass will fall back to translucent (still readable, just not blurred). This is the one Arch-specific gotcha: without a compositor, no Chromium app can blur anything.
- **No compositor at all, or you just want a normal frame:** run with `NET_BROWSER_OPAQUE=1 npm start`. That gives you a native window frame and an opaque window, and the CSS glass falls back to a solid panel.

### Honest limits on Linux glass

1. Chromium does not always sample a `<webview>` guest surface for `backdrop-filter`, so over a web page the glass may be *translucent* (page showing through) rather than *blurred* (page smeared). The specular highlight and saturation are there precisely so it still reads as glass in that case. If you want guaranteed blur over pages, that is a v0.2 job (WebContentsView + a different layering), and it is noted as such in the code.
2. The frameless window means the tabs pane's top row *is* the title bar. Open the pane and drag the window by that row (not by its buttons). There are no minimise / maximise / close buttons on Linux: use your window manager (on Hyprland, its own keybindings) or `Ctrl+Q` to quit. macOS users get traffic lights in that row instead; the code branches on `process.platform`.

## Wayland vs X11

- Wayland is the default path: the launcher sets `ELECTRON_OZONE_PLATFORM_HINT=auto`. If the window is blank or decorations look wrong on your compositor, try explicitly:
  ```bash
  ELECTRON_OZONE_PLATFORM_HINT=wayland npm start
  # or, on XWayland:
  ELECTRON_OZONE_PLATFORM_HINT=x11 npm start
  ```
- X11 needs a compositor for blur (see above). Wayland compositors are compositors by definition, so blur is normally available there without extra setup.

## Shortcuts on Arch

Same actions as macOS, with Ctrl instead of ⌘: `Ctrl+T` new tab, `Ctrl+W` close tab, `Ctrl+L` go to URL, `Ctrl+R` reload, `Ctrl+[` / `Ctrl+]` back / forward, `Ctrl+1`…`Ctrl+9` go to tab 1…9. The start page hints switch to Ctrl automatically on Linux. They are native menu accelerators, so they work even when a web page has focus.

## Files in this folder

```
arch/
  install-arch.sh       quick route: pacman deps + npm install
  build-pkg.sh          makes a source tarball and runs makepkg
  PKGBUILD              system-Electron package (local build, see header)
  net-browser           /usr/bin launcher (system Electron, Wayland hint)
  net-browser.desktop   desktop entry (app menu, mime types)
  net-browser.png       512px icon, converted from assets/net-browser-icon-1024.png
README-arch.md          this file (kept next to arch/, not inside it, so it is easy to find)
```

## Troubleshooting

- **"Ad blocker unavailable" warning bar:** the filter lists could not be downloaded on first launch. Check the connection, then restart. After one successful launch they are cached in `~/.config/net-browser/`.
- **Window has no close button:** by design — the frameless Linux build has no window buttons. Close it from your window manager, or quit with `Ctrl+Q`.
- **Glass looks flat white:** no compositor, or `backdrop-filter` unsupported. Start `picom`, or use `NET_BROWSER_OPAQUE=1`.
- **Electron version mismatch (system package route):** the PKGBUILD route uses Arch's `electron` package; if Arch moves to a version that drops `<webview>` support, pin the npm-bundled route (`install-arch.sh`) instead — that is why both routes exist.

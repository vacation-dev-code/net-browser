#!/bin/bash
# Net Browser: turn the 1024px PNG icon into a macOS .icns file.
# Run ON A MAC (this uses macOS-only sips + iconutil):
#   cd minimal-browser
#   bash assets/make-icns.sh
# Output: assets/net-browser.icns  (then point your packager at it;
# v0.1 runs from source with `npm start`, so this is not wired into package.json yet.)
set -euo pipefail
cd "$(dirname "$0")/.."
ICONSET="assets/net-browser.iconset"
rm -rf "$ICONSET" assets/net-browser.icns
mkdir -p "$ICONSET"
SRC="assets/net-browser-icon-1024.png"
sips -z 16 16     "$SRC" --out "$ICONSET/icon_16x16.png" >/dev/null
sips -z 32 32     "$SRC" --out "$ICONSET/icon_16x16@2x.png" >/dev/null
sips -z 32 32     "$SRC" --out "$ICONSET/icon_32x32.png" >/dev/null
sips -z 64 64     "$SRC" --out "$ICONSET/icon_32x32@2x.png" >/dev/null
sips -z 128 128   "$SRC" --out "$ICONSET/icon_128x128.png" >/dev/null
sips -z 256 256   "$SRC" --out "$ICONSET/icon_128x128@2x.png" >/dev/null
sips -z 256 256   "$SRC" --out "$ICONSET/icon_256x256.png" >/dev/null
sips -z 512 512   "$SRC" --out "$ICONSET/icon_256x256@2x.png" >/dev/null
sips -z 512 512   "$SRC" --out "$ICONSET/icon_512x512.png" >/dev/null
sips -z 1024 1024 "$SRC" --out "$ICONSET/icon_512x512@2x.png" >/dev/null
iconutil -c icns "$ICONSET" -o assets/net-browser.icns
echo "Wrote assets/net-browser.icns"

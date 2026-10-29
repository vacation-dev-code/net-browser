#!/bin/bash
# Build Minimal.app on a Mac — no Xcode project needed.
# Requires only the Xcode Command Line Tools (for swiftc).
#
#   ./build.sh          build Minimal.app in this folder
#   ./build.sh run      build and launch it
set -euo pipefail
cd "$(dirname "$0")"

APP="Minimal.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

echo "Compiling Swift sources…"
swiftc -O \
  -o "$APP/Contents/MacOS/Minimal" \
  Sources/*.swift \
  -framework AppKit -framework WebKit

cp Info.plist "$APP/Contents/Info.plist"

# Ad-hoc sign so Gatekeeper does not complain about an unsigned local build.
# If signing fails on your machine, the app usually still runs from Finder
# with a right-click → Open, so this is deliberately non-fatal.
codesign --force --deep --sign - "$APP" 2>/dev/null || true

echo "Built: $PWD/$APP"
if [[ "${1:-}" == "run" ]]; then
  open "$APP"
fi

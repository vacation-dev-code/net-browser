#!/bin/bash
# Net: build the app icon — assets/net-icon-1024.png (the Dock icon
# main.js sets at runtime) and assets/Net.icns (the Net.app bundle icon,
# used by assets/build-mac-app.sh).
# Run ON A MAC (sips, qlmanage and iconutil are macOS-only):
#   bash assets/make-icns.sh
# Source, first one found:
#   1. net-logo.svg (repo root, assets/ or renderer/) — rasterized at
#      1024px by Quick Look, so it stays sharp at every Dock size
#   2. renderer/net-logo.png — only 128px, so the large sizes are
#      upscaled and soft. Drop net-logo.svg in and re-run to fix that.
set -euo pipefail
cd "$(dirname "$0")/.."

SRC=""
for f in net-logo.svg assets/net-logo.svg renderer/net-logo.svg; do
  [[ -f "$f" ]] && SRC="$f" && break
done

OUT_PNG="assets/net-icon-1024.png"
if [[ -n "$SRC" ]]; then
  TMP=$(mktemp -d)
  qlmanage -t -s 1024 -o "$TMP" "$SRC" >/dev/null 2>&1
  mv "$TMP/$(basename "$SRC").png" "$OUT_PNG"
  rm -rf "$TMP"
else
  SRC="renderer/net-logo.png"
  echo "No net-logo.svg found; using $SRC (128px, upscaled)." >&2
  sips -z 1024 1024 "$SRC" --out "$OUT_PNG" >/dev/null
fi

ICONSET="assets/Net.iconset"
rm -rf "$ICONSET" assets/Net.icns
mkdir -p "$ICONSET"
for size in 16 32 128 256 512; do
  sips -z $size $size "$OUT_PNG" --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
  sips -z $((size * 2)) $((size * 2)) "$OUT_PNG" --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o assets/Net.icns
rm -rf "$ICONSET"
echo "Wrote $OUT_PNG and assets/Net.icns from $SRC"

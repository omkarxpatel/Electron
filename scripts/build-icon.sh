#!/usr/bin/env bash
# Regenerate build/icon.png and build/icon.icns from build/icon.svg.
#
# Uses only tools that ship with macOS — no Homebrew dependencies. The
# pipeline is:
#   1. qlmanage renders the SVG to a 1024×1024 PNG via Quick Look.
#   2. sips resizes that PNG to every size macOS wants in an iconset.
#   3. iconutil bundles the iconset into a single .icns file.
#
# Run from the repo root: `npm run icon:gen`
set -euo pipefail

cd "$(dirname "$0")/.."

SRC=build/icon.svg
OUT_PNG=build/icon.png
ICONSET=build/icon.iconset
ICNS=build/icon.icns

if [[ ! -f "$SRC" ]]; then
  echo "✗ Missing $SRC — drop your master SVG (1:1, 1024-friendly) there first." >&2
  exit 1
fi

echo "→ Rendering $SRC at 1024 px"
rm -f "$OUT_PNG" "build/$(basename "$SRC").png"
qlmanage -t -s 1024 -o build "$SRC" >/dev/null
mv "build/$(basename "$SRC").png" "$OUT_PNG"

echo "→ Generating iconset sizes"
rm -rf "$ICONSET"
mkdir -p "$ICONSET"
for size in 16 32 128 256 512; do
  retina=$((size * 2))
  sips -z "$size" "$size" "$OUT_PNG" --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
  sips -z "$retina" "$retina" "$OUT_PNG" --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
done

echo "→ Bundling .icns"
rm -f "$ICNS"
iconutil -c icns "$ICONSET" -o "$ICNS"

echo "✓ Wrote $OUT_PNG and $ICNS"
ls -lh "$OUT_PNG" "$ICNS"

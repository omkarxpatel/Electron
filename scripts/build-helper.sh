#!/usr/bin/env bash
# Compile the CoreAudio volume helper into a universal binary.
#
# Universal is not optional: build.mac.target ships both arm64 and x64, and
# electron-builder copies extraResources verbatim for every arch. A helper
# built only for the host arch would land in the Intel zip unable to execute,
# and the failure mode is silent — the app would just never fix the sink level.
set -euo pipefail

cd "$(dirname "$0")/.."
SRC=build/helpers/avvolume.swift
OUT=build/helpers/avvolume
# This runs from `predev`, so it must be cheap on the common path — two
# swiftc invocations on every `npm run dev` would be a tax for nothing.
if [ -x "$OUT" ] && [ "$OUT" -nt "$SRC" ]; then
  echo "helper up to date ($(lipo -archs "$OUT"))"
  exit 0
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

for arch in arm64 x86_64; do
  swiftc -O -whole-module-optimization \
    -target "${arch}-apple-macos11.0" \
    -o "$TMP/avvolume-$arch" "$SRC"
done

lipo -create -output "$OUT" "$TMP/avvolume-arm64" "$TMP/avvolume-x86_64"
chmod +x "$OUT"
echo "built $OUT -> $(lipo -archs "$OUT")"

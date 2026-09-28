#!/usr/bin/env bash
# Uploads an already-built release/ directory to the GitHub release for a tag.
#
# electron-builder's own publisher does this too, but on v1.1.0 it stalled for
# 21 minutes on a ~100 MB asset and failed the job with "Request timed out",
# leaving latest-mac.yml off the release and every installed app unable to see
# the update. `gh` retries per file instead of failing the whole batch, and
# latest-mac.yml is uploaded last so a partial upload never advertises
# artifacts that aren't there yet.
#
# Usage: scripts/publish-release.sh v1.1.0

set -euo pipefail

TAG="${1:?usage: publish-release.sh <tag>}"
cd "$(dirname "$0")/.."

REPO="$(node -p "const p = require('./package.json').build.publish; p.owner + '/' + p.repo")"

upload() {
  local file="$1"
  local name
  name="$(basename "$file")"
  local attempt backoff
  for attempt in 1 2 3 4 5; do
    if gh release upload "$TAG" "$file" --repo "$REPO" --clobber; then
      echo "uploaded $name"
      return 0
    fi
    backoff=$((attempt * 20))
    echo "upload of $name failed (attempt $attempt/5); retrying in ${backoff}s" >&2
    sleep "$backoff"
  done
  echo "giving up on $name after 5 attempts" >&2
  return 1
}

# The app fetches this alongside the feed so its update prompt can say what
# the release contains. Same text as the release body, so the two can't drift.
NOTES="release/release-notes.md"
if node scripts/release-notes.mjs "$TAG" > "$NOTES" 2>/dev/null; then
  echo "release notes extracted for ${TAG#v}"
else
  # Not fatal here — the workflow already failed the build on a missing
  # section long before this point. If we somehow get here anyway, a release
  # with no notes beats no release at all; the app treats them as optional.
  echo "no CHANGELOG section for ${TAG#v}; publishing without notes" >&2
  rm -f "$NOTES"
fi

# How this release should be DELIVERED, read from the same changelog heading.
# A separate small asset rather than a marker inside the notes: the notes are
# user-facing prose and the app must not have to parse English to decide
# whether it may restart itself.
META="release/release-meta.json"
INSTALL_CLASS="$(node scripts/release-notes.mjs "$TAG" --class 2>/dev/null || echo prompt)"
printf '{"version":"%s","install":"%s"}\n' "${TAG#v}" "$INSTALL_CLASS" > "$META"
echo "delivery class for ${TAG#v}: $INSTALL_CLASS"

if ! gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1; then
  echo "creating release $TAG"
  if [ -f "$NOTES" ]; then
    gh release create "$TAG" --repo "$REPO" --title "${TAG#v}" --notes-file "$NOTES"
  else
    gh release create "$TAG" --repo "$REPO" --title "${TAG#v}" --generate-notes
  fi
fi

# Artifacts first, update metadata last.
for file in release/*.dmg release/*.zip release/*.blockmap; do
  [ -e "$file" ] || continue
  upload "$file"
done

# Before latest-mac.yml: once the feed lands the app starts offering this
# version, and it should never advertise notes — or a delivery class — that
# aren't uploaded yet. A missing class reads as "prompt" in the app, so the
# ordering failure mode is an extra dialog rather than a silent restart.
[ -f "$NOTES" ] && upload "$NOTES"
[ -f "$META" ] && upload "$META"

upload "release/latest-mac.yml"

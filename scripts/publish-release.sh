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

if ! gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1; then
  echo "creating release $TAG"
  gh release create "$TAG" --repo "$REPO" --title "${TAG#v}" --generate-notes
fi

# Artifacts first, update metadata last.
for file in release/*.dmg release/*.zip release/*.blockmap; do
  [ -e "$file" ] || continue
  upload "$file"
done

upload "release/latest-mac.yml"

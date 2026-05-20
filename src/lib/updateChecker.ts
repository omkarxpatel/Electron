/**
 * Manual update checker. Polls GitHub Releases for the latest tag, compares
 * to the running app's version, and returns a download URL when a newer
 * release exists.
 *
 * Why manual (not electron-updater): macOS auto-update via Squirrel.Mac
 * requires a properly signed + notarized app bundle. This app is unsigned
 * (no Apple Developer Program subscription), so Squirrel can't swap
 * binaries cleanly. Instead, we surface "v0.1.6 is available" in the UI
 * and let the user download the DMG manually — same install dance they
 * did the first time, just faster than checking the Releases page by hand.
 *
 * Rate-limiting: GitHub's anonymous REST API allows 60 req/hour per IP.
 * We persist the last check timestamp + dismissed version in localStorage
 * so even an enthusiastic launch loop can't burn the budget.
 */

const RELEASES_API =
  'https://api.github.com/repos/omkarxpatel/Spotify-Visualizer-Modifier/releases/latest';

const LAST_CHECK_KEY = 'av.update.lastCheckAt';
const DISMISSED_VERSION_KEY = 'av.update.dismissedVersion';

/** 24-hour TTL between automatic checks. The user can force a check by
 *  passing { force: true } — used by the in-app "Check now" button. */
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

interface GithubAsset {
  name: string;
  browser_download_url: string;
  size?: number;
}

interface GithubRelease {
  tag_name: string;
  name?: string;
  html_url: string;
  assets: GithubAsset[];
  prerelease?: boolean;
  draft?: boolean;
}

export interface UpdateInfo {
  latestVersion: string;
  currentVersion: string;
  releasePageUrl: string;
  /** Direct download for the user's arch, or null if no matching DMG exists.
   *  When null the banner falls back to the release page URL. */
  assetUrl: string | null;
  assetName: string | null;
  publishedTagName: string;
}

/** Strip the leading "v" from "v0.1.5" → "0.1.5". Anything else returned as-is. */
function normalizeVersion(tag: string): string {
  return tag.startsWith('v') ? tag.slice(1) : tag;
}

/** Lexicographic semver compare (major.minor.patch only). Returns
 *  > 0 if `a > b`, < 0 if `a < b`, 0 if equal. Treats missing parts as 0,
 *  so "0.1" == "0.1.0". Doesn't handle pre-release suffixes — we don't
 *  publish those. */
export function compareVersions(a: string, b: string): number {
  const pa = normalizeVersion(a).split('.').map((s) => parseInt(s, 10) || 0);
  const pb = normalizeVersion(b).split('.').map((s) => parseInt(s, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const av = pa[i] ?? 0;
    const bv = pb[i] ?? 0;
    if (av !== bv) return av - bv;
  }
  return 0;
}

/** Pick the .dmg asset matching the user's arch. Asset names follow the
 *  pattern `AudioVisualizer-x.y.z-{arch}.dmg`. Returns null if no match. */
function pickAsset(assets: GithubAsset[], arch: string): GithubAsset | null {
  const archToken = arch === 'arm64' ? 'arm64' : 'x64';
  // Prefer the arch-tagged DMG; fall back to any DMG if the naming convention
  // changed in a future release.
  const archMatch = assets.find(
    (a) => a.name.endsWith('.dmg') && a.name.includes(archToken),
  );
  if (archMatch) return archMatch;
  return assets.find((a) => a.name.endsWith('.dmg')) ?? null;
}

interface CheckOptions {
  /** Skip the 24-hour cache and re-fetch immediately. */
  force?: boolean;
}

/** Check GitHub for a release newer than the running app's version. Returns
 *  null when no newer release exists, the latest is dismissed by the user,
 *  or the cache says it's too soon to check again (and `force` is false). */
export async function checkForUpdate(opts: CheckOptions = {}): Promise<UpdateInfo | null> {
  const currentVersion = normalizeVersion(window.api.app.version);

  // Cache gate — skip the network call entirely if we checked recently.
  if (!opts.force) {
    const last = parseInt(localStorage.getItem(LAST_CHECK_KEY) ?? '0', 10) || 0;
    if (Date.now() - last < CHECK_INTERVAL_MS) return null;
  }
  localStorage.setItem(LAST_CHECK_KEY, String(Date.now()));

  let release: GithubRelease;
  try {
    const res = await fetch(RELEASES_API, {
      headers: { Accept: 'application/vnd.github+json' },
    });
    if (!res.ok) {
      // 404 = no releases yet; 403 = rate-limited. Either way, silently bail —
      // an update banner is a nice-to-have, not a feature we should alert about.
      return null;
    }
    release = (await res.json()) as GithubRelease;
  } catch {
    return null;
  }

  if (release.draft || release.prerelease) return null;

  const latestVersion = normalizeVersion(release.tag_name);
  if (compareVersions(latestVersion, currentVersion) <= 0) return null;

  // User dismissed this exact version — keep silent until a newer one drops.
  const dismissed = localStorage.getItem(DISMISSED_VERSION_KEY);
  if (dismissed && normalizeVersion(dismissed) === latestVersion) return null;

  const asset = pickAsset(release.assets ?? [], window.api.app.arch);

  return {
    latestVersion,
    currentVersion,
    releasePageUrl: release.html_url,
    assetUrl: asset?.browser_download_url ?? null,
    assetName: asset?.name ?? null,
    publishedTagName: release.tag_name,
  };
}

/** Dismiss the current "update available" notice. The banner stays gone
 *  until a release newer than `version` is published. */
export function dismissUpdate(version: string): void {
  localStorage.setItem(DISMISSED_VERSION_KEY, normalizeVersion(version));
}

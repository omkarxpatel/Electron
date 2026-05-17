/**
 * lrclib.net API client.
 *
 * lrclib is a free public lyrics database, no auth needed. Each match returns
 * both `plainLyrics` (unformatted full text) and optional `syncedLyrics` (in
 * LRC format — `[mm:ss.xx] line of text`).
 *
 * We use the `/search` endpoint (forgiving fuzzy match) and pick the result
 * whose duration is closest to the actual track length when available, which
 * effectively disambiguates between covers / live versions / remastered etc.
 *
 * Docs: https://lrclib.net/docs
 */

export interface LrclibResult {
  id: number;
  trackName: string;
  artistName: string;
  albumName: string;
  /** Track duration in seconds. */
  duration: number;
  instrumental: boolean;
  /** Plain-text lyrics, may be null. */
  plainLyrics: string | null;
  /** LRC-formatted synced lyrics, may be null. */
  syncedLyrics: string | null;
}

const BASE = 'https://lrclib.net/api';
/** Hard timeout per HTTP request — if lrclib hangs we want the UI to fall
 *  back to "not found" rather than the user staring at "Looking up…" forever. */
/** lrclib's API is frequently 8–15 seconds slow under load. We give it
 *  generous headroom because its synced-lyrics data is worth waiting for,
 *  but we don't BLOCK the UI on it — the parallel fast path (lyrics.ovh,
 *  plain text) shows progress within ~1 s and lrclib upgrades when ready. */
const REQUEST_TIMEOUT_MS = 25000;

/**
 * Fetch lyrics by racing /get (exact) and /search (fuzzy) in parallel.
 *
 *   • /get — O(1) lookup by track + artist + album + (rounded) duration.
 *     Typically 100–300 ms when the song is in lrclib's index, fast 404 otherwise.
 *   • /search — fuzzy ranking. Typically 300–1500 ms.
 *
 * Whichever returns a non-null result first wins. This means a hit on /get
 * gives near-instant lyrics, while a /get miss doesn't waste the time we
 * already spent waiting — /search has been running in parallel and answers
 * within its own latency window. Net worst case ≈ search latency; best case
 * ≈ get latency. Old behaviour (sequential) added the two together.
 */
export async function fetchLyrics(
  title: string,
  artist: string,
  album?: string,
  durationSec?: number,
  signal?: AbortSignal,
): Promise<LrclibResult | null> {
  const canExact =
    !!album && durationSec != null && Number.isFinite(durationSec);
  if (!canExact) {
    return await searchLrclib(title, artist, durationSec, signal);
  }
  return await new Promise<LrclibResult | null>((resolve) => {
    let resolved = false;
    let pending = 2;
    const finish = (r: LrclibResult | null) => {
      if (resolved) return;
      if (r) {
        resolved = true;
        resolve(r);
      } else if (--pending === 0) {
        resolved = true;
        resolve(null);
      }
    };
    getLrclibExact(title, artist, album!, durationSec!, signal)
      .then(finish)
      .catch(() => finish(null));
    searchLrclib(title, artist, durationSec, signal)
      .then(finish)
      .catch(() => finish(null));
  });
}

async function getLrclibExact(
  title: string,
  artist: string,
  album: string,
  durationSec: number,
  signal?: AbortSignal,
): Promise<LrclibResult | null> {
  const params = new URLSearchParams({
    track_name: title,
    artist_name: artist,
    album_name: album,
    duration: String(Math.round(durationSec)),
  });
  const url = `${BASE}/get?${params}`;
  try {
    const res = await fetchWithTimeout(url, signal);
    if (!res.ok) return null;
    return (await res.json()) as LrclibResult;
  } catch {
    return null;
  }
}

export async function searchLrclib(
  title: string,
  artist: string,
  durationSec?: number,
  signal?: AbortSignal,
): Promise<LrclibResult | null> {
  const params = new URLSearchParams({
    track_name: title,
    artist_name: artist,
  });
  const url = `${BASE}/search?${params}`;
  let json: LrclibResult[];
  try {
    const res = await fetchWithTimeout(url, signal);
    if (!res.ok) return null;
    json = (await res.json()) as LrclibResult[];
  } catch {
    return null;
  }
  if (!Array.isArray(json) || json.length === 0) return null;

  // Pick the result with the closest duration to ours when we know it; this
  // disambiguates between studio / live / remix versions that share a title.
  if (durationSec != null && Number.isFinite(durationSec)) {
    let best = json[0];
    let bestDelta = Math.abs((best.duration ?? 0) - durationSec);
    for (let i = 1; i < json.length; i++) {
      const r = json[i];
      const d = Math.abs((r.duration ?? 0) - durationSec);
      if (d < bestDelta) {
        best = r;
        bestDelta = d;
      }
    }
    return best;
  }
  return json[0];
}

async function fetchWithTimeout(url: string, externalSignal?: AbortSignal): Promise<Response> {
  // No custom headers: any non-standard header would trigger a CORS preflight,
  // and lrclib's CORS config doesn't whitelist arbitrary client headers, so
  // the preflight would fail and the whole request would error out. Keeping
  // this as a plain GET makes it a CORS "simple request" — no preflight.
  const ctrl = new AbortController();
  const timer = window.setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  const onExternalAbort = () => ctrl.abort();
  externalSignal?.addEventListener('abort', onExternalAbort);
  try {
    return await fetch(url, { signal: ctrl.signal });
  } finally {
    window.clearTimeout(timer);
    externalSignal?.removeEventListener('abort', onExternalAbort);
  }
}

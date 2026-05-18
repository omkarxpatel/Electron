import { useEffect, useRef, useState } from 'react';
import { fetchLyrics } from './lrclib';
import { fetchOvhLyrics } from './ovh';
import { parseLrc, type LyricLine } from './parseLrc';

export interface LyricsState {
  /** Time-stamped synced lyrics (lrclib). Empty when only plain is available. */
  lines: LyricLine[];
  /** Plain-text fallback. Filled fast by lyrics.ovh; later replaced by lrclib's
   *  plain if lrclib responds with richer text. */
  plain: string | null;
  loading: boolean;
  instrumental: boolean;
  /** True when at least one source returned lyrics. */
  found: boolean;
}

const INITIAL: LyricsState = {
  lines: [],
  plain: null,
  loading: false,
  instrumental: false,
  found: false,
};

/** LRU cap. The cache is module-scope and grows as the user plays new tracks.
 *  Without a cap, a long session that scrobbles through hundreds of unique
 *  tracks accumulates megabytes of lyric text. 50 keeps recent tracks fast
 *  while bounding the worst case. Map preserves insertion order; we evict
 *  the oldest entry when adding a new one past the cap. Re-inserting an
 *  existing key moves it to the end (most-recent slot). */
const LYRICS_CACHE_MAX = 50;
const cache = new Map<string, LyricsState>();

function cacheSet(key: string, value: LyricsState): void {
  // Re-insertion: delete first so we move the key to the end of insertion order.
  if (cache.has(key)) cache.delete(key);
  cache.set(key, value);
  while (cache.size > LYRICS_CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

function cacheGet(key: string): LyricsState | undefined {
  const hit = cache.get(key);
  if (hit) {
    // Touch on read — move to the end so heavily-replayed tracks survive.
    cache.delete(key);
    cache.set(key, hit);
  }
  return hit;
}

/** In-flight progressive loads, deduped per key. Subscribers all see the
 *  same series of updates via the `subscribers` set inside each entry. */
const inFlight = new Map<string, InFlightEntry>();

interface InFlightEntry {
  current: LyricsState;
  subscribers: Set<(s: LyricsState) => void>;
}

function makeKey(title: string, artist: string): string {
  return `${title.trim().toLowerCase()}::${artist.trim().toLowerCase()}`;
}

/**
 * Fetches lyrics with a two-tier strategy:
 *
 *   1. lyrics.ovh (plain text, ~700 ms) — fires first; if it returns a hit,
 *      LyricsPane shows plain text within a second while we wait for synced.
 *   2. lrclib.net (synced + plain, ~8–15 s) — runs in parallel; when it
 *      finishes, state is "upgraded" to the synced view with highlighted
 *      current line.
 *
 * If neither returns anything, state is `found: false`. Failures are NOT
 * cached so they can be retried on the next visit.
 */
export function useLyrics(
  title: string | null | undefined,
  artist: string | null | undefined,
  album?: string,
  durationMs?: number,
): LyricsState {
  const [state, setState] = useState<LyricsState>(INITIAL);
  const reqIdRef = useRef(0);

  useEffect(() => {
    if (!title || !artist) {
      setState(INITIAL);
      return;
    }
    const key = makeKey(title, artist);
    const cached = cacheGet(key);
    if (cached) {
      setState(cached);
      return;
    }
    const reqId = ++reqIdRef.current;

    // Subscribe to progressive updates from the shared in-flight load. The
    // load handles fetching from both sources; we just mirror its state.
    const onUpdate = (next: LyricsState) => {
      if (reqIdRef.current !== reqId) return;
      setState(next);
    };

    const entry = startProgressiveLoad(key, title, artist, album, durationMs);
    entry.subscribers.add(onUpdate);
    onUpdate(entry.current);

    return () => {
      entry.subscribers.delete(onUpdate);
    };
  }, [title, artist, album, durationMs]);

  return state;
}

/** Fire-and-forget prefetch. Lyrics for the requested track land in cache by
 *  the time the user advances, so the LyricsPane render is instant. */
export function prefetchLyrics(
  title: string,
  artist: string,
  album?: string,
  durationMs?: number,
): void {
  if (!title || !artist) return;
  const key = makeKey(title, artist);
  if (cache.has(key) || inFlight.has(key)) return;
  startProgressiveLoad(key, title, artist, album, durationMs);
}

function startProgressiveLoad(
  key: string,
  title: string,
  artist: string,
  album?: string,
  durationMs?: number,
): InFlightEntry {
  const existing = inFlight.get(key);
  if (existing) return existing;

  const entry: InFlightEntry = {
    current: { ...INITIAL, loading: true },
    subscribers: new Set(),
  };
  inFlight.set(key, entry);

  const broadcast = (next: LyricsState) => {
    entry.current = next;
    entry.subscribers.forEach((fn) => fn(next));
  };

  let plainGotten = false;
  let syncedSettled = false;

  // Fast lane: plain text from lyrics.ovh. We display this as soon as we
  // have it (loading stays true until synced settles).
  fetchOvhLyrics(title, artist).then((plain) => {
    if (syncedSettled) return; // synced already won; ignore.
    if (plain) {
      plainGotten = true;
      broadcast({
        lines: [],
        plain,
        loading: true, // still waiting on lrclib for the synced upgrade
        instrumental: false,
        found: true,
      });
    }
  });

  // Slow lane: synced lyrics from lrclib. This is the authoritative final
  // result — it has plain text too (which is usually identical to ovh's).
  const durationSec = durationMs != null ? durationMs / 1000 : undefined;
  fetchLyrics(title, artist, album, durationSec)
    .then((res) => {
      syncedSettled = true;
      if (res) {
        const lines = res.syncedLyrics ? parseLrc(res.syncedLyrics) : [];
        const final: LyricsState = {
          lines,
          plain: res.plainLyrics ?? entry.current.plain ?? null,
          loading: false,
          instrumental: res.instrumental,
          found: true,
        };
        cacheSet(key, final);
        broadcast(final);
      } else if (plainGotten) {
        // Synced source failed but plain was found — finalize as plain-only.
        const final: LyricsState = { ...entry.current, loading: false };
        cacheSet(key, final);
        broadcast(final);
      } else {
        // Both sources empty: report not-found WITHOUT caching, so a later
        // visit can retry (lrclib's flakiness can mean today's miss is
        // tomorrow's hit).
        broadcast({ ...INITIAL, found: false });
      }
    })
    .catch(() => {
      syncedSettled = true;
      if (plainGotten) {
        const final: LyricsState = { ...entry.current, loading: false };
        cacheSet(key, final);
        broadcast(final);
      } else {
        broadcast({ ...INITIAL, found: false });
      }
    })
    .finally(() => {
      // Remove from in-flight either way so a future prefetch can re-run if
      // the cache miss persists.
      inFlight.delete(key);
    });

  return entry;
}

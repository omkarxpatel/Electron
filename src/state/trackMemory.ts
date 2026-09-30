import { useCallback, useRef, useState } from 'react';
import {
  decodeStore,
  encodeStore,
  evictOldest,
  foldMeasurement,
  MIN_COMMIT_SECONDS,
  type TrackProfile,
} from '../audio/trackProfile';

/**
 * What the app has learned about each track it has played, keyed by Spotify
 * track id. See `src/audio/trackProfile.ts` for why this exists and what is
 * stored; this module is only persistence.
 */

const STORAGE_KEY = 'av.trackMemory.v1';

/**
 * Entries kept, least-recently-heard evicted.
 *
 * At the measured ~100 bytes per track (check:enhancer asserts the budget)
 * this is roughly 100 KB — a couple of percent of the localStorage budget,
 * and more distinct tracks than a listening rotation reaches. The cap exists
 * so the store has a known ceiling rather than growing with play history
 * forever.
 */
export const MAX_TRACKS = 1000;

function load(): Record<string, TrackProfile> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    return decodeStore(raw);
  } catch {
    return {};
  }
}

export interface TrackMemoryStats {
  /** Tracks currently remembered. */
  tracks: number;
  /** Bytes the store actually occupies, not an estimate. */
  bytes: number;
}

export function useTrackMemory(enabled: boolean) {
  // The store is read on every track change and written at most once per
  // track, so it never needs to drive a render. A ref keeps it out of the
  // render path; `stats` exists only so Settings can show the real cost.
  const storeRef = useRef<Record<string, TrackProfile> | null>(null);
  if (storeRef.current === null) storeRef.current = load();
  const [stats, setStats] = useState<TrackMemoryStats>(() => measure(storeRef.current ?? {}));

  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  const recall = useCallback((trackId: string | null): TrackProfile | null => {
    if (!enabledRef.current || !trackId) return null;
    return storeRef.current?.[trackId] ?? null;
  }, []);

  /**
   * Fold a finished measurement in and persist. Called once per track, on
   * the change away from it.
   */
  const commit = useCallback(
    (trackId: string, bands10: number[], seconds: number, lufs: number | null): void => {
    if (!enabledRef.current) return;
    // A skipped track measures its intro, not the track. Storing that would
    // poison every later recall, and recall is the whole point.
    if (seconds < MIN_COMMIT_SECONDS) return;
    const store = storeRef.current;
    if (!store) return;
    store[trackId] = foldMeasurement(store[trackId] ?? null, bands10, seconds, Date.now(), lufs);
    const kept = evictOldest(store, MAX_TRACKS);
    storeRef.current = kept;
    const serialized = encodeStore(kept);
    try {
      localStorage.setItem(STORAGE_KEY, serialized);
    } catch {
      // Quota, private mode, or a disk error. Losing the memory degrades the
      // enhancer back to measuring from scratch, which is how it worked
      // before this existed — not worth interrupting playback over.
    }
    setStats({ tracks: Object.keys(kept).length, bytes: serialized.length });
    },
    [],
  );

  const clear = useCallback((): void => {
    storeRef.current = {};
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // Same as above.
    }
    setStats({ tracks: 0, bytes: 0 });
  }, []);

  return { recall, commit, clear, stats };
}

function measure(store: Record<string, TrackProfile>): TrackMemoryStats {
  const tracks = Object.keys(store).length;
  return { tracks, bytes: tracks === 0 ? 0 : encodeStore(store).length };
}

export type UseTrackMemoryReturn = ReturnType<typeof useTrackMemory>;

import { useCallback, useRef, useState } from 'react';
import {
  decodeStore,
  encodeStore,
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
 * No cap on entries. There was one, at 1000, evicting the least recently
 * heard; but the DJ is meant to learn whole libraries, and a cap made it
 * forget the first playlist it was given while it learned the second.
 *
 * Measured, not assumed: Electron's localStorage accepted a 40 million
 * character value in a fresh profile, and an entry is ~141 characters, so the
 * quota sits somewhere past 250,000 tracks. The cost that does grow is that
 * the whole store is re-serialised on every track change and parsed at
 * startup, which is why check:enhancer still asserts the size of an entry.
 */

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
    (
      trackId: string,
      bands10: number[],
      seconds: number,
      lufs: number | null,
      key: number | null,
      keyConfidence: number,
      bpm: number | null,
      bpmConfidence: number,
    ): void => {
    if (!enabledRef.current) return;
    // A skipped track measures its intro, not the track. Storing that would
    // poison every later recall, and recall is the whole point.
    if (seconds < MIN_COMMIT_SECONDS) return;
    const store = storeRef.current;
    if (!store) return;
    store[trackId] = foldMeasurement(
      store[trackId] ?? null,
      bands10,
      seconds,
      Date.now(),
      lufs,
      key,
      keyConfidence,
      bpm,
      bpmConfidence,
    );
    const serialized = encodeStore(store);
    try {
      localStorage.setItem(STORAGE_KEY, serialized);
    } catch {
      // Quota, private mode, or a disk error. Losing the memory degrades the
      // enhancer back to measuring from scratch, which is how it worked
      // before this existed — not worth interrupting playback over.
    }
    setStats({ tracks: Object.keys(store).length, bytes: serialized.length });
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

/**
 * The candidate pool: everything in a playlist or a folder that the app has
 * actually heard, ranked against what is playing.
 *
 * The cold start is the whole shape of this feature. Nothing is known about a
 * track until it has played through once — `MIN_COMMIT_SECONDS` of it, to be
 * exact — so a freshly opened playlist has no candidates at all and a
 * well-worn one has most of them. That is not a defect to paper over, it is
 * the deal: Spotify stopped handing out `audio-features` in November 2024 and
 * the only way back to that data is to listen. So coverage is counted and
 * reported rather than hidden, because "38 of 52 analysed" is a true and
 * useful thing to say, and silently ranking 38 tracks as though they were 52
 * would just look like bad taste.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { getPlaylistTracks } from '../spotify/api';
import type { SpotifyPlaylist, SpotifyPlaylistTrackItem, SpotifyTrack } from '../spotify/types';
import type { PlaylistFolder } from '../state/playlistFolders';
import type { TrackProfile } from '../audio/trackProfile';
import { rankTransitions, type MixCandidate, type MixScore } from '../audio/mixCompatibility';
import { applyIntent, parseIntent, type Intent } from './intent';

/** Where candidates come from. A folder is the better unit for a set — it is
 *  why the v1.4.13 folder work matters here — but a single playlist is the
 *  thing most people will reach for first. */
export type DjSource =
  | { kind: 'playlist'; playlist: SpotifyPlaylist }
  | { kind: 'folder'; folder: PlaylistFolder; playlists: SpotifyPlaylist[] };

/** Stable identity for a source, so an in-flight scan can be abandoned when
 *  the user switches away. Mirrors `sourceKey` in useSpotify, for the same
 *  reason: comparing object identity would refetch on every render. */
export function djSourceKey(source: DjSource | null): string | null {
  if (!source) return null;
  return source.kind === 'playlist'
    ? `playlist:${source.playlist.id}`
    : `folder:${source.folder.id}:${source.playlists.map((p) => p.id).join(',')}`;
}

export interface DjCoverage {
  /** Playable tracks found in the source. */
  total: number;
  /** Of those, how many have been heard at all. */
  heard: number;
  /** Of those, how many have both a key and a tempo — the two that decide a
   *  transition. A track heard briefly may have a shape and nothing else. */
  measured: number;
}

export interface DjPick {
  track: SpotifyTrack;
  profile: TrackProfile;
  result: MixScore;
  /** Score after the chat request is applied. What the list is sorted by. */
  score: number;
}

export type DjState =
  | { kind: 'idle'; reason: 'no-source' | 'nothing-playing' | 'unheard-track' }
  | { kind: 'scanning'; found: number }
  | { kind: 'ready'; picks: DjPick[]; coverage: DjCoverage; intent: Intent }
  | { kind: 'error'; message: string };

/** Page size Spotify accepts for playlist items. */
const PAGE = 100;

/**
 * Most tracks scanned from one source.
 *
 * A cap rather than a full walk because a folder can hold thousands and each
 * page is a request; past a few hundred the ranking does not get better, it
 * just takes longer and burns rate limit. The panel says when it stopped
 * short rather than quietly truncating.
 */
const MAX_SCAN = 600;

/**
 * Post-Feb-2026 client IDs return playlist entries under `item`; older ones
 * under `track`. Reading `.track` directly works until the day it doesn't.
 */
function entryTrack(entry: SpotifyPlaylistTrackItem): SpotifyTrack | null {
  return entry.item ?? entry.track ?? null;
}

async function scanPlaylist(
  playlistId: string,
  budget: number,
  onProgress: (n: number) => void,
  cancelled: () => boolean,
): Promise<SpotifyTrack[]> {
  const out: SpotifyTrack[] = [];
  let offset = 0;
  for (;;) {
    if (cancelled() || out.length >= budget) break;
    const page = await getPlaylistTracks(playlistId, PAGE, offset);
    const items = page.items ?? [];
    for (const entry of items) {
      const track = entryTrack(entry);
      // Local files have no Spotify id, so nothing could ever have been
      // stored against them.
      if (track && track.id && !entry.is_local) out.push(track);
    }
    onProgress(out.length);
    offset += PAGE;
    if (items.length < PAGE || offset >= (page.total ?? 0)) break;
  }
  return out;
}

/**
 * Rank a source against what is playing.
 *
 * `from` is assembled by the caller rather than recalled here, because the
 * playing track's best measurement is the LIVE one — the enhancer is
 * measuring it right now — and the stored profile is only the fallback for
 * when AI Enhance is off.
 */
export function useDjSuggestions(options: {
  enabled: boolean;
  source: DjSource | null;
  from: MixCandidate | null;
  currentTrackId: string | null;
  recall: (trackId: string | null) => TrackProfile | null;
  /** Free text from the chat box. Biases the ranking; never filters it. */
  request: string;
}): DjState {
  const { enabled, source, from, currentTrackId, recall, request } = options;
  const key = djSourceKey(source);

  const [pool, setPool] = useState<{ key: string; tracks: SpotifyTrack[] } | null>(null);
  const [scanning, setScanning] = useState<{ key: string; found: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  // `recall` is stable in practice but is not a dependency of the scan — the
  // pool is a list of tracks, and what is known about them is applied below.
  const recallRef = useRef(recall);
  recallRef.current = recall;

  useEffect(() => {
    if (!enabled || !source || !key) return;
    if (pool?.key === key) return;
    let cancelled = false;
    setError(null);
    setScanning({ key, found: 0 });
    const playlists =
      source.kind === 'playlist' ? [source.playlist] : source.playlists;

    (async () => {
      const tracks: SpotifyTrack[] = [];
      const seen = new Set<string>();
      for (const playlist of playlists) {
        if (cancelled || tracks.length >= MAX_SCAN) break;
        const found = await scanPlaylist(
          playlist.id,
          MAX_SCAN - tracks.length,
          (n) => {
            if (!cancelled) setScanning({ key, found: tracks.length + n });
          },
          () => cancelled,
        );
        for (const track of found) {
          // A folder can hold the same track in two playlists, and a
          // duplicated row would be a duplicated React key as well as a
          // duplicated suggestion.
          if (seen.has(track.id)) continue;
          seen.add(track.id);
          tracks.push(track);
        }
      }
      if (cancelled) return;
      setPool({ key, tracks });
      setScanning(null);
    })().catch((err) => {
      if (cancelled) return;
      console.error('DJ pool scan failed:', err);
      setError(String((err as Error)?.message ?? err));
      setScanning(null);
    });

    return () => {
      cancelled = true;
    };
  }, [enabled, source, key, pool?.key]);

  const intent = useMemo(() => parseIntent(request), [request]);

  return useMemo<DjState>(() => {
    if (error) return { kind: 'error', message: error };
    if (!enabled || !source) return { kind: 'idle', reason: 'no-source' };
    if (scanning && scanning.key === key) return { kind: 'scanning', found: scanning.found };
    if (!pool || pool.key !== key) return { kind: 'scanning', found: 0 };
    if (!currentTrackId) return { kind: 'idle', reason: 'nothing-playing' };
    if (!from) return { kind: 'idle', reason: 'unheard-track' };

    const coverage: DjCoverage = { total: 0, heard: 0, measured: 0 };
    const candidates: Array<{ id: string; track: SpotifyTrack; profile: TrackProfile }> = [];
    for (const track of pool.tracks) {
      coverage.total++;
      // A track relinked for this market carries a different id from the one
      // it was played under, so both have to be tried or every relinked
      // track reads as unheard.
      const profile =
        recallRef.current(track.id) ?? recallRef.current(track.linked_from?.id ?? null);
      if (!profile) continue;
      coverage.heard++;
      if (profile.key !== null && profile.bpm !== null) coverage.measured++;
      // Never suggest what is already playing.
      if (track.id === currentTrackId || track.linked_from?.id === currentTrackId) continue;
      candidates.push({ id: track.id, track, profile });
    }

    const ranked = rankTransitions(
      from,
      candidates.map((c) => ({ ...c, profile: c.profile as MixCandidate })),
    );
    const picks: DjPick[] = ranked.map(({ item, result }) => ({
      track: (item as unknown as { track: SpotifyTrack }).track,
      profile: (item as unknown as { profile: TrackProfile }).profile,
      result,
      score: applyIntent(result, intent).score,
    }));
    // The request reorders; it does not re-rank from scratch, so sort again
    // on the adjusted score with the same id tiebreak for stability.
    picks.sort((a, b) =>
      b.score !== a.score ? b.score - a.score : a.track.id < b.track.id ? -1 : 1,
    );

    return { kind: 'ready', picks, coverage, intent };
  }, [enabled, source, key, pool, scanning, currentTrackId, from, intent, error]);
}

/** Whether the scan stopped at the cap rather than at the end of the source. */
export function hitScanCap(coverage: DjCoverage): boolean {
  return coverage.total >= MAX_SCAN;
}

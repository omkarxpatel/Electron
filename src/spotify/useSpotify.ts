import { useCallback, useEffect, useRef, useState } from 'react';
import * as api from './api';
import { authorize, isAuthenticated, disconnect } from './auth';
import {
  getClientId,
  setClientId,
  clearClientId,
  getLastPlaylistId,
  setLastPlaylistId,
  clearLastPlaylistId,
} from './storage';
import { useVisibility } from '../hooks/useVisibility';
import type {
  SpotifyDevice,
  SpotifyPlaybackState,
  SpotifyPlaylist,
  SpotifyPlaylistTrackItem,
  SpotifyTrack,
} from './types';

/** Feb 2026 renamed a playlist entry's `track` key to `item`. Grandfathered
 *  client IDs send both, newer ones only `item`. Null entries are real —
 *  removed or local-only tracks — so callers still have to drop them. */
function entryTrack(it: SpotifyPlaylistTrackItem): SpotifyTrack | null {
  return it.item ?? it.track ?? null;
}

/**
 * What the main track list is showing. A union rather than a nullable
 * playlist because Liked Songs is a real source with no playlist object
 * behind it — no id, no owner, no snapshot_id — and modelling it as a
 * synthetic playlist would put a sentinel id through every comparison in
 * this file.
 */
export type TrackSource =
  | { kind: 'playlist'; playlist: SpotifyPlaylist }
  | { kind: 'liked' };

/** Stable key for the selected source, used to abandon an in-flight fetch
 *  when the user switches away mid-request. */
export function sourceKey(source: TrackSource | null): string | null {
  if (!source) return null;
  return source.kind === 'liked' ? 'liked' : source.playlist.id;
}

/** Identity for the three `actions.disallows` flags the transport buttons
 *  read. The poll diff compares primitives, and a nested object would always
 *  look changed by reference — so flatten the only part that matters. */
function disallowKey(p: SpotifyPlaybackState): string {
  const d = p.actions?.disallows;
  return `${d?.toggling_shuffle ?? false}|${d?.toggling_repeat_context ?? false}|${d?.toggling_repeat_track ?? false}`;
}

/**
 * One page from whichever source is selected, normalised so the paging logic
 * above doesn't branch.
 *
 * `fetchedThrough` is the raw position to resume from — deliberately not the
 * filtered length. Null entries (removed or local-only tracks) are dropped
 * from `tracks`, so counting those would walk the offset backwards a little
 * more with every page and silently skip songs.
 */
async function fetchSourcePage(
  source: TrackSource,
  offset: number,
): Promise<{ tracks: SpotifyTrack[]; total: number; fetchedThrough: number }> {
  if (source.kind === 'liked') {
    // 50, not 100: /me/tracks caps `limit` lower than the playlist reader.
    const res = await api.getSavedTracks(api.SAVED_TRACKS_PAGE, offset);
    if (!res) throw new Error('Empty saved-tracks response');
    return {
      tracks: res.items.flatMap((it) => it.track ?? []),
      total: res.total,
      fetchedThrough: (res.offset ?? offset) + res.items.length,
    };
  }
  const res = await api.getPlaylistTracks(source.playlist.id, 100, offset);
  return {
    tracks: res.items.flatMap((it) => entryTrack(it) ?? []),
    total: res.total,
    fetchedThrough: (res.offset ?? offset) + res.items.length,
  };
}

export interface SpotifyState {
  clientId: string | null;
  authed: boolean;
  authError: string | null;
  authing: boolean;

  playlists: SpotifyPlaylist[];
  playlistsLoading: boolean;

  /** Null until the user picks something. */
  source: TrackSource | null;
  tracks: SpotifyTrack[];
  tracksLoading: boolean;
  /** Total tracks in the selected playlist (for pagination state). */
  tracksTotal: number;
  /** Next playlist-position to fetch; null = all tracks loaded.
   *  Note: this is the original playlist position, NOT a count of items
   *  already loaded — filtering nulls would otherwise drift these. */
  tracksNextOffset: number | null;

  playback: SpotifyPlaybackState | null;
  /** Whether the currently playing track is in the user's Liked Songs.
   *  null = unknown / not yet checked. */
  savedCurrent: boolean | null;
  /** Signed-in user's Spotify id. Needed to tell a playlist we may edit from
   *  one we may only read — Spotify's 403 for "not your playlist" is
   *  indistinguishable from the one for "missing scope", so the check has to
   *  happen before the request. null until /me answers. */
  userId: string | null;
}

const POLL_INTERVAL_ACTIVE = 1500;   // ms — window visible
const POLL_INTERVAL_HIDDEN = 10000;  // ms — window hidden, ramp down to save battery + quota
const POLL_BACKOFF_MAX = 30000;      // ms — 429/503 backoff cap
/** Playlist edits are rare compared to playback changes, and the check costs
 *  a request each time, so this polls far slower than the playback loop. */
const PLAYLIST_REFRESH_ACTIVE_MS = 60000;
const PLAYLIST_REFRESH_HIDDEN_MS = 300000;
/** How long to wait for a just-launched Spotify to register itself with
 *  Connect, and how often to look. A cold start is usually 4-6s. */
const SPOTIFY_WAKE_TIMEOUT_MS = 15000;
const SPOTIFY_WAKE_POLL_MS = 1000;

/** Prefer a device that's already active, then any unrestricted one. A
 *  restricted device (another app's Connect session) accepts no commands. */
function pickDevice(devices: SpotifyDevice[]): SpotifyDevice | undefined {
  return (
    devices.find((d) => d.is_active && !d.is_restricted) ??
    devices.find((d) => !d.is_restricted) ??
    devices[0]
  );
}

export function useSpotify() {
  // When the window is hidden, ramp the poll interval up so we stop burning
  // API quota + battery on a tab the user isn't looking at. Audio keeps
  // playing — only the polling slows down.
  const isActive = useVisibility(2500);

  const [state, setState] = useState<SpotifyState>(() => ({
    clientId: getClientId(),
    authed: isAuthenticated(),
    authError: null,
    authing: false,
    playlists: [],
    playlistsLoading: false,
    source: null,
    tracks: [],
    tracksLoading: false,
    tracksTotal: 0,
    tracksNextOffset: null,
    playback: null,
    savedCurrent: null,
    userId: null,
  }));

  const stateRef = useRef(state);
  stateRef.current = state;

  // Shuffle/repeat poll lock-out. After the user toggles, Spotify takes
  // a poll cycle or two to propagate the new value. Without this guard, the
  // next poll fetches stale state and the UI flickers OFF→ON→OFF. While the
  // lock is held, polled state for that field is overridden by the
  // optimistic value.
  const shuffleLockUntilRef = useRef<number>(0);
  const shuffleOverrideRef = useRef<boolean | null>(null);
  const repeatLockUntilRef = useRef<number>(0);
  const repeatOverrideRef = useRef<'off' | 'track' | 'context' | null>(null);
  // Spotify can take 3–4 seconds to propagate transport changes through
  // Connect; the lock has to outlast that window or the next poll snaps
  // the UI back. 4s tested against a typical post-idle device.
  const TOGGLE_LOCK_MS = 4000;

  /**
   * Start Spotify hidden and wait for it to show up as a Connect device.
   *
   * Reached when there are no devices at all, which means Spotify isn't
   * running. Previously that dead-ended in "No Spotify device available" and
   * the user had to go open Spotify by hand — the one trip this app exists to
   * remove. The client comes up via `open -gj`, so it never takes the screen.
   *
   * Returns undefined if it never checks in; the caller reports that rather
   * than hanging on a device that isn't coming.
   */
  const wakeSpotify = useCallback(async (): Promise<SpotifyDevice | undefined> => {
    const res = await window.api.spotifyApp.launchHidden();
    if (!res.ok) {
      throw new Error(
        res.reason === 'not-installed'
          ? "Spotify isn't installed. This app controls the Spotify desktop client — it can't play audio itself."
          : 'Could not start Spotify.',
      );
    }
    const deadline = Date.now() + SPOTIFY_WAKE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, SPOTIFY_WAKE_POLL_MS));
      const target = pickDevice((await api.getDevices()).filter((d) => !!d.id));
      if (target?.id) return target;
    }
    return undefined;
  }, []);

  /** Run a player-mutation request; on 404 "no active device" find an
   *  active device and retry once with `?device_id=…`. Mirrors the
   *  recovery used by `playTrack`. */
  const withDeviceFallback = useCallback(
    async (fn: (deviceId?: string) => Promise<void>): Promise<void> => {
      try {
        await fn();
        return;
      } catch (err) {
        const msg = String(err);
        if (!(msg.includes('404') || msg.includes('NO_ACTIVE_DEVICE'))) throw err;
        let target = pickDevice((await api.getDevices()).filter((d) => !!d.id));
        // No devices at all means Spotify isn't running anywhere. Boot it.
        if (!target?.id) target = await wakeSpotify();
        if (!target?.id) throw new Error('No Spotify device available');
        await fn(target.id);
      }
    },
    [wakeSpotify],
  );

  /* ─── Client ID management ─── */

  const saveClientId = useCallback((id: string) => {
    setClientId(id);
    setState((s) => ({ ...s, clientId: id.trim(), authError: null }));
  }, []);

  /* ─── Auth ─── */

  const connect = useCallback(async () => {
    if (!getClientId()) {
      setState((s) => ({ ...s, authError: 'Set your Client ID first.' }));
      return;
    }
    setState((s) => ({ ...s, authing: true, authError: null }));
    try {
      await authorize();
      setState((s) => ({ ...s, authed: true, authing: false }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setState((s) => ({ ...s, authing: false, authError: message }));
    }
  }, []);

  const signOut = useCallback(() => {
    disconnect();
    clearLastPlaylistId();
    setState((s) => ({
      ...s,
      authed: false,
      playlists: [],
      tracks: [],
      source: null,
      playback: null,
      savedCurrent: null,
      userId: null,
    }));
  }, []);

  const resetClientId = useCallback(() => {
    disconnect();
    clearClientId();
    clearLastPlaylistId();
    setState((s) => ({
      ...s,
      clientId: null,
      authed: false,
      playlists: [],
      tracks: [],
      source: null,
      playback: null,
      savedCurrent: null,
      userId: null,
    }));
  }, []);

  /* ─── Data loading ─── */

  const loadPlaylists = useCallback(async () => {
    setState((s) => ({ ...s, playlistsLoading: true }));
    try {
      const res = await api.getPlaylists(50);
      setState((s) => ({ ...s, playlists: res.items, playlistsLoading: false }));
    } catch (err) {
      console.error('loadPlaylists failed:', err);
      setState((s) => ({ ...s, playlistsLoading: false }));
    }
  }, []);

  /** snapshot_id the currently-loaded `tracks` were fetched at, so the
   *  background refresh can tell "changed on Spotify" from "unchanged".
   *  Keyed by playlist id so a stale value can't be applied to a new
   *  selection. */
  const loadedSnapshotRef = useRef<{ playlistId: string; snapshotId: string | null } | null>(null);
  /** Previous `isActive`, so the refresh effect can distinguish "window came
   *  back to the foreground" from "re-ran for some other reason". */
  const wasActiveRef = useRef(isActive);

  /** Switch the track list to a source and load its first page. Shared by
   *  selectPlaylist and selectLikedSongs — only the bookkeeping before the
   *  call differs between them. */
  const openSource = useCallback(async (source: TrackSource) => {
    const key = sourceKey(source);
    setState((s) => ({
      ...s,
      source,
      tracks: [],
      tracksLoading: true,
      tracksTotal: 0,
      // 0, not null. `null` is the "fully paged in" sentinel, and setting it
      // here claimed the opposite of the truth: for the whole window between
      // opening a source and its first page landing, state read as an empty
      // list that was known-complete. Anything asking "is this track missing
      // from the playlist?" got yes for every track — which is exactly how the
      // Suggested badge came to appear on tracks that were sitting in the list.
      // 0 is the honest value: nothing fetched, next fetch starts at offset 0.
      tracksNextOffset: 0,
    }));
    try {
      const page = await fetchSourcePage(source, 0);
      setState((s) => {
        if (sourceKey(s.source) !== key) return s;
        return {
          ...s,
          tracks: page.tracks,
          tracksLoading: false,
          tracksTotal: page.total,
          tracksNextOffset: page.fetchedThrough < page.total ? page.fetchedThrough : null,
        };
      });
    } catch (err) {
      console.error('openSource failed:', err);
      setState((s) => (sourceKey(s.source) === key ? { ...s, tracksLoading: false } : s));
    }
  }, []);

  const selectPlaylist = useCallback(async (playlist: SpotifyPlaylist) => {
    setLastPlaylistId(playlist.id);
    loadedSnapshotRef.current = {
      playlistId: playlist.id,
      snapshotId: playlist.snapshot_id ?? null,
    };
    await openSource({ kind: 'playlist', playlist });
  }, [openSource]);

  /**
   * Show Liked Songs in the main track list.
   *
   * The last-playlist memory is cleared so a relaunch doesn't drop the user
   * back into a playlist they navigated away from.
   */
  const selectLikedSongs = useCallback(async () => {
    clearLastPlaylistId();
    loadedSnapshotRef.current = null;
    await openSource({ kind: 'liked' });
  }, [openSource]);

  const loadMoreTracks = useCallback(async () => {
    const s = stateRef.current;
    const source = s.source;
    if (!source || s.tracksNextOffset === null || s.tracksLoading) return;
    const key = sourceKey(source);
    const offset = s.tracksNextOffset;
    setState((cur) => ({ ...cur, tracksLoading: true }));
    try {
      const page = await fetchSourcePage(source, offset);
      setState((cur) => {
        // Skip if the user switched sources during the fetch.
        if (sourceKey(cur.source) !== key) return { ...cur, tracksLoading: false };
        return {
          ...cur,
          tracks: [...cur.tracks, ...page.tracks],
          tracksLoading: false,
          tracksTotal: page.total,
          tracksNextOffset: page.fetchedThrough < page.total ? page.fetchedThrough : null,
        };
      });
    } catch (err) {
      console.error('loadMoreTracks failed:', err);
      setState((cur) => ({ ...cur, tracksLoading: false }));
    }
  }, []);

  /**
   * Re-fetch the span of the selected source we already have, in place.
   *
   * Deliberately NOT `openSource` again: that blanks `tracks` first, which
   * flashes the list to a skeleton and throws away the user's scroll position
   * and however many pages they'd paged in. This replaces the array in one
   * shot instead, so a song added on another device just appears.
   *
   * Borrows `tracksLoading` rather than a private flag so `loadMoreTracks`
   * (which early-returns on it) can't interleave and duplicate a page. With
   * tracks already on screen that flag only renders the small "Loading more
   * tracks…" footer, not the empty-state skeleton.
   */
  const refreshSelectedTracks = useCallback(async () => {
    const s = stateRef.current;
    const source = s.source;
    if (!source || s.tracksLoading) return;
    const key = sourceKey(source);

    // How far we'd paged. `tracksNextOffset === null` means everything was
    // loaded, so re-cover it entirely — including anything appended since,
    // which is where Spotify puts newly added songs.
    const hadEverything = s.tracksNextOffset === null;
    let target = hadEverything ? Number.POSITIVE_INFINITY : s.tracksNextOffset ?? 0;

    setState((cur) => (sourceKey(cur.source) === key ? { ...cur, tracksLoading: true } : cur));

    const collected: SpotifyTrack[] = [];
    let offset = 0;
    let total = s.tracksTotal;
    try {
      do {
        const page = await fetchSourcePage(source, offset);
        // Bail if the user switched sources mid-refresh.
        if (sourceKey(stateRef.current.source) !== key) return;
        total = page.total;
        if (hadEverything) target = page.total;
        collected.push(...page.tracks);
        // A page that returns nothing would otherwise spin forever.
        if (page.fetchedThrough <= offset) break;
        offset = page.fetchedThrough;
      } while (offset < target && offset < total);

      setState((cur) => {
        if (sourceKey(cur.source) !== key) return cur;
        return {
          ...cur,
          tracks: collected,
          tracksLoading: false,
          tracksTotal: total,
          tracksNextOffset: offset < total ? offset : null,
        };
      });
    } catch (err) {
      console.error('refreshSelectedTracks failed:', err);
      setState((cur) => (sourceKey(cur.source) === key ? { ...cur, tracksLoading: false } : cur));
    }
  }, []);

  /* ─── Playlist editing ─── */

  /**
   * Add one track to any playlist the user can write to.
   *
   * Throws on failure rather than swallowing it. A write that silently
   * no-ops is the worst outcome here — the user's next move is to open
   * Spotify to check, which is the thing this menu exists to avoid.
   */
  const addTrackToPlaylist = useCallback(
    async (playlistId: string, track: SpotifyTrack): Promise<void> => {
      const snapshot = await api.addPlaylistItems(playlistId, [track.uri]);
      // Adding to the playlist that's on screen has to show up now, not at
      // the next 60s snapshot poll. Re-reading beats reasoning about where it
      // landed: `position` was omitted, so Spotify appended it, which may be
      // past the pages we hold — and refreshSelectedTracks already covers
      // both the fully-paged and partially-paged cases.
      if (sourceKey(stateRef.current.source) !== playlistId) return;
      // refreshSelectedTracks no-ops while a page load is in flight. Recording
      // the new snapshot anyway would also convince the background poll that
      // nothing had changed, leaving the added track invisible until some
      // later edit moved the snapshot again.
      if (stateRef.current.tracksLoading) return;
      await refreshSelectedTracks();
      if (sourceKey(stateRef.current.source) === playlistId) {
        loadedSnapshotRef.current = { playlistId, snapshotId: snapshot };
      }
    },
    [refreshSelectedTracks],
  );

  /**
   * Create a playlist and open it.
   *
   * The new playlist is prepended locally rather than re-fetching
   * /me/playlists: that list is ordered most-recently-touched first, so a
   * fresh one belongs at the top anyway, and re-paging 50 playlists to learn
   * that is a wasted round trip.
   */
  const createPlaylist = useCallback(
    async (name: string): Promise<void> => {
      const created = await api.createPlaylist(name.trim());
      if (!created) throw new Error('Spotify returned no playlist');
      setState((s) => ({ ...s, playlists: [created, ...s.playlists] }));
      await selectPlaylist(created);
    },
    [selectPlaylist],
  );

  /** Rename / re-describe a playlist, patching the local copies so the
   *  sidebar and the header don't wait on the next library load. */
  const renamePlaylist = useCallback(
    async (playlistId: string, name: string, description?: string): Promise<void> => {
      const trimmed = name.trim();
      if (!trimmed) throw new Error('A playlist needs a name');
      await api.changePlaylistDetails(playlistId, {
        name: trimmed,
        ...(description === undefined ? {} : { description }),
      });
      const patch = (pl: SpotifyPlaylist): SpotifyPlaylist =>
        pl.id === playlistId
          ? { ...pl, name: trimmed, ...(description === undefined ? {} : { description }) }
          : pl;
      setState((s) => ({
        ...s,
        playlists: s.playlists.map(patch),
        source:
          s.source?.kind === 'playlist' && s.source.playlist.id === playlistId
            ? { kind: 'playlist', playlist: patch(s.source.playlist) }
            : s.source,
      }));
    },
    [],
  );

  /**
   * Remove a playlist from the library.
   *
   * Spotify has no "delete" — unfollowing your own playlist is what the
   * desktop client's Delete does, and the playlist stops being yours from
   * every client. Clears the track list when the deleted one was open,
   * because there's nothing left to show.
   */
  const deletePlaylist = useCallback(async (playlist: SpotifyPlaylist): Promise<void> => {
    await api.unfollowPlaylist(playlist.uri);
    setState((s) => {
      const open = s.source?.kind === 'playlist' && s.source.playlist.id === playlist.id;
      return {
        ...s,
        playlists: s.playlists.filter((p) => p.id !== playlist.id),
        ...(open
          ? { source: null, tracks: [], tracksTotal: 0, tracksNextOffset: null }
          : {}),
      };
    });
    if (getLastPlaylistId() === playlist.id) clearLastPlaylistId();
  }, []);

  /**
   * Move one track within the open playlist.
   *
   * `from` and `to` are indices into the visible `tracks` array. The caller
   * must only invoke this when those line up with Spotify's own positions —
   * see `positionsAreExact` — because null entries are dropped on read, and
   * a mismatch would silently reorder a different song.
   */
  const moveTrackInPlaylist = useCallback(
    async (from: number, to: number): Promise<void> => {
      const source = stateRef.current.source;
      if (source?.kind !== 'playlist' || from === to) return;
      const playlistId = source.playlist.id;
      const before = stateRef.current.tracks;
      if (from < 0 || from >= before.length || to < 0 || to > before.length) return;

      // Optimistic: splice locally so the row lands under the cursor rather
      // than snapping back until the request returns.
      const next = [...before];
      const [moved] = next.splice(from, 1);
      next.splice(to > from ? to - 1 : to, 0, moved);
      setState((cur) =>
        sourceKey(cur.source) === playlistId ? { ...cur, tracks: next } : cur,
      );

      const known = loadedSnapshotRef.current;
      const snapshot = known?.playlistId === playlistId ? known.snapshotId : null;
      try {
        const snap = await api.reorderPlaylistItems(playlistId, from, to, snapshot);
        if (sourceKey(stateRef.current.source) === playlistId) {
          loadedSnapshotRef.current = { playlistId, snapshotId: snap };
        }
      } catch (err) {
        setState((cur) =>
          sourceKey(cur.source) === playlistId ? { ...cur, tracks: before } : cur,
        );
        throw err;
      }
    },
    [],
  );

  /**
   * Remove a track from whatever the track list is showing — the playlist, or
   * Liked Songs.
   *
   * In playlist mode this removes EVERY copy of the track: that's the
   * endpoint's behaviour, not a choice (see api.removePlaylistItems). So the
   * optimistic update drops every matching row up front, because one row
   * vanishing now and another at the next poll would misrepresent what the
   * click did. Liked Songs can't hold duplicates, so there it's always one.
   */
  const removeTrackFromSource = useCallback(
    async (track: SpotifyTrack): Promise<void> => {
      const source = stateRef.current.source;
      if (!source) return;
      const key = sourceKey(source);
      const uri = track.uri;

      const removed = stateRef.current.tracks.filter((t) => t.uri === uri).length;
      if (removed === 0) return;
      // Captured for the rollback below.
      const before = {
        tracks: stateRef.current.tracks,
        tracksTotal: stateRef.current.tracksTotal,
        tracksNextOffset: stateRef.current.tracksNextOffset,
      };
      // Only exact when we hold the whole playlist; past the loaded span there
      // may be more copies we can't count, and guessing would drift the
      // header's track total with nothing to correct it.
      const countIsExact = stateRef.current.tracksNextOffset === null;

      const known = loadedSnapshotRef.current;
      const snapshot =
        source.kind === 'playlist' && known?.playlistId === source.playlist.id
          ? known.snapshotId
          : null;

      setState((cur) => {
        if (sourceKey(cur.source) !== key) return cur;
        return {
          ...cur,
          tracks: cur.tracks.filter((t) => t.uri !== uri),
          tracksTotal: Math.max(0, cur.tracksTotal - removed),
          // Every copy we removed sat inside the span already paged, so the
          // server-side list shifts left by that many. Leaving the offset
          // alone would skip that many tracks on the next "load more".
          tracksNextOffset:
            cur.tracksNextOffset === null
              ? null
              : Math.max(0, cur.tracksNextOffset - removed),
        };
      });

      try {
        if (source.kind === 'liked') {
          // Unliking IS the removal here. Still on the pre-Feb-2026
          // `/me/tracks` path, same as the now-playing heart — migrating both
          // to `/me/library` is a separate, untested-for-this-account change.
          await api.removeSavedTrack(track.id);
        } else {
          const next = await api.removePlaylistItems(source.playlist.id, [uri], snapshot);
          // Recording the new snapshot stops the background poll re-paging the
          // playlist purely because we just edited it. Skipped when the counts
          // above were approximate, so the poll still reconciles that case.
          if (countIsExact && sourceKey(stateRef.current.source) === key) {
            loadedSnapshotRef.current = { playlistId: source.playlist.id, snapshotId: next };
          }
        }
      } catch (err) {
        // Put the rows back rather than leave the list showing a removal that
        // didn't happen — a rejected stale snapshot_id lands here. Restoring
        // what we captured beats re-fetching: the snapshot never moved, so
        // the background poll would see "unchanged" and never correct it, and
        // refreshSelectedTracks no-ops outright if a page load is in flight.
        setState((cur) => (sourceKey(cur.source) === key ? { ...cur, ...before } : cur));
        throw err;
      }
    },
    [],
  );

  /* ─── Playback actions ─── */

  const playTrack = useCallback(async (
    track: SpotifyTrack,
    contextUri?: string,
  ) => {
    const doPlay = async (deviceId?: string) => {
      if (contextUri) {
        // Start the context at this track by URI. Positions can't be mapped
        // reliably from our side — see the note on `api.play`.
        await api.play(undefined, contextUri, track.uri, deviceId);
      } else {
        await api.play([track.uri], undefined, undefined, deviceId);
      }
    };
    try {
      await doPlay();
    } catch (err) {
      // The most common after-idle failure: 404 "No active device found".
      // Spotify Connect needs a target device; nudge one awake and retry.
      const msg = String(err);
      if (msg.includes('404') || msg.includes('NO_ACTIVE_DEVICE')) {
        try {
          let target = pickDevice((await api.getDevices()).filter((d) => !!d.id));
          // Same recovery as withDeviceFallback: nothing listening means
          // Spotify isn't running, so start it hidden and wait for it.
          if (!target?.id) target = await wakeSpotify();
          if (!target?.id) {
            console.error('playTrack: Spotify never registered a Connect device');
            return;
          }
          await doPlay(target.id);
        } catch (retryErr) {
          console.error('playTrack retry-with-device failed:', retryErr);
        }
        return;
      }
      console.error('playTrack failed:', err);
    }
  }, [wakeSpotify]);

  /**
   * Play an explicit list of URIs, starting with the first.
   *
   * Liked Songs has no context URI to hand Spotify, and a one-URI play call
   * gives it a context of exactly one track — so playback stops dead at the
   * end of that song (the same trap documented on `api.play`). Passing the
   * surrounding URIs keeps the music going. Capped at Spotify's 100-URI
   * limit, so a run from deep in a large library ends there rather than
   * continuing indefinitely.
   */
  const playTracks = useCallback(async (uris: string[]) => {
    if (uris.length === 0) return;
    const capped = uris.slice(0, api.PLAY_URIS_LIMIT);
    try {
      await withDeviceFallback((deviceId) => api.play(capped, undefined, undefined, deviceId));
    } catch (err) {
      console.error('playTracks failed:', err);
    }
  }, [withDeviceFallback]);

  // Transport actions all go through withDeviceFallback so a stale Spotify
  // Connect session (typical after the user has been away for an hour or
  // more) auto-recovers: on the first 404 we find an active device and
  // retry once with ?device_id=. Without this, the Web API silently fails
  // and the user is stuck pressing play in a third-party media controller
  // (Now Playing widget, BetterNotch, AirPods double-tap, etc.) to nudge
  // Spotify back to life — which works because those use macOS's system-
  // level MPRemoteCommandCenter that talks to native Spotify directly.
  const togglePlay = useCallback(async () => {
    const p = stateRef.current.playback;
    try {
      if (p?.is_playing) {
        await withDeviceFallback((deviceId) => api.pause(deviceId));
      } else {
        await withDeviceFallback((deviceId) => api.play(undefined, undefined, undefined, deviceId));
      }
    } catch (err) {
      console.error('togglePlay failed:', err);
    }
  }, [withDeviceFallback]);

  const next = useCallback(async () => {
    try {
      await withDeviceFallback((deviceId) => api.next(deviceId));
    } catch (err) {
      console.error('next failed:', err);
    }
  }, [withDeviceFallback]);

  const previous = useCallback(async () => {
    try {
      await withDeviceFallback((deviceId) => api.previous(deviceId));
    } catch (err) {
      console.error('previous failed:', err);
    }
  }, [withDeviceFallback]);

  const seek = useCallback(async (ms: number) => {
    try {
      await withDeviceFallback((deviceId) => api.seek(ms, deviceId));
    } catch (err) {
      console.error('seek failed:', err);
    }
  }, [withDeviceFallback]);

  const setVolume = useCallback(async (percent: number) => {
    try {
      await withDeviceFallback((deviceId) => api.setVolume(percent, deviceId));
    } catch (err) {
      console.error('setVolume failed:', err);
    }
  }, [withDeviceFallback]);

  const toggleShuffle = useCallback(async () => {
    const current = stateRef.current.playback?.shuffle_state ?? false;
    const next = !current;
    shuffleOverrideRef.current = next;
    shuffleLockUntilRef.current = Date.now() + TOGGLE_LOCK_MS;
    setState((s) => (s.playback ? { ...s, playback: { ...s.playback, shuffle_state: next } } : s));
    try {
      await withDeviceFallback((deviceId) => api.setShuffle(next, deviceId));
    } catch (err) {
      console.error('toggleShuffle failed:', err);
      shuffleOverrideRef.current = current;
      shuffleLockUntilRef.current = 0;
      setState((s) => (s.playback ? { ...s, playback: { ...s.playback, shuffle_state: current } } : s));
    }
  }, [withDeviceFallback]);

  const cycleRepeat = useCallback(async () => {
    const current = stateRef.current.playback?.repeat_state ?? 'off';
    const next: 'off' | 'track' | 'context' =
      current === 'off' ? 'context' : current === 'context' ? 'track' : 'off';
    repeatOverrideRef.current = next;
    repeatLockUntilRef.current = Date.now() + TOGGLE_LOCK_MS;
    setState((s) => (s.playback ? { ...s, playback: { ...s.playback, repeat_state: next } } : s));
    try {
      await withDeviceFallback((deviceId) => api.setRepeat(next, deviceId));
    } catch (err) {
      console.error('cycleRepeat failed:', err);
      repeatOverrideRef.current = current;
      repeatLockUntilRef.current = 0;
      setState((s) => (s.playback ? { ...s, playback: { ...s.playback, repeat_state: current } } : s));
    }
  }, [withDeviceFallback]);

  const toggleSaveCurrent = useCallback(async () => {
    const trackId = stateRef.current.playback?.item?.id;
    if (!trackId) return;
    // If savedCurrent is null (in-flight check), toggle from `false` so the
    // first click reliably "saves" rather than guessing the previous song's
    // state. The button is also disabled while null, but defend in depth.
    const current = stateRef.current.savedCurrent ?? false;
    const next = !current;
    setState((s) => ({ ...s, savedCurrent: next }));
    try {
      if (next) await api.saveTrack(trackId);
      else await api.removeSavedTrack(trackId);
    } catch (err) {
      console.error('toggleSaveCurrent failed:', err);
      setState((s) => ({ ...s, savedCurrent: current }));
    }
  }, []);

  /* ─── Search ─── */

  /** First page: all four types in a single /search call. `signal` lets the
   *  caller abandon a response for a query the user has already typed past;
   *  an abort surfaces as a rejection so the caller can distinguish it from
   *  a genuine failure (which resolves to empty). */
  const searchAll = useCallback(
    async (query: string, signal?: AbortSignal): Promise<api.SearchResults> => {
      const trimmed = query.trim();
      if (trimmed.length === 0) return api.emptySearchResults();
      try {
        const res = await api.search(
          trimmed,
          ['track', 'artist', 'album', 'playlist'],
          api.SEARCH_PAGE_SIZE,
          0,
          signal,
        );
        return api.toSearchResults(res);
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') throw err;
        console.error('search failed:', err);
        return api.emptySearchResults();
      }
    },
    [],
  );

  /** Next page for one type. Spotify caps offset+limit at 1000, so past that
   *  we stop asking rather than surfacing a 400 to the user. */
  const searchMore = useCallback(
    async (
      query: string,
      type: api.SearchType,
      offset: number,
    ): Promise<api.SearchResults> => {
      const trimmed = query.trim();
      if (trimmed.length === 0 || offset + api.SEARCH_PAGE_SIZE > api.SEARCH_MAX_OFFSET) {
        return api.emptySearchResults();
      }
      try {
        const res = await api.search(trimmed, [type], api.SEARCH_PAGE_SIZE, offset);
        return api.toSearchResults(res);
      } catch (err) {
        console.error('search page failed:', err);
        return api.emptySearchResults();
      }
    },
    [],
  );

  /** Start a context (artist / album / playlist URI) from its beginning.
   *  Artist URIs are valid contexts — Spotify plays that artist's top tracks,
   *  which is the closest thing to "artist radio" still available to new
   *  client IDs since /recommendations was withdrawn. */
  const playContext = useCallback(
    async (contextUri: string): Promise<void> => {
      try {
        await withDeviceFallback((deviceId) =>
          api.play(undefined, contextUri, undefined, deviceId),
        );
      } catch (err) {
        console.error('playContext failed:', err);
      }
    },
    [withDeviceFallback],
  );

  /* ─── On-auth: kick off the data load ─── */

  useEffect(() => {
    if (!state.authed) return;
    loadPlaylists();

    // Who we are, once per session. Only the id is kept — it's the sole input
    // to "can this playlist be edited", and re-reading it on every menu open
    // would spend a request on a value that cannot change.
    void api
      .getMe()
      .then((me) => setState((s) => ({ ...s, userId: me.id })))
      .catch((err) => {
        // Not fatal: playlist edits stay disabled rather than failing loudly
        // mid-action, and everything else works without it.
        console.error('getMe failed:', err);
      });

    const lastId = getLastPlaylistId();
    if (!lastId) return;
    void api
      .getPlaylist(lastId)
      .then((playlist) => {
        if (!playlist) return;
        // Don't stomp a selection the user made while this was in flight.
        if (stateRef.current.source) return;
        void selectPlaylist(playlist);
      })
      .catch((err) => {
        // Deleted, unfollowed, or belongs to another account now — drop the
        // id so we stop asking for it on every launch.
        console.error('restoring last playlist failed:', err);
        clearLastPlaylistId();
      });
  }, [state.authed, loadPlaylists, selectPlaylist]);

  /* ─── Polling: keep playback state fresh ─── */

  useEffect(() => {
    if (!state.authed) return;
    let cancelled = false;
    let timer: number | null = null;
    let inflight = false;
    let backoff = 0;

    const schedule = () => {
      if (cancelled) return;
      const base = isActive ? POLL_INTERVAL_ACTIVE : POLL_INTERVAL_HIDDEN;
      const delay = backoff > 0 ? Math.min(backoff, POLL_BACKOFF_MAX) : base;
      timer = window.setTimeout(tick, delay);
    };

    const tick = async () => {
      // In-flight guard: a stalled previous request shouldn't queue more.
      if (inflight) { schedule(); return; }
      inflight = true;
      try {
        const playback = await api.getPlaybackState();
        if (cancelled) return;
        // Successful response → reset backoff.
        backoff = 0;
        if (playback) {
          const now = Date.now();
          if (now < shuffleLockUntilRef.current && shuffleOverrideRef.current !== null) {
            playback.shuffle_state = shuffleOverrideRef.current;
            // Shuffle off necessarily ends Smart Shuffle. Without this the
            // sparkle icon lingers for the length of the lock after the user
            // has turned shuffle off.
            if (!shuffleOverrideRef.current) playback.smart_shuffle = false;
          } else if (now >= shuffleLockUntilRef.current) {
            shuffleOverrideRef.current = null;
          }
          if (now < repeatLockUntilRef.current && repeatOverrideRef.current !== null) {
            playback.repeat_state = repeatOverrideRef.current;
          } else if (now >= repeatLockUntilRef.current) {
            repeatOverrideRef.current = null;
          }
          // Diff the relevant fields against current state. The progress_ms
          // changes every poll, but downstream consumers (SpotifyNowPlaying,
          // LyricsPane) read progress via refs / RAF — so a fresh playback
          // object every poll still doesn't trigger render-causing work in
          // those consumers (their useEffects depend on `progress_ms` and
          // `is_playing` specifically, both primitive).
          //
          // We MUST commit a new object even on the progress-only delta: the
          // previous implementation mutated `prev.progress_ms` in place, which
          // worked today only because every consumer happens to read via refs.
          // Any future consumer that depends on `playback.progress_ms` via a
          // useEffect deps array or memo input would silently miss updates.
          // The extra commit per 1.5 s is cheap; the hidden contract was not.
          setState((s) => {
            const prev = s.playback;
            if (!prev) return { ...s, playback };
            const progressChanged = prev.progress_ms !== playback.progress_ms;
            const relevantChanged =
              prev.item?.id !== playback.item?.id ||
              prev.is_playing !== playback.is_playing ||
              prev.shuffle_state !== playback.shuffle_state ||
              prev.smart_shuffle !== playback.smart_shuffle ||
              prev.repeat_state !== playback.repeat_state ||
              disallowKey(prev) !== disallowKey(playback) ||
              prev.device?.volume_percent !== playback.device?.volume_percent ||
              prev.device?.id !== playback.device?.id ||
              prev.context?.uri !== playback.context?.uri;
            if (!relevantChanged && !progressChanged) return s;
            if (!relevantChanged) {
              // Progress-only update: keep most of the previous object so
              // memo'd children comparing by reference for specific fields
              // (track, device, context) still skip — only progress_ms is new.
              return { ...s, playback: { ...prev, progress_ms: playback.progress_ms } };
            }
            return { ...s, playback };
          });
          return;
        }
        // Null = no active device / no playback session. Don't blank the
        // player bar — keep the most recent track visible, paused. Either
        // sticky the last poll, or seed from /me/player/recently-played if
        // we never had any state in this session.
        setState((s) => {
          if (s.playback) {
            return {
              ...s,
              playback: { ...s.playback, is_playing: false },
            };
          }
          return s;
        });
        // Only hit /recently-played if we have NOTHING — once, then back off.
        if (!stateRef.current.playback) {
          try {
            const recent = await api.getRecentlyPlayed(1);
            if (cancelled || stateRef.current.playback) return;
            const item = recent[0];
            if (!item?.track) return;
            const synthetic: SpotifyPlaybackState = {
              is_playing: false,
              progress_ms: item.track.duration_ms ?? 0,
              item: item.track,
              device: null,
              shuffle_state: false,
              repeat_state: 'off',
              context: null,
            };
            setState((s) => (s.playback ? s : { ...s, playback: synthetic }));
          } catch {
            // Recently-played failures aren't worth surfacing — silent skip.
          }
        }
      } catch (err) {
        if (cancelled) return;
        const msg = String(err);
        // Rate-limit / service-unavailable: exponential backoff. Spotify
        // includes Retry-After but our fetch wrapper doesn't surface it yet
        // (Phase 3). Approximate with doubling, capped.
        if (msg.includes('429') || msg.includes('503')) {
          backoff = backoff === 0 ? 3000 : Math.min(backoff * 2, POLL_BACKOFF_MAX);
        } else {
          console.error('playback poll failed:', err);
        }
      } finally {
        inflight = false;
        schedule();
      }
    };

    tick(); // immediate first tick
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [state.authed, isActive]);

  /* ─── Polling: pick up playlist edits made elsewhere ─── */

  /**
   * Add a song from your phone and the open track list used to stay stale
   * until you re-selected the playlist. This polls the playlist's
   * `snapshot_id` — one small field-projected request — and only re-pages the
   * tracks when it actually changed.
   *
   * Runs far slower than the playback poll: playlist edits are rare, and the
   * check costs quota every tick. It also fires immediately when the window
   * comes back to the foreground, which is the common case — you edited the
   * playlist elsewhere and then switched back to the app.
   */
  useEffect(() => {
    if (!state.authed) return;
    // Playlists only. Liked Songs has no snapshot_id to compare, and /me/tracks
    // has no equivalent cheap "did this change" probe — polling it would mean
    // re-paging the whole library every minute.
    const playlistId = state.source?.kind === 'playlist' ? state.source.playlist.id : null;
    if (!playlistId) return;

    let cancelled = false;
    let timer: number | null = null;
    let inflight = false;

    const check = async () => {
      try {
        const fresh = await api.getPlaylist(playlistId);
        if (cancelled || !fresh) return;
        // The user may have switched sources while this was in flight.
        if (sourceKey(stateRef.current.source) !== playlistId) return;

        const known = loadedSnapshotRef.current;
        const knownSnapshot = known?.playlistId === playlistId ? known.snapshotId : null;
        const nextSnapshot = fresh.snapshot_id ?? null;
        const freshTotal = fresh.items?.total ?? fresh.tracks?.total;
        // If either side lacks a snapshot (older cached object, narrower
        // projection), fall back to comparing the track total. That still
        // catches "a song was added", just not an add+remove that nets zero.
        const changed =
          knownSnapshot !== null && nextSnapshot !== null
            ? knownSnapshot !== nextSnapshot
            // No snapshot AND no track total leaves nothing to compare, so
            // treat it as unchanged. Comparing `undefined` would read as
            // "changed" on every poll and re-page the playlist forever.
            : freshTotal !== undefined && freshTotal !== stateRef.current.tracksTotal;
        if (!changed) return;

        loadedSnapshotRef.current = { playlistId, snapshotId: nextSnapshot };
        await refreshSelectedTracks();
      } catch (err) {
        console.error('playlist refresh check failed:', err);
      }
    };

    const schedule = () => {
      if (cancelled) return;
      timer = window.setTimeout(
        tick,
        isActive ? PLAYLIST_REFRESH_ACTIVE_MS : PLAYLIST_REFRESH_HIDDEN_MS,
      );
    };

    const tick = async () => {
      // A stalled check shouldn't stack more on top of it.
      if (inflight) {
        schedule();
        return;
      }
      inflight = true;
      await check();
      inflight = false;
      schedule();
    };

    // Only check straight away when the window just regained focus — not when
    // this effect re-ran because the user picked a different playlist, since
    // selectPlaylist has just fetched those tracks anyway.
    const becameActive = isActive && !wasActiveRef.current;
    wasActiveRef.current = isActive;
    if (becameActive) void tick();
    else schedule();

    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [state.authed, state.source, isActive, refreshSelectedTracks]);

  /* ─── Saved-track status: re-check whenever the current track changes ─── */

  const currentTrackId = state.playback?.item?.id ?? null;
  useEffect(() => {
    // Reset to "unknown" on every track change so the heart button is
    // disabled until the new check completes, instead of briefly showing
    // the previous song's saved status.
    setState((s) => (s.savedCurrent === null ? s : { ...s, savedCurrent: null }));
    if (!state.authed || !currentTrackId) return;
    let cancelled = false;
    api
      .checkSavedTracks([currentTrackId])
      .then((flags) => {
        if (cancelled) return;
        setState((s) => {
          // Skip if the user has already advanced to a different track.
          if (s.playback?.item?.id !== currentTrackId) return s;
          return { ...s, savedCurrent: flags[0] ?? false };
        });
      })
      .catch((err) => {
        if (!cancelled) console.error('checkSavedTracks failed:', err);
      });
    return () => {
      cancelled = true;
    };
  }, [state.authed, currentTrackId]);

  return {
    ...state,
    saveClientId,
    connect,
    signOut,
    resetClientId,
    loadPlaylists,
    selectPlaylist,
    loadMoreTracks,
    playTrack,
    togglePlay,
    next,
    previous,
    seek,
    setVolume,
    toggleShuffle,
    cycleRepeat,
    toggleSaveCurrent,
    searchAll,
    searchMore,
    playContext,
    selectLikedSongs,
    playTracks,
    addTrackToPlaylist,
    removeTrackFromSource,
    createPlaylist,
    renamePlaylist,
    deletePlaylist,
    moveTrackInPlaylist,
  };
}

export type UseSpotifyReturn = ReturnType<typeof useSpotify>;

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
  SpotifyPlaybackState,
  SpotifyPlaylist,
  SpotifyTrack,
} from './types';

export interface SpotifyState {
  clientId: string | null;
  authed: boolean;
  authError: string | null;
  authing: boolean;

  playlists: SpotifyPlaylist[];
  playlistsLoading: boolean;

  selectedPlaylist: SpotifyPlaylist | null;
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
}

const POLL_INTERVAL_ACTIVE = 1500;   // ms — window visible
const POLL_INTERVAL_HIDDEN = 10000;  // ms — window hidden, ramp down to save battery + quota
const POLL_BACKOFF_MAX = 30000;      // ms — 429/503 backoff cap
/** Playlist edits are rare compared to playback changes, and the check costs
 *  a request each time, so this polls far slower than the playback loop. */
const PLAYLIST_REFRESH_ACTIVE_MS = 60000;
const PLAYLIST_REFRESH_HIDDEN_MS = 300000;

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
    selectedPlaylist: null,
    tracks: [],
    tracksLoading: false,
    tracksTotal: 0,
    tracksNextOffset: null,
    playback: null,
    savedCurrent: null,
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
        const devices = (await api.getDevices()).filter((d) => !!d.id);
        const target =
          devices.find((d) => d.is_active && !d.is_restricted) ??
          devices.find((d) => !d.is_restricted) ??
          devices[0];
        if (!target?.id) throw new Error('No Spotify device available');
        await fn(target.id);
      }
    },
    [],
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
      selectedPlaylist: null,
      playback: null,
      savedCurrent: null,
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
      selectedPlaylist: null,
      playback: null,
      savedCurrent: null,
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

  const selectPlaylist = useCallback(async (playlist: SpotifyPlaylist) => {
    setLastPlaylistId(playlist.id);
    loadedSnapshotRef.current = {
      playlistId: playlist.id,
      snapshotId: playlist.snapshot_id ?? null,
    };
    setState((s) => ({
      ...s,
      selectedPlaylist: playlist,
      tracks: [],
      tracksLoading: true,
      tracksTotal: 0,
      tracksNextOffset: null,
    }));
    try {
      const res = await api.getPlaylistTracks(playlist.id, 100, 0);
      const baseOffset = res.offset ?? 0;
      // Null items (removed or local-only) are dropped; paging still advances
      // by the raw item count below so the next page starts in the right place.
      const tracks = res.items.flatMap((it) => (it.track ? [it.track] : []));
      const fetchedThrough = baseOffset + res.items.length;
      setState((s) => ({
        ...s,
        tracks,
        tracksLoading: false,
        tracksTotal: res.total,
        // Continue from the next playlist position, NOT the filtered count —
        // otherwise filtering nulls would skip or duplicate items.
        tracksNextOffset: fetchedThrough < res.total ? fetchedThrough : null,
      }));
    } catch (err) {
      console.error('selectPlaylist failed:', err);
      setState((s) => ({ ...s, tracksLoading: false }));
    }
  }, []);

  const loadMoreTracks = useCallback(async () => {
    const s = stateRef.current;
    if (!s.selectedPlaylist || s.tracksNextOffset === null || s.tracksLoading) return;
    const playlistId = s.selectedPlaylist.id;
    const offset = s.tracksNextOffset;
    setState((cur) => ({ ...cur, tracksLoading: true }));
    try {
      const res = await api.getPlaylistTracks(playlistId, 100, offset);
      const baseOffset = res.offset ?? offset;
      const moreTracks = res.items.flatMap((it) => (it.track ? [it.track] : []));
      const fetchedThrough = baseOffset + res.items.length;
      setState((cur) => {
        // Skip if user switched playlists during fetch
        if (cur.selectedPlaylist?.id !== playlistId) return { ...cur, tracksLoading: false };
        return {
          ...cur,
          tracks: [...cur.tracks, ...moreTracks],
          tracksLoading: false,
          tracksTotal: res.total,
          // Same fix as selectPlaylist — advance by the playlist-position
          // we fetched through, not by the filtered count.
          tracksNextOffset: fetchedThrough < res.total ? fetchedThrough : null,
        };
      });
    } catch (err) {
      console.error('loadMoreTracks failed:', err);
      setState((cur) => ({ ...cur, tracksLoading: false }));
    }
  }, []);

  /**
   * Re-fetch the span of the selected playlist we already have, in place.
   *
   * Deliberately NOT `selectPlaylist` again: that blanks `tracks` first, which
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
    const playlist = s.selectedPlaylist;
    if (!playlist || s.tracksLoading) return;
    const playlistId = playlist.id;

    // How far we'd paged. `tracksNextOffset === null` means the whole playlist
    // was loaded, so re-cover it entirely — including anything appended since,
    // which is where Spotify puts newly added songs.
    const hadEverything = s.tracksNextOffset === null;
    let target = hadEverything ? Number.POSITIVE_INFINITY : s.tracksNextOffset ?? 0;

    setState((cur) => (cur.selectedPlaylist?.id === playlistId ? { ...cur, tracksLoading: true } : cur));

    const collected: SpotifyTrack[] = [];
    let offset = 0;
    let total = s.tracksTotal;
    try {
      do {
        const res = await api.getPlaylistTracks(playlistId, 100, offset);
        // Bail if the user switched playlists mid-refresh.
        if (stateRef.current.selectedPlaylist?.id !== playlistId) return;
        total = res.total;
        if (hadEverything) target = res.total;
        collected.push(...res.items.flatMap((it) => (it.track ? [it.track] : [])));
        // Advance by raw item count, not the null-filtered length — same
        // reasoning as selectPlaylist.
        offset = (res.offset ?? offset) + res.items.length;
        // A page that returns nothing would otherwise spin forever.
        if (res.items.length === 0) break;
      } while (offset < target && offset < total);

      setState((cur) => {
        if (cur.selectedPlaylist?.id !== playlistId) return cur;
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
      setState((cur) =>
        cur.selectedPlaylist?.id === playlistId ? { ...cur, tracksLoading: false } : cur,
      );
    }
  }, []);

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
          const devices = (await api.getDevices()).filter((d) => !!d.id);
          // Prefer an already-active device, else first usable one.
          const target =
            devices.find((d) => d.is_active && !d.is_restricted) ??
            devices.find((d) => !d.is_restricted) ??
            devices[0];
          if (!target || !target.id) {
            console.error('playTrack: no Spotify devices available — open Spotify on a device first');
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
  }, []);

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

    const lastId = getLastPlaylistId();
    if (!lastId) return;
    void api
      .getPlaylist(lastId)
      .then((playlist) => {
        if (!playlist) return;
        // Don't stomp a selection the user made while this was in flight.
        if (stateRef.current.selectedPlaylist) return;
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
              prev.repeat_state !== playback.repeat_state ||
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
    const playlistId = state.selectedPlaylist?.id;
    if (!playlistId) return;

    let cancelled = false;
    let timer: number | null = null;
    let inflight = false;

    const check = async () => {
      try {
        const fresh = await api.getPlaylist(playlistId);
        if (cancelled || !fresh) return;
        // The user may have switched playlists while this was in flight.
        if (stateRef.current.selectedPlaylist?.id !== playlistId) return;

        const known = loadedSnapshotRef.current;
        const knownSnapshot = known?.playlistId === playlistId ? known.snapshotId : null;
        const nextSnapshot = fresh.snapshot_id ?? null;
        // If either side lacks a snapshot (older cached object, narrower
        // projection), fall back to comparing the track total. That still
        // catches "a song was added", just not an add+remove that nets zero.
        const changed =
          knownSnapshot !== null && nextSnapshot !== null
            ? knownSnapshot !== nextSnapshot
            : fresh.tracks.total !== stateRef.current.tracksTotal;
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
  }, [state.authed, state.selectedPlaylist?.id, isActive, refreshSelectedTracks]);

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
  };
}

export type UseSpotifyReturn = ReturnType<typeof useSpotify>;

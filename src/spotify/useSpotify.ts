import { useCallback, useEffect, useRef, useState } from 'react';
import * as api from './api';
import { authorize, isAuthenticated, disconnect } from './auth';
import { getClientId, setClientId, clearClientId } from './storage';
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
  /** Parallel to `tracks` — each entry is the original playlist position
   *  of the corresponding track (BEFORE we filter out null/local items).
   *  Required so the offset we pass to Spotify's `play(context_uri, offset)`
   *  matches the actual playlist position, not the filtered-array index. */
  trackPositions: number[];
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

const POLL_INTERVAL = 1500; // ms — Spotify rate limits are generous, this is conservative

export function useSpotify() {
  const [state, setState] = useState<SpotifyState>(() => ({
    clientId: getClientId(),
    authed: isAuthenticated(),
    authError: null,
    authing: false,
    playlists: [],
    playlistsLoading: false,
    selectedPlaylist: null,
    tracks: [],
    trackPositions: [],
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
    setState((s) => ({
      ...s,
      authed: false,
      playlists: [],
      tracks: [],
      trackPositions: [],
      selectedPlaylist: null,
      playback: null,
      savedCurrent: null,
    }));
  }, []);

  const resetClientId = useCallback(() => {
    disconnect();
    clearClientId();
    setState((s) => ({
      ...s,
      clientId: null,
      authed: false,
      playlists: [],
      tracks: [],
      trackPositions: [],
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

  const selectPlaylist = useCallback(async (playlist: SpotifyPlaylist) => {
    setState((s) => ({
      ...s,
      selectedPlaylist: playlist,
      tracks: [],
      trackPositions: [],
      tracksLoading: true,
      tracksTotal: 0,
      tracksNextOffset: null,
    }));
    try {
      const res = await api.getPlaylistTracks(playlist.id, 100, 0);
      // Walk items with their original positions so we can pass the correct
      // offset to Spotify's `play(context_uri, offset.position)` even when
      // null/local items get filtered out (these would shift the indices
      // and cause clicks to play the wrong track).
      const baseOffset = res.offset ?? 0;
      const tracks: SpotifyTrack[] = [];
      const trackPositions: number[] = [];
      res.items.forEach((it, i) => {
        if (it.track) {
          tracks.push(it.track);
          trackPositions.push(baseOffset + i);
        }
      });
      const fetchedThrough = baseOffset + res.items.length;
      setState((s) => ({
        ...s,
        tracks,
        trackPositions,
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
      const moreTracks: SpotifyTrack[] = [];
      const morePositions: number[] = [];
      res.items.forEach((it, i) => {
        if (it.track) {
          moreTracks.push(it.track);
          morePositions.push(baseOffset + i);
        }
      });
      const fetchedThrough = baseOffset + res.items.length;
      setState((cur) => {
        // Skip if user switched playlists during fetch
        if (cur.selectedPlaylist?.id !== playlistId) return { ...cur, tracksLoading: false };
        const tracks = [...cur.tracks, ...moreTracks];
        const trackPositions = [...cur.trackPositions, ...morePositions];
        return {
          ...cur,
          tracks,
          trackPositions,
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

  /* ─── Playback actions ─── */

  const playTrack = useCallback(async (
    track: SpotifyTrack,
    contextUri?: string,
    /** Explicit index within the context — used by views (e.g. album drill-in)
     *  where `stateRef.current.tracks` isn't the right list to search. */
    explicitOffsetIdx?: number,
  ) => {
    const doPlay = async (deviceId?: string) => {
      if (contextUri) {
        // Resolve the playlist position to pass to Spotify:
        //   - explicitOffsetIdx wins (album drill-in passes its own index)
        //   - otherwise find the track in our filtered array, then look up
        //     the ORIGINAL playlist position from the parallel positions
        //     array (filtering nulls/local items shifts the array index but
        //     NOT the playlist position).
        let trackIndex: number | undefined = explicitOffsetIdx;
        if (trackIndex === undefined) {
          const filteredIdx = stateRef.current.tracks.findIndex((t) => t.id === track.id);
          if (filteredIdx >= 0) {
            const pos = stateRef.current.trackPositions[filteredIdx];
            trackIndex = pos !== undefined ? pos : filteredIdx;
          }
        }
        await api.play(undefined, contextUri, trackIndex, deviceId);
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

  const togglePlay = useCallback(async () => {
    const p = stateRef.current.playback;
    try {
      if (p?.is_playing) await api.pause();
      else await api.play();
    } catch (err) {
      console.error('togglePlay failed:', err);
    }
  }, []);

  const next = useCallback(async () => {
    try { await api.next(); } catch (err) { console.error(err); }
  }, []);

  const previous = useCallback(async () => {
    try { await api.previous(); } catch (err) { console.error(err); }
  }, []);

  const seek = useCallback(async (ms: number) => {
    try { await api.seek(ms); } catch (err) { console.error(err); }
  }, []);

  const setVolume = useCallback(async (percent: number) => {
    try { await api.setVolume(percent); } catch (err) { console.error(err); }
  }, []);

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

  const searchTracks = useCallback(
    async (query: string): Promise<SpotifyTrack[]> => {
      const trimmed = query.trim();
      if (trimmed.length === 0) return [];
      try {
        const res = await api.search(trimmed, ['track'], 25);
        return res?.tracks?.items ?? [];
      } catch (err) {
        console.error('search failed:', err);
        return [];
      }
    },
    [],
  );

  /* ─── On-auth: kick off the data load ─── */

  useEffect(() => {
    if (!state.authed) return;
    loadPlaylists();
  }, [state.authed, loadPlaylists]);

  /* ─── Polling: keep playback state fresh ─── */

  useEffect(() => {
    if (!state.authed) return;
    let cancelled = false;

    const tick = async () => {
      try {
        const playback = await api.getPlaybackState();
        if (cancelled) return;
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
          // LyricsPane) now read progress via refs / RAF — so they don't need
          // React state to update on every poll. We only dispatch when fields
          // that actually matter for rendering change: track id, playing,
          // shuffle/repeat, volume, device id, context. progress_ms still
          // updates the object but doesn't by itself trigger a render-causing
          // diff. This collapses ~1 setState every 1.5s into ~1 setState every
          // few seconds (only on real state transitions).
          setState((s) => {
            const prev = s.playback;
            if (!prev) return { ...s, playback };
            const relevantChanged =
              prev.item?.id !== playback.item?.id ||
              prev.is_playing !== playback.is_playing ||
              prev.shuffle_state !== playback.shuffle_state ||
              prev.repeat_state !== playback.repeat_state ||
              prev.device?.volume_percent !== playback.device?.volume_percent ||
              prev.device?.id !== playback.device?.id ||
              prev.context?.uri !== playback.context?.uri;
            if (!relevantChanged) {
              // Keep prev object identity so memoized children skip re-rendering,
              // but quietly update progress_ms on the SAME object (a ref-style
              // update). Consumers that need progress (now playing slider,
              // lyrics) read from authoritative refs that we keep in sync via
              // their own effects against prev.progress_ms — so mutation here
              // is a safe shortcut that avoids a cascade-render.
              prev.progress_ms = playback.progress_ms;
              return s;
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
        if (!cancelled) console.error('playback poll failed:', err);
      }
    };

    tick();
    const interval = setInterval(tick, POLL_INTERVAL);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [state.authed]);

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
    searchTracks,
  };
}

export type UseSpotifyReturn = ReturnType<typeof useSpotify>;

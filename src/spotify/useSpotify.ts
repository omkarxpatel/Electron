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
  tracksLoading: boolean;
  /** Total tracks in the selected playlist (for pagination state). */
  tracksTotal: number;
  /** Next offset to fetch; null = all tracks loaded. */
  tracksNextOffset: number | null;

  playback: SpotifyPlaybackState | null;
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
    tracksLoading: false,
    tracksTotal: 0,
    tracksNextOffset: null,
    playback: null,
  }));

  const stateRef = useRef(state);
  stateRef.current = state;

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
      selectedPlaylist: null,
      playback: null,
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
      selectedPlaylist: null,
      playback: null,
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
      tracksLoading: true,
      tracksTotal: 0,
      tracksNextOffset: null,
    }));
    try {
      const res = await api.getPlaylistTracks(playlist.id, 100, 0);
      const tracks = res.items.map((it) => it.track).filter((t): t is SpotifyTrack => !!t);
      const loaded = tracks.length;
      setState((s) => ({
        ...s,
        tracks,
        tracksLoading: false,
        tracksTotal: res.total,
        tracksNextOffset: loaded < res.total ? loaded : null,
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
      const more = res.items.map((it) => it.track).filter((t): t is SpotifyTrack => !!t);
      setState((cur) => {
        // Skip if user switched playlists during fetch
        if (cur.selectedPlaylist?.id !== playlistId) return { ...cur, tracksLoading: false };
        const tracks = [...cur.tracks, ...more];
        return {
          ...cur,
          tracks,
          tracksLoading: false,
          tracksTotal: res.total,
          tracksNextOffset: tracks.length < res.total ? tracks.length : null,
        };
      });
    } catch (err) {
      console.error('loadMoreTracks failed:', err);
      setState((cur) => ({ ...cur, tracksLoading: false }));
    }
  }, []);

  /* ─── Playback actions ─── */

  const playTrack = useCallback(async (track: SpotifyTrack, contextUri?: string) => {
    try {
      if (contextUri) {
        const trackIndex = stateRef.current.tracks.findIndex((t) => t.id === track.id);
        await api.play(undefined, contextUri, trackIndex >= 0 ? trackIndex : undefined);
      } else {
        await api.play([track.uri]);
      }
    } catch (err) {
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
        if (!cancelled) setState((s) => ({ ...s, playback }));
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
  };
}

export type UseSpotifyReturn = ReturnType<typeof useSpotify>;

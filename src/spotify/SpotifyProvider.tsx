import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { useSpotify } from './useSpotify';
import type { PlaylistEntry, SpotifyState } from './useSpotify';
import type {
  SpotifyPlaybackState,
  SpotifyPlaylist,
  SpotifyTrack,
} from './types';

/**
 * Splits Spotify state into two contexts so a polling tick (playback) doesn't
 * re-render library consumers (track lists, overlays), and a library reload
 * (playlists / tracks) doesn't re-render the bottom player bar.
 *
 * - PlaybackContext  — moves on every 1.5s poll when relevant fields change.
 * - LibraryContext   — moves on auth / playlist / track-list changes only.
 *
 * Both contexts share one `useSpotify()` instance. The hook still owns the
 * polling effect, lifecycle, refs, etc.; the provider just slices its return.
 */

// ── Playback context (transport + now-playing) ──────────────────────────────

export interface PlaybackContextValue {
  playback: SpotifyPlaybackState | null;
  savedCurrent: boolean | null;
  togglePlay: () => Promise<void> | void;
  next: () => Promise<void> | void;
  previous: () => Promise<void> | void;
  seek: (ms: number) => Promise<void> | void;
  setVolume: (percent: number) => Promise<void> | void;
  toggleShuffle: () => Promise<void> | void;
  cycleRepeat: () => Promise<void> | void;
  toggleSaveCurrent: () => Promise<void> | void;
}

const PlaybackContext = createContext<PlaybackContextValue | null>(null);

export function usePlayback(): PlaybackContextValue {
  const v = useContext(PlaybackContext);
  if (!v) throw new Error('usePlayback must be used within <SpotifyProvider>');
  return v;
}

// ── Library context (auth + playlists + tracks + library actions) ──────────

export interface LibraryContextValue {
  // Auth (rarely changes — bundled here to avoid a third context just for it).
  clientId: string | null;
  authed: boolean;
  authing: boolean;
  authError: string | null;
  saveClientId: (id: string) => void;
  connect: () => Promise<void> | void;
  signOut: () => void;
  resetClientId: () => void;

  // Library state.
  playlists: SpotifyPlaylist[];
  playlistsLoading: boolean;
  selectedPlaylist: SpotifyPlaylist | null;
  entries: PlaylistEntry[];
  tracks: SpotifyTrack[];
  tracksLoading: boolean;
  tracksTotal: number;
  tracksNextOffset: number | null;

  // Library actions.
  loadPlaylists: () => Promise<void>;
  selectPlaylist: (playlist: SpotifyPlaylist) => Promise<void>;
  loadMoreTracks: () => Promise<void>;
  playTrack: (
    track: SpotifyTrack,
    contextUri?: string,
    explicitOffsetIdx?: number,
  ) => Promise<void> | void;
  searchTracks: (query: string) => Promise<SpotifyTrack[]>;
}

const LibraryContext = createContext<LibraryContextValue | null>(null);

export function useLibrary(): LibraryContextValue {
  const v = useContext(LibraryContext);
  if (!v) throw new Error('useLibrary must be used within <SpotifyProvider>');
  return v;
}

// ── Convenience selector: id of the track currently playing, or null. ──────

export function useCurrentlyPlayingId(): string | null {
  return usePlayback().playback?.item?.id ?? null;
}

// ── Provider ────────────────────────────────────────────────────────────────

interface ProviderProps {
  children: ReactNode;
}

export function SpotifyProvider({ children }: ProviderProps) {
  const spotify = useSpotify();

  const playback: PlaybackContextValue = useMemo(
    () => ({
      playback: spotify.playback,
      savedCurrent: spotify.savedCurrent,
      togglePlay: spotify.togglePlay,
      next: spotify.next,
      previous: spotify.previous,
      seek: spotify.seek,
      setVolume: spotify.setVolume,
      toggleShuffle: spotify.toggleShuffle,
      cycleRepeat: spotify.cycleRepeat,
      toggleSaveCurrent: spotify.toggleSaveCurrent,
    }),
    [
      spotify.playback,
      spotify.savedCurrent,
      spotify.togglePlay,
      spotify.next,
      spotify.previous,
      spotify.seek,
      spotify.setVolume,
      spotify.toggleShuffle,
      spotify.cycleRepeat,
      spotify.toggleSaveCurrent,
    ],
  );

  const library: LibraryContextValue = useMemo(
    () => ({
      clientId: spotify.clientId,
      authed: spotify.authed,
      authing: spotify.authing,
      authError: spotify.authError,
      saveClientId: spotify.saveClientId,
      connect: spotify.connect,
      signOut: spotify.signOut,
      resetClientId: spotify.resetClientId,
      playlists: spotify.playlists,
      playlistsLoading: spotify.playlistsLoading,
      selectedPlaylist: spotify.selectedPlaylist,
      entries: spotify.entries,
      tracks: spotify.tracks,
      tracksLoading: spotify.tracksLoading,
      tracksTotal: spotify.tracksTotal,
      tracksNextOffset: spotify.tracksNextOffset,
      loadPlaylists: spotify.loadPlaylists,
      selectPlaylist: spotify.selectPlaylist,
      loadMoreTracks: spotify.loadMoreTracks,
      playTrack: spotify.playTrack,
      searchTracks: spotify.searchTracks,
    }),
    [
      spotify.clientId,
      spotify.authed,
      spotify.authing,
      spotify.authError,
      spotify.saveClientId,
      spotify.connect,
      spotify.signOut,
      spotify.resetClientId,
      spotify.playlists,
      spotify.playlistsLoading,
      spotify.selectedPlaylist,
      spotify.entries,
      spotify.tracks,
      spotify.tracksLoading,
      spotify.tracksTotal,
      spotify.tracksNextOffset,
      spotify.loadPlaylists,
      spotify.selectPlaylist,
      spotify.loadMoreTracks,
      spotify.playTrack,
      spotify.searchTracks,
    ],
  );

  return (
    <PlaybackContext.Provider value={playback}>
      <LibraryContext.Provider value={library}>{children}</LibraryContext.Provider>
    </PlaybackContext.Provider>
  );
}

// Re-export the underlying SpotifyState type (used by lyrics + other consumers
// that may want the playback shape directly without going through the hook).
export type { SpotifyState, PlaylistEntry };

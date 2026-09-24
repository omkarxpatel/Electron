/**
 * Subset of Spotify Web API response shapes that we actually consume.
 * Reference: https://developer.spotify.com/documentation/web-api/reference
 */

export interface SpotifyImage {
  url: string;
  height: number | null;
  width: number | null;
}

export interface SpotifyArtist {
  id: string;
  name: string;
  uri: string;
  /** Only present on full artist objects (/search, /artists) — the nested
   *  artists inside track/album objects are simplified and omit these. */
  images?: SpotifyImage[];
  genres?: string[];
}

export interface SpotifyAlbum {
  id: string;
  name: string;
  uri: string;
  images: SpotifyImage[];
  artists: SpotifyArtist[];
}

export interface SpotifyTrack {
  id: string;
  name: string;
  uri: string;
  duration_ms: number;
  explicit: boolean;
  artists: SpotifyArtist[];
  album: SpotifyAlbum;
}

export interface SpotifyPlaylist {
  id: string;
  name: string;
  description: string | null;
  uri: string;
  images: SpotifyImage[];
  owner: { id: string; display_name: string | null };
  /** Spotify's Feb 2026 wave renamed `tracks` to `items`. Both keys are live
   *  simultaneously: client IDs created before the cutover receive both, IDs
   *  created after receive only `items`, and neither is sent for a playlist
   *  the user doesn't own. Always read `items?.total ?? tracks?.total` —
   *  reading `tracks.total` unguarded blanked the whole window via the root
   *  error boundary once already. */
  tracks?: { total: number };
  items?: { total: number };
  /** Opaque token Spotify changes on ANY edit to the playlist — add, remove,
   *  reorder, rename. Comparing it is how the background refresh detects that
   *  a playlist changed without re-paging the whole track list.
   *
   *  Optional because older persisted objects and any caller using a narrower
   *  `fields=` projection won't carry it; treat absent as "unknown". */
  snapshot_id?: string;
}

export interface SpotifyPlaylistsResponse {
  items: SpotifyPlaylist[];
  total: number;
  next: string | null;
  offset: number;
}

export interface SpotifyPlaylistTrackItem {
  added_at: string;
  is_local: boolean;
  /** Same Feb 2026 rename as the playlist object's `tracks`/`items`, one level
   *  down: `track` became `item`. Grandfathered client IDs send both keys on
   *  every entry. Read via `entryTrack()` in useSpotify, never directly. */
  track?: SpotifyTrack | null;
  item?: SpotifyTrack | null;
}

export interface SpotifyPlaylistTracksResponse {
  items: SpotifyPlaylistTrackItem[];
  total: number;
  next: string | null;
  offset: number;
}

export interface SpotifyDevice {
  id: string | null;
  name: string;
  type: string;
  is_active: boolean;
  is_private_session: boolean;
  is_restricted: boolean;
  volume_percent: number | null;
}

export interface SpotifyPlaybackState {
  device: SpotifyDevice | null;
  shuffle_state: boolean;
  repeat_state: 'off' | 'track' | 'context';
  is_playing: boolean;
  progress_ms: number | null;
  item: SpotifyTrack | null;
  context: { uri: string; type: string } | null;
}

export interface SpotifyUser {
  id: string;
  display_name: string | null;
  images: SpotifyImage[];
  product: 'premium' | 'free' | 'open';
}

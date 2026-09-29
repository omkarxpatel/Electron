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
  /**
   * Feb 2026 REMOVED `popularity` and `followers` from artist objects, and
   * live probes since then show `genres` coming back as null. All three are
   * still sent to client IDs created before the cutover, so they're optional
   * rather than deleted — read them through the helpers in `stats.ts`, which
   * treat absent as "this account can't have this stat" rather than zero.
   */
  genres?: string[] | null;
  popularity?: number;
  followers?: { total: number };
}

export interface SpotifyAlbum {
  id: string;
  name: string;
  uri: string;
  images: SpotifyImage[];
  artists: SpotifyArtist[];
  /** Present on the simplified albums returned by /artists/{id}/albums,
   *  which is what the artist page lists. */
  release_date?: string;
  album_type?: string;
  total_tracks?: number;
}

export interface SpotifyTrack {
  id: string;
  name: string;
  uri: string;
  duration_ms: number;
  explicit: boolean;
  artists: SpotifyArtist[];
  album: SpotifyAlbum;
  /** Removed from Dev Mode responses in Feb 2026; grandfathered client IDs
   *  still receive it. Same handling as the artist fields above. */
  popularity?: number;
  /** Present when Spotify has relinked this track for the user's market: the
   *  id here is the ORIGINAL, and `id` above is the market-specific one. They
   *  differ, so matching a playing track against a stored list has to try
   *  both or it will decide a track isn't in a list it is sitting in. */
  linked_from?: { id: string; uri?: string };
}

export interface SpotifyPlaylist {
  id: string;
  name: string;
  description: string | null;
  uri: string;
  images: SpotifyImage[];
  owner: { id: string; display_name: string | null };
  /** Whether other users may add to this playlist. Together with `owner.id`
   *  it's the only way to know an edit will be accepted — Spotify answers a
   *  write to someone else's playlist with a 403 that reads identically to a
   *  missing-scope 403. Absent on narrower `fields=` projections. */
  collaborative?: boolean;
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

/** One row of GET /me/tracks. Unlike playlist entries, this kept the `track`
 *  key through Feb 2026 — only the playlist shape was renamed to `item`. */
export interface SavedTrackItem {
  added_at: string;
  track: SpotifyTrack | null;
}

export interface SavedTracksResponse {
  items: SavedTrackItem[];
  total: number;
  next: string | null;
  offset: number;
}

/** Which of the three windows /me/top is being asked about. */
export type TopTimeRange = 'short_term' | 'medium_term' | 'long_term';

export interface SpotifyDevice {
  id: string | null;
  name: string;
  type: string;
  is_active: boolean;
  is_private_session: boolean;
  is_restricted: boolean;
  volume_percent: number | null;
}

/** What Spotify will refuse *right now*. Every flag it sets comes back as a
 *  403 "Player command failed: Restriction violated" if you call anyway, so
 *  the transport buttons read this instead of firing a doomed request.
 *  Only the flags the UI acts on are declared. */
export interface SpotifyDisallows {
  toggling_shuffle?: boolean;
  toggling_repeat_context?: boolean;
  toggling_repeat_track?: boolean;
}

export interface SpotifyPlaybackState {
  device: SpotifyDevice | null;
  shuffle_state: boolean;
  /** Spotify's Smart Shuffle — shuffle that splices in suggested tracks that
   *  aren't in the playlist. Undocumented in the Web API reference but
   *  present on the live /me/player response, so it is optional here.
   *
   *  READ-ONLY, permanently: PUT /me/player/shuffle takes a bare boolean and
   *  has no smart variant, so the app can show this mode but can never
   *  command it. The user turns it on from the Spotify client. */
  smart_shuffle?: boolean;
  repeat_state: 'off' | 'track' | 'context';
  is_playing: boolean;
  progress_ms: number | null;
  item: SpotifyTrack | null;
  context: { uri: string; type: string } | null;
  actions?: { disallows?: SpotifyDisallows };
}

export interface SpotifyUser {
  id: string;
  display_name: string | null;
  images: SpotifyImage[];
  product: 'premium' | 'free' | 'open';
}

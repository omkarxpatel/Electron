/**
 * Thin Spotify Web API client. All calls go through `request()` which
 * attaches the bearer token, handles 401s (single retry after token
 * refresh), and parses JSON.
 */

import { getValidAccessToken, refreshAccessToken } from './auth';
import type {
  SavedTracksResponse,
  SpotifyAlbum,
  SpotifyArtist,
  SpotifyDevice,
  SpotifyPlaylist,
  TopTimeRange,
  SpotifyPlaylistsResponse,
  SpotifyPlaylistTracksResponse,
  SpotifyPlaybackState,
  SpotifyTrack,
  SpotifyUser,
} from './types';

const BASE = 'https://api.spotify.com/v1';

async function request<T>(
  path: string,
  options: RequestInit = {},
  retried = false,
): Promise<T | null> {
  const token = await getValidAccessToken();
  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers: {
      ...(options.headers ?? {}),
      Authorization: `Bearer ${token}`,
    },
  });

  // 204 No Content (e.g. nothing playing) → null
  if (res.status === 204) return null;

  if (res.status === 401 && !retried) {
    await refreshAccessToken();
    return request<T>(path, options, true);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Spotify API ${res.status}: ${text || res.statusText}`);
  }

  if (res.status === 202) return null; // accepted-no-body (e.g. transfer playback)

  const len = res.headers.get('content-length');
  if (len === '0') return null;
  // Some player-mutation endpoints (shuffle, repeat, …) sometimes respond
  // 200 with a non-JSON body. Only parse when the server says it's JSON;
  // otherwise treat as "no usable body" and return null so the caller (which
  // is `await request(...)` for fire-and-forget mutations) doesn't blow up.
  const contentType = res.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) return null;
  return res.json() as Promise<T>;
}

export async function getMe(): Promise<SpotifyUser> {
  const data = await request<SpotifyUser>('/me');
  if (!data) throw new Error('Empty /me response');
  return data;
}

export async function getPlaylists(limit = 50, offset = 0): Promise<SpotifyPlaylistsResponse> {
  const data = await request<SpotifyPlaylistsResponse>(`/me/playlists?limit=${limit}&offset=${offset}`);
  if (!data) throw new Error('Empty playlists response');
  return data;
}

export async function getPlaylistTracks(
  playlistId: string,
  limit = 100,
  offset = 0,
): Promise<SpotifyPlaylistTracksResponse> {
  const data = await request<SpotifyPlaylistTracksResponse>(
    `/playlists/${playlistId}/items?limit=${limit}&offset=${offset}`,
  );
  if (!data) throw new Error('Empty tracks response');
  return data;
}

/** Single playlist by id — used to restore the last-opened playlist on
 *  launch, which may sit outside the first page of `/me/playlists`. */
export async function getPlaylist(playlistId: string): Promise<SpotifyPlaylist | null> {
  return request<SpotifyPlaylist>(
    // `items(total)`, not `tracks(total)`: post-Feb-2026 client IDs have no
    // `tracks` field at all, and pre-cutover IDs carry both, so asking for
    // `items` is the one projection that works for either.
    `/playlists/${playlistId}?fields=id,name,description,uri,images,owner(id,display_name),items(total),snapshot_id`,
  );
}

/* ─── Playlist editing ─── */

/** Both write endpoints answer with the playlist's new snapshot_id. */
interface SnapshotResponse {
  snapshot_id: string;
}

/** Max URIs Spotify accepts per add/remove call. */
const PLAYLIST_EDIT_BATCH = 100;

/**
 * Append tracks to a playlist. Feb 2026 renamed the path from `/tracks` to
 * `/items`; `/items` answers for pre-cutover client IDs too, so there is one
 * spelling to maintain rather than two.
 *
 * Note the body key is `uris` here but `items` on the DELETE below — the two
 * endpoints genuinely disagree, and sending `items` to this one adds nothing
 * and still returns 201, so the mistake looks like success.
 *
 * Omitting `position` appends, which is where Spotify's own clients put new
 * songs, so the track list's existing "appended since we paged" handling
 * already covers it.
 */
export async function addPlaylistItems(
  playlistId: string,
  uris: string[],
): Promise<string | null> {
  if (uris.length === 0) return null;
  if (uris.length > PLAYLIST_EDIT_BATCH) {
    throw new Error(`addPlaylistItems: ${uris.length} URIs exceeds the ${PLAYLIST_EDIT_BATCH} limit`);
  }
  const data = await request<SnapshotResponse>(`/playlists/${playlistId}/items`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uris }),
  });
  return data?.snapshot_id ?? null;
}

/**
 * Remove every occurrence of each URI from a playlist.
 *
 * "Every occurrence" is not a choice we're making. The old endpoint took a
 * per-URI `positions` array to target one copy; the replacement accepts the
 * field and ignores it, so a playlist holding the same song twice loses both.
 * Callers must label the action for what it does — see the duplicate-aware
 * label in SpotifyTrackList.
 *
 * `snapshotId` is optimistic concurrency: Spotify rejects the edit if the
 * playlist moved on since we read it, rather than deleting whatever now sits
 * where we think our track is.
 */
export async function removePlaylistItems(
  playlistId: string,
  uris: string[],
  snapshotId?: string | null,
): Promise<string | null> {
  if (uris.length === 0) return null;
  if (uris.length > PLAYLIST_EDIT_BATCH) {
    throw new Error(`removePlaylistItems: ${uris.length} URIs exceeds the ${PLAYLIST_EDIT_BATCH} limit`);
  }
  const body: Record<string, unknown> = { items: uris.map((uri) => ({ uri })) };
  if (snapshotId) body.snapshot_id = snapshotId;
  const data = await request<SnapshotResponse>(`/playlists/${playlistId}/items`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return data?.snapshot_id ?? null;
}

/**
 * Whether Spotify will accept an edit to this playlist. Has to be answered
 * locally: a write to a playlist you only follow comes back as a 403 whose
 * body is identical to the missing-scope 403, so there's no way to tell the
 * two apart after the fact — and one is worth telling the user to reconnect
 * over, the other isn't.
 *
 * `userId` null (the /me read hasn't landed, or failed) reads as "no", which
 * greys the action out instead of offering an edit that would 403.
 */
export function canEditPlaylist(playlist: SpotifyPlaylist, userId: string | null): boolean {
  if (!userId) return false;
  return playlist.owner.id === userId || playlist.collaborative === true;
}

/** True when the error came back as a missing-scope 403 — i.e. the user is
 *  signed in on a token issued before playlist-modify-* was requested and has
 *  to reconnect. Worth telling them, because retrying never fixes it. */
export function isMissingScopeError(err: unknown): boolean {
  const msg = String(err);
  // Spotify's wording is "Insufficient client scope"; matched loosely on
  // `scope` so a reworded 403 still routes to the "reconnect" advice rather
  // than a generic failure the user can only respond to by retrying.
  return msg.includes('403') && /scope/i.test(msg);
}

export async function getPlaybackState(): Promise<SpotifyPlaybackState | null> {
  return request<SpotifyPlaybackState>('/me/player');
}

interface QueueResponse {
  currently_playing: SpotifyPlaybackState['item'] | null;
  queue: NonNullable<SpotifyPlaybackState['item']>[];
}

/**
 * Queue is read from two places on every track change:
 *   - App.tsx's lyrics prefetch effect
 *   - SpotifyQueue.tsx's display on panel open
 * Without dedup these fire two separate /me/player/queue requests within
 * milliseconds. Cache the in-flight promise for QUEUE_TTL_MS so both
 * callers share one response, and refresh on the next call past the TTL.
 */
const QUEUE_TTL_MS = 3000;
let queueCachedAt = 0;
let queueCachedPromise: Promise<QueueResponse | null> | null = null;

export async function getQueue(): Promise<QueueResponse | null> {
  const now = Date.now();
  if (queueCachedPromise && now - queueCachedAt < QUEUE_TTL_MS) {
    return queueCachedPromise;
  }
  queueCachedAt = now;
  queueCachedPromise = request<QueueResponse>('/me/player/queue').catch((err) => {
    // Don't poison the cache on error — let the next caller retry immediately.
    queueCachedPromise = null;
    throw err;
  });
  return queueCachedPromise;
}

/** Invalidate the queue cache. Called after transport mutations (skip / play
 *  new track) so the next read fetches fresh state instead of a stale 3s-old
 *  snapshot. */
export function invalidateQueueCache(): void {
  queueCachedPromise = null;
  queueCachedAt = 0;
}

/** Spotify's cap on `uris` in one play call. */
export const PLAY_URIS_LIMIT = 100;

/** `offsetTrackUri` picks the starting track *inside* the context by URI.
 *  An index-based `offset: { position }` can't be computed correctly from
 *  here: Spotify drops unavailable and local items when it builds the
 *  playback context, so every position past one of them resolves to the
 *  following track, and the final position falls off the end and plays
 *  nothing. A URI is resolved against the context by Spotify itself. */
export async function play(
  uris?: string[],
  contextUri?: string,
  offsetTrackUri?: string,
  deviceId?: string,
): Promise<void> {
  const body: Record<string, unknown> = {};
  if (uris && uris.length > 0) body.uris = uris;
  if (contextUri) body.context_uri = contextUri;
  if (offsetTrackUri) body.offset = { uri: offsetTrackUri };
  const query = deviceId ? `?device_id=${encodeURIComponent(deviceId)}` : '';
  await request(`/me/player/play${query}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: Object.keys(body).length ? JSON.stringify(body) : undefined,
  });
}

interface DevicesResponse {
  devices: SpotifyDevice[];
}

export async function getDevices(): Promise<SpotifyDevice[]> {
  const data = await request<DevicesResponse>('/me/player/devices');
  return data?.devices ?? [];
}

export async function transferPlayback(deviceId: string, startPlaying = false): Promise<void> {
  await request('/me/player', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ device_ids: [deviceId], play: startPlaying }),
  });
}

export interface RecentlyPlayedItem {
  track: NonNullable<SpotifyPlaybackState['item']>;
  played_at: string;
}

interface RecentlyPlayedResponse {
  items: RecentlyPlayedItem[];
}

export async function getRecentlyPlayed(limit = 1): Promise<RecentlyPlayedItem[]> {
  const data = await request<RecentlyPlayedResponse>(`/me/player/recently-played?limit=${limit}`);
  return data?.items ?? [];
}

// All transport endpoints take an optional deviceId so callers can target a
// specific device after a 404 "no active device" — see useSpotify's
// withDeviceFallback for the recovery pattern. Without it, the Web API
// silently fails when Spotify Connect's session has gone idle (typical after
// the user has been away for an hour or more).
export async function pause(deviceId?: string): Promise<void> {
  const query = deviceId ? `?device_id=${encodeURIComponent(deviceId)}` : '';
  await request(`/me/player/pause${query}`, { method: 'PUT' });
}

export async function next(deviceId?: string): Promise<void> {
  const query = deviceId ? `?device_id=${encodeURIComponent(deviceId)}` : '';
  await request(`/me/player/next${query}`, { method: 'POST' });
}

export async function previous(deviceId?: string): Promise<void> {
  const query = deviceId ? `?device_id=${encodeURIComponent(deviceId)}` : '';
  await request(`/me/player/previous${query}`, { method: 'POST' });
}

export async function seek(positionMs: number, deviceId?: string): Promise<void> {
  const dev = deviceId ? `&device_id=${encodeURIComponent(deviceId)}` : '';
  await request(`/me/player/seek?position_ms=${Math.floor(positionMs)}${dev}`, { method: 'PUT' });
}

export async function setVolume(percent: number, deviceId?: string): Promise<void> {
  const clamped = Math.max(0, Math.min(100, Math.floor(percent)));
  const dev = deviceId ? `&device_id=${encodeURIComponent(deviceId)}` : '';
  await request(`/me/player/volume?volume_percent=${clamped}${dev}`, { method: 'PUT' });
}

export async function setShuffle(state: boolean, deviceId?: string): Promise<void> {
  const query = deviceId ? `&device_id=${encodeURIComponent(deviceId)}` : '';
  await request(`/me/player/shuffle?state=${state}${query}`, { method: 'PUT' });
}

export async function setRepeat(
  state: 'off' | 'track' | 'context',
  deviceId?: string,
): Promise<void> {
  const query = deviceId ? `&device_id=${encodeURIComponent(deviceId)}` : '';
  await request(`/me/player/repeat?state=${state}${query}`, { method: 'PUT' });
}

/**
 * Session-scoped set of track URIs the user added to the queue VIA THIS APP.
 * Spotify's API doesn't expose per-track origin in /me/player/queue (manually
 * queued vs context-continuation are indistinguishable), so we have to track
 * our own adds locally. Limitation: tracks queued from the Spotify desktop /
 * mobile clients don't get badged here. Cleared on page reload.
 */
const userQueuedUris = new Set<string>();

/** True if this URI was added to queue via addToQueue() in this session. */
export function wasUserQueued(uri: string): boolean {
  return userQueuedUris.has(uri);
}

/** Custom event fired on `window` after a successful addToQueue. SpotifyQueue
 *  listens so an open queue panel refetches immediately instead of waiting
 *  for the next track-change or panel-reopen. */
export const QUEUE_CHANGED_EVENT = 'av:queue-changed';

/** Append a track to the user's playback queue. The 3-second queue cache in
 *  getQueue() is invalidated so the next read sees the updated queue, and a
 *  window event fires so live queue views can refetch. */
export async function addToQueue(trackUri: string, deviceId?: string): Promise<void> {
  const params = new URLSearchParams({ uri: trackUri });
  if (deviceId) params.set('device_id', deviceId);
  await request(`/me/player/queue?${params.toString()}`, { method: 'POST' });
  userQueuedUris.add(trackUri);
  invalidateQueueCache();
  window.dispatchEvent(new CustomEvent(QUEUE_CHANGED_EVENT));
}

/* ─── Library (saved tracks, follows) ─── */

/**
 * Feb 2026 folded every per-type save endpoint into one `/me/library` that
 * takes Spotify URIs where the old ones took ids. The `/me/tracks` writes and
 * `/me/tracks/contains` still answer for client IDs created before the
 * cutover, and 403 for every ID created since.
 *
 * Which population a given client ID belongs to isn't discoverable without
 * asking, and guessing wrong silently breaks the heart button — it reports
 * success and saves nothing. So: prefer the unified route, and if this
 * account has no such route, remember that and use the legacy path for the
 * rest of the session. Costs one wasted request, once, on old accounts.
 *
 * null = not yet determined.
 */
let unifiedLibraryAvailable: boolean | null = null;

/** 404 means the route doesn't exist for this client ID. A 403 is something
 *  else entirely — usually a missing `user-library-modify` scope — and must
 *  surface rather than be silently retried against a path that will also
 *  fail. */
function isMissingRoute(err: unknown): boolean {
  return String(err).includes('404');
}

function trackUri(id: string): string {
  return `spotify:track:${id}`;
}

/** Try `/me/library`, falling back to whatever the pre-2026 call was. */
async function libraryMutate(
  method: 'PUT' | 'DELETE',
  uris: string[],
  legacy: () => Promise<unknown>,
): Promise<void> {
  if (unifiedLibraryAvailable !== false) {
    try {
      // `uris` goes in the QUERY STRING, not a JSON body. Sending it as a
      // body — any shape: {uris}, {ids}, {items:[{uri}]} — answers 400
      // "Missing required field: uris", which isMissingRoute() correctly
      // declines to treat as a missing route, so it threw past the legacy
      // fallback and every save/unsave failed. The heart button lit up
      // optimistically and snapped straight back, looking like a dead
      // control. Matches GET /me/library/contains, which reads ?uris= too.
      await request(`/me/library?uris=${encodeURIComponent(uris.join(','))}`, { method });
      unifiedLibraryAvailable = true;
      return;
    } catch (err) {
      if (!isMissingRoute(err)) throw err;
      unifiedLibraryAvailable = false;
    }
  }
  await legacy();
}

export async function checkSavedTracks(ids: string[]): Promise<boolean[]> {
  if (ids.length === 0) return [];
  if (unifiedLibraryAvailable !== false) {
    try {
      const uris = ids.map(trackUri).join(',');
      const data = await request<boolean[]>(
        `/me/library/contains?uris=${encodeURIComponent(uris)}`,
      );
      unifiedLibraryAvailable = true;
      return data ?? [];
    } catch (err) {
      if (!isMissingRoute(err)) throw err;
      unifiedLibraryAvailable = false;
    }
  }
  const data = await request<boolean[]>(`/me/tracks/contains?ids=${ids.join(',')}`);
  return data ?? [];
}

export async function saveTrack(id: string): Promise<void> {
  await libraryMutate('PUT', [trackUri(id)], () =>
    request(`/me/tracks?ids=${id}`, { method: 'PUT' }),
  );
}

export async function removeSavedTrack(id: string): Promise<void> {
  await libraryMutate('DELETE', [trackUri(id)], () =>
    request(`/me/tracks?ids=${id}`, { method: 'DELETE' }),
  );
}

/** Test seam: the probe result is module state that would otherwise leak
 *  between cases. Not called by the app. */
export function __resetLibraryProbe(): void {
  unifiedLibraryAvailable = null;
}

/* ─── Liked Songs ─── */

/** Spotify's page cap for GET /me/tracks (playlists allow 100, this doesn't). */
export const SAVED_TRACKS_PAGE = 50;

/**
 * A page of Liked Songs, newest first.
 *
 * This kept the `/me/tracks` path and its `items[].track` key through the Feb
 * 2026 wave — only the *write* side (`PUT`/`DELETE /me/tracks`) and
 * `/me/tracks/contains` moved under `/me/library`. So there's no dual-shape
 * guard here, unlike the playlist reader.
 */
export async function getSavedTracks(
  limit = SAVED_TRACKS_PAGE,
  offset = 0,
): Promise<SavedTracksResponse | null> {
  return request<SavedTracksResponse>(`/me/tracks?limit=${limit}&offset=${offset}`);
}

/* ─── Top items (Stats) ─── */

interface TopItemsResponse<T> {
  items: T[];
  total: number;
  next: string | null;
  offset: number;
}

/** Max /me/top will return in one page. */
export const TOP_ITEMS_LIMIT = 50;

/**
 * Most-played tracks or artists over one of three fixed windows —
 * `short_term` ≈ 4 weeks, `medium_term` ≈ 6 months, `long_term` ≈ all time.
 * Needs the `user-top-read` scope.
 *
 * This is the only listening-history surface Spotify still exposes: the
 * algorithmic feeds and /recommendations went away in Nov 2024, so anything
 * resembling "your music" has to be built from these three lists.
 */
export async function getTopTracks(
  timeRange: TopTimeRange,
  limit = TOP_ITEMS_LIMIT,
): Promise<SpotifyTrack[]> {
  const data = await request<TopItemsResponse<SpotifyTrack>>(
    `/me/top/tracks?time_range=${timeRange}&limit=${limit}`,
  );
  return data?.items ?? [];
}

export async function getTopArtists(
  timeRange: TopTimeRange,
  limit = TOP_ITEMS_LIMIT,
): Promise<SpotifyArtist[]> {
  const data = await request<TopItemsResponse<SpotifyArtist>>(
    `/me/top/artists?time_range=${timeRange}&limit=${limit}`,
  );
  return data?.items ?? [];
}

/* ─── Playlist lifecycle ─── */

/**
 * Create a playlist owned by the signed-in user.
 *
 * Feb 2026 moved this off `POST /users/{user_id}/playlists`, which now 403s —
 * the owner is taken from the token instead of the path.
 */
export async function createPlaylist(
  name: string,
  description?: string,
  isPublic = false,
): Promise<SpotifyPlaylist | null> {
  return request<SpotifyPlaylist>('/me/playlists', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, description: description ?? '', public: isPublic }),
  });
}

/** Rename / re-describe / flip visibility. Answers 200 with an empty body. */
export async function changePlaylistDetails(
  playlistId: string,
  details: { name?: string; description?: string; public?: boolean },
): Promise<void> {
  await request(`/playlists/${playlistId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(details),
  });
}

/**
 * Move `rangeLength` items starting at `rangeStart` so they land before
 * `insertBefore`.
 *
 * The indices are positions in the playlist as Spotify holds it, not in our
 * filtered `tracks` array — those diverge as soon as a null entry (a removed
 * or local-only track) is dropped on read, so callers must map back to the
 * raw position rather than passing a row index.
 *
 * `snapshotId` makes this a no-op instead of a scramble if the playlist moved
 * under us between read and write.
 */
export async function reorderPlaylistItems(
  playlistId: string,
  rangeStart: number,
  insertBefore: number,
  snapshotId?: string | null,
  rangeLength = 1,
): Promise<string | null> {
  const body: Record<string, unknown> = {
    range_start: rangeStart,
    insert_before: insertBefore,
    range_length: rangeLength,
  };
  if (snapshotId) body.snapshot_id = snapshotId;
  const data = await request<SnapshotResponse>(`/playlists/${playlistId}/items`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return data?.snapshot_id ?? null;
}

/**
 * Remove a playlist from the user's library.
 *
 * Spotify has never had "delete a playlist" — unfollowing your own playlist
 * is how deletion works, and it's what the desktop client's Delete does. Feb
 * 2026 folded `DELETE /playlists/{id}/followers` into the unified
 * `DELETE /me/library`, which takes URIs rather than ids.
 */
export async function unfollowPlaylist(playlistUri: string): Promise<void> {
  const id = playlistUri.split(':').pop() ?? '';
  await libraryMutate('DELETE', [playlistUri], () =>
    request(`/playlists/${id}/followers`, { method: 'DELETE' }),
  );
}

/* ─── Albums (saved + detail) ─── */

export interface SavedAlbumsResponse {
  items: Array<{ added_at: string; album: SpotifyAlbum }>;
  total: number;
  next: string | null;
  offset: number;
}

export async function getSavedAlbums(limit = 50, offset = 0): Promise<SavedAlbumsResponse | null> {
  return request<SavedAlbumsResponse>(`/me/albums?limit=${limit}&offset=${offset}`);
}

/** Album with its full track listing inlined. */
export interface AlbumWithTracks extends SpotifyAlbum {
  tracks: { items: SpotifyTrack[]; total: number; next: string | null; offset: number };
  release_date?: string;
  total_tracks?: number;
}

export async function getAlbum(id: string): Promise<AlbumWithTracks | null> {
  return request<AlbumWithTracks>(`/albums/${id}`);
}

/* ─── Artists ─── */

/**
 * One artist by id.
 *
 * The batch `GET /artists` went away in Feb 2026, so this is per-id only —
 * fine here, since the artist page opens one at a time. `genres`,
 * `popularity` and `followers` may all come back absent on a post-cutover
 * client ID; the view treats each as optional rather than showing zeros.
 */
export async function getArtist(id: string): Promise<SpotifyArtist | null> {
  return request<SpotifyArtist>(`/artists/${id}`);
}

interface ArtistAlbumsResponse {
  items: SpotifyAlbum[];
  total: number;
  next: string | null;
}

/**
 * An artist's own releases, newest first.
 *
 * This is what makes an artist page possible at all: `/artists/{id}/top-tracks`
 * and `/artists/{id}/related-artists` were both removed, so a discography
 * list is the only substantial thing left to show.
 *
 * `include_groups` excludes `appears_on` and `compilation`, which otherwise
 * bury an artist's own records under every playlist compilation they were
 * ever licensed to.
 */
export async function getArtistAlbums(id: string, limit = 50): Promise<SpotifyAlbum[]> {
  const params = new URLSearchParams({
    include_groups: 'album,single',
    limit: String(limit),
  });
  const data = await request<ArtistAlbumsResponse>(`/artists/${id}/albums?${params.toString()}`);
  const items = data?.items ?? [];
  // Spotify returns these roughly grouped by type, not by date.
  return [...items].sort((a, b) => (b.release_date ?? '').localeCompare(a.release_date ?? ''));
}

/* ─── Search ─── */

/** Spotify sometimes emits `null` entries in the `playlists` and `albums`
 *  arrays (long-standing API quirk — deleted or region-blocked items come
 *  back as holes rather than being omitted). Typed honestly so callers are
 *  forced to filter instead of crashing on `.name` of null. */
export interface SpotifySearchResponse {
  tracks?: { items: Array<SpotifyTrack | null>; total: number };
  artists?: { items: Array<SpotifyArtist | null>; total: number };
  albums?: { items: Array<SpotifyAlbum | null>; total: number };
  playlists?: { items: Array<SpotifyPlaylist | null>; total: number };
}

export type SearchType = 'track' | 'artist' | 'album' | 'playlist';

/** Items fetched per type per /search call. */
export const SEARCH_PAGE_SIZE = 20;
/** Spotify rejects offset+limit past this, so paging stops here. */
export const SEARCH_MAX_OFFSET = 1000;

/** `offset` pages within a type; Spotify caps offset+limit at 1000.
 *  `signal` lets a caller drop a response the user has already typed past —
 *  the fetch in `request()` receives it via the spread options. */
export async function search(
  q: string,
  types: SearchType[] = ['track'],
  limit = 20,
  offset = 0,
  signal?: AbortSignal,
): Promise<SpotifySearchResponse | null> {
  const params = new URLSearchParams({
    q,
    type: types.join(','),
    limit: String(limit),
    offset: String(offset),
  });
  return request<SpotifySearchResponse>(`/search?${params.toString()}`, { signal });
}

/** Null-filtered, flattened search results with per-type totals so the UI can
 *  label tabs and decide whether another page exists. */
export interface SearchResults {
  tracks: SpotifyTrack[];
  artists: SpotifyArtist[];
  albums: SpotifyAlbum[];
  playlists: SpotifyPlaylist[];
  totals: Record<SearchType, number>;
}

export function emptySearchResults(): SearchResults {
  return {
    tracks: [],
    artists: [],
    albums: [],
    playlists: [],
    totals: { track: 0, artist: 0, album: 0, playlist: 0 },
  };
}

function present<T>(items: Array<T | null> | undefined): T[] {
  return (items ?? []).filter((it): it is T => it !== null);
}

/** Normalize a raw /search body into `SearchResults`. Types absent from the
 *  response stay empty — so this works for both the all-types first page and
 *  a single-type "load more" page. */
export function toSearchResults(res: SpotifySearchResponse | null): SearchResults {
  const out = emptySearchResults();
  if (!res) return out;
  out.tracks = present(res.tracks?.items);
  out.artists = present(res.artists?.items);
  out.albums = present(res.albums?.items);
  out.playlists = present(res.playlists?.items);
  out.totals = {
    track: res.tracks?.total ?? 0,
    artist: res.artists?.total ?? 0,
    album: res.albums?.total ?? 0,
    playlist: res.playlists?.total ?? 0,
  };
  return out;
}

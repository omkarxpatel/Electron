/**
 * Thin Spotify Web API client. All calls go through `request()` which
 * attaches the bearer token, handles 401s (single retry after token
 * refresh), and parses JSON.
 */

import { getValidAccessToken, refreshAccessToken } from './auth';
import type {
  SpotifyAlbum,
  SpotifyArtist,
  SpotifyDevice,
  SpotifyPlaylist,
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
    `/playlists/${playlistId}/tracks?limit=${limit}&offset=${offset}`,
  );
  if (!data) throw new Error('Empty tracks response');
  return data;
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

export async function play(
  uris?: string[],
  contextUri?: string,
  offsetIdx?: number,
  deviceId?: string,
): Promise<void> {
  const body: Record<string, unknown> = {};
  if (uris && uris.length > 0) body.uris = uris;
  if (contextUri) body.context_uri = contextUri;
  if (typeof offsetIdx === 'number') body.offset = { position: offsetIdx };
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

/* ─── Library (saved tracks) ─── */

export async function checkSavedTracks(ids: string[]): Promise<boolean[]> {
  if (ids.length === 0) return [];
  const data = await request<boolean[]>(`/me/tracks/contains?ids=${ids.join(',')}`);
  return data ?? [];
}

export async function saveTrack(id: string): Promise<void> {
  await request(`/me/tracks?ids=${id}`, { method: 'PUT' });
}

export async function removeSavedTrack(id: string): Promise<void> {
  await request(`/me/tracks?ids=${id}`, { method: 'DELETE' });
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

/* ─── Search ─── */

export interface SpotifySearchResponse {
  tracks?: { items: SpotifyTrack[]; total: number };
  artists?: { items: SpotifyArtist[]; total: number };
  albums?: { items: SpotifyAlbum[]; total: number };
  playlists?: { items: SpotifyPlaylist[]; total: number };
}

export async function search(
  q: string,
  types: Array<'track' | 'artist' | 'album' | 'playlist'> = ['track'],
  limit = 20,
): Promise<SpotifySearchResponse | null> {
  const params = new URLSearchParams({
    q,
    type: types.join(','),
    limit: String(limit),
  });
  return request<SpotifySearchResponse>(`/search?${params.toString()}`);
}

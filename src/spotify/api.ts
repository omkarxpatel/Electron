/**
 * Thin Spotify Web API client. All calls go through `request()` which
 * attaches the bearer token, handles 401s (single retry after token
 * refresh), and parses JSON.
 */

import { getValidAccessToken, refreshAccessToken } from './auth';
import type {
  SpotifyPlaylistsResponse,
  SpotifyPlaylistTracksResponse,
  SpotifyPlaybackState,
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

export async function play(uris?: string[], contextUri?: string, offsetIdx?: number): Promise<void> {
  const body: Record<string, unknown> = {};
  if (uris && uris.length > 0) body.uris = uris;
  if (contextUri) body.context_uri = contextUri;
  if (typeof offsetIdx === 'number') body.offset = { position: offsetIdx };
  await request('/me/player/play', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: Object.keys(body).length ? JSON.stringify(body) : undefined,
  });
}

export async function pause(): Promise<void> {
  await request('/me/player/pause', { method: 'PUT' });
}

export async function next(): Promise<void> {
  await request('/me/player/next', { method: 'POST' });
}

export async function previous(): Promise<void> {
  await request('/me/player/previous', { method: 'POST' });
}

export async function seek(positionMs: number): Promise<void> {
  await request(`/me/player/seek?position_ms=${Math.floor(positionMs)}`, { method: 'PUT' });
}

export async function setVolume(percent: number): Promise<void> {
  const clamped = Math.max(0, Math.min(100, Math.floor(percent)));
  await request(`/me/player/volume?volume_percent=${clamped}`, { method: 'PUT' });
}

export async function setShuffle(state: boolean): Promise<void> {
  await request(`/me/player/shuffle?state=${state}`, { method: 'PUT' });
}

export async function setRepeat(state: 'off' | 'track' | 'context'): Promise<void> {
  await request(`/me/player/repeat?state=${state}`, { method: 'PUT' });
}

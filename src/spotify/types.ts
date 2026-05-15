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
  tracks: { total: number };
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
  track: SpotifyTrack | null;
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

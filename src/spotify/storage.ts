/**
 * Persists Spotify credentials in localStorage. Single source of truth — every
 * other Spotify module reads/writes through here.
 *
 * Note: localStorage is fine for a local-only personal app. A more secure
 * approach (macOS Keychain via the main process) is a follow-up.
 */

const KEY_CLIENT_ID = 'av.spotify.clientId';
const KEY_REFRESH_TOKEN = 'av.spotify.refreshToken';
const KEY_ACCESS_TOKEN = 'av.spotify.accessToken';
const KEY_TOKEN_EXPIRY = 'av.spotify.tokenExpiry';

export function getClientId(): string | null {
  return localStorage.getItem(KEY_CLIENT_ID);
}

export function setClientId(id: string): void {
  localStorage.setItem(KEY_CLIENT_ID, id.trim());
}

export function clearClientId(): void {
  localStorage.removeItem(KEY_CLIENT_ID);
}

export interface StoredTokens {
  accessToken: string;
  refreshToken: string;
  /** Epoch ms when accessToken expires */
  expiresAt: number;
}

export function getTokens(): StoredTokens | null {
  const accessToken = localStorage.getItem(KEY_ACCESS_TOKEN);
  const refreshToken = localStorage.getItem(KEY_REFRESH_TOKEN);
  const expiresAtStr = localStorage.getItem(KEY_TOKEN_EXPIRY);
  if (!refreshToken) return null;
  const expiresAt = expiresAtStr ? Number(expiresAtStr) : 0;
  return { accessToken: accessToken ?? '', refreshToken, expiresAt };
}

export function setTokens(t: StoredTokens): void {
  localStorage.setItem(KEY_ACCESS_TOKEN, t.accessToken);
  localStorage.setItem(KEY_REFRESH_TOKEN, t.refreshToken);
  localStorage.setItem(KEY_TOKEN_EXPIRY, String(t.expiresAt));
}

export function updateAccessToken(accessToken: string, expiresAt: number): void {
  localStorage.setItem(KEY_ACCESS_TOKEN, accessToken);
  localStorage.setItem(KEY_TOKEN_EXPIRY, String(expiresAt));
}

export function clearTokens(): void {
  localStorage.removeItem(KEY_ACCESS_TOKEN);
  localStorage.removeItem(KEY_REFRESH_TOKEN);
  localStorage.removeItem(KEY_TOKEN_EXPIRY);
}

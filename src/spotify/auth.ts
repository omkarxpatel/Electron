/**
 * Spotify OAuth via PKCE — desktop-app safe (no client secret).
 * https://developer.spotify.com/documentation/web-api/tutorials/code-pkce-flow
 */

import { getClientId, setTokens, updateAccessToken, getTokens, clearTokens, type StoredTokens } from './storage';

export const REDIRECT_URI = 'http://127.0.0.1:8888/callback';

export const SCOPES = [
  'user-read-playback-state',
  'user-modify-playback-state',
  'user-read-currently-playing',
  'playlist-read-private',
  'playlist-read-collaborative',
  'user-library-read',
  // Required to save / unsave the current track (PUT/DELETE /me/tracks).
  'user-library-modify',
].join(' ');

const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const AUTH_URL = 'https://accounts.spotify.com/authorize';

/** Generate a cryptographically-random URL-safe code verifier (43-128 chars). */
function generateCodeVerifier(): string {
  const bytes = new Uint8Array(64);
  crypto.getRandomValues(bytes);
  return base64url(bytes);
}

/** SHA-256(verifier), base64url-encoded — the PKCE challenge. */
async function generateCodeChallenge(verifier: string): Promise<string> {
  const data = new TextEncoder().encode(verifier);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return base64url(new Uint8Array(digest));
}

function base64url(buf: Uint8Array): string {
  let s = '';
  for (let i = 0; i < buf.length; i++) s += String.fromCharCode(buf[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomState(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return base64url(bytes);
}

/**
 * Runs the full OAuth flow:
 *   1. Generate PKCE verifier + challenge.
 *   2. Tell the main process to start listening on 127.0.0.1:8888.
 *   3. Open the user's browser to the Spotify consent page.
 *   4. Wait for the callback with `code`.
 *   5. Exchange `code` + verifier for refresh + access tokens.
 *   6. Persist tokens.
 *
 * Returns the resulting access token on success; throws on failure.
 */
export async function authorize(): Promise<string> {
  const clientId = getClientId();
  if (!clientId) throw new Error('No Spotify Client ID configured');

  const verifier = generateCodeVerifier();
  const challenge = await generateCodeChallenge(verifier);
  const state = randomState();

  const authUrl =
    `${AUTH_URL}?` +
    new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      scope: SCOPES,
      redirect_uri: REDIRECT_URI,
      code_challenge_method: 'S256',
      code_challenge: challenge,
      state,
      // Force the consent screen on every authorize. Without this, Spotify
      // silently re-uses a previous approval — which means newly-added
      // scopes (e.g. user-library-modify) are not granted unless the user
      // explicitly re-consents. The one-tap consent prompt is a small UX
      // cost in exchange for reliable scope upgrades.
      show_dialog: 'true',
    }).toString();

  // Start the local server first so the callback can be received the
  // instant the user finishes consenting in their browser.
  const callbackPromise = window.api.spotifyAuth.listenForCallback(state);
  await window.api.shell.openExternal(authUrl);

  const { code } = await callbackPromise;

  const tokens = await exchangeCodeForTokens(clientId, code, verifier);
  setTokens(tokens);
  return tokens.accessToken;
}

async function exchangeCodeForTokens(
  clientId: string,
  code: string,
  verifier: string,
): Promise<StoredTokens> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT_URI,
    client_id: clientId,
    code_verifier: verifier,
  });

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token exchange failed (${res.status}): ${text}`);
  }

  const data = (await res.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
}

/**
 * Trade the refresh token for a fresh access token. Spotify may also rotate
 * the refresh token in the response; if it does, we save the new one.
 * Returns the new access token.
 *
 * Mutex: when multiple Spotify requests fail with 401 simultaneously they all
 * call refreshAccessToken. Without a mutex they'd each POST /token; Spotify
 * could rotate the refresh token, and whichever response landed last would
 * win — but the earlier responses' stored tokens would already be obsolete.
 * Net effect: forced re-auth on the next request. We coalesce concurrent
 * callers onto a single in-flight promise.
 */
let refreshing: Promise<string> | null = null;

export function refreshAccessToken(): Promise<string> {
  if (refreshing) return refreshing;
  refreshing = doRefresh().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

async function doRefresh(): Promise<string> {
  const clientId = getClientId();
  if (!clientId) throw new Error('No Spotify Client ID configured');

  const stored = getTokens();
  if (!stored?.refreshToken) throw new Error('No refresh token — re-auth required');

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: stored.refreshToken,
    client_id: clientId,
  });

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    // 400 invalid_grant means the refresh token was revoked
    if (res.status === 400) clearTokens();
    throw new Error(`Token refresh failed (${res.status}): ${text}`);
  }

  const data = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  };

  const expiresAt = Date.now() + data.expires_in * 1000;

  if (data.refresh_token) {
    setTokens({
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt,
    });
  } else {
    updateAccessToken(data.access_token, expiresAt);
  }

  return data.access_token;
}

/**
 * Returns a valid access token, refreshing if it's expired (or expires
 * within the next 30 seconds). Throws if no refresh token is available.
 */
export async function getValidAccessToken(): Promise<string> {
  const stored = getTokens();
  if (!stored) throw new Error('Not authenticated');
  if (stored.accessToken && stored.expiresAt > Date.now() + 30_000) {
    return stored.accessToken;
  }
  return refreshAccessToken();
}

export function isAuthenticated(): boolean {
  const stored = getTokens();
  return Boolean(stored?.refreshToken);
}

export function disconnect(): void {
  clearTokens();
}

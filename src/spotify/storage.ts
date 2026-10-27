/**
 * Persists Spotify credentials in localStorage. Single source of truth — every
 * other Spotify module reads/writes through here.
 *
 * Note: localStorage is fine for a local-only personal app. A more secure
 * approach (macOS Keychain via the main process) is a follow-up.
 */

const KEY_CLIENT_ID = 'av.spotify.clientId';
const KEY_LAST_PLAYLIST = 'av.spotify.lastPlaylistId';

/** The whole credential set, as one JSON value. See setTokens. */
const KEY_TOKENS = 'av.spotify.tokens.v1';

// The shape before KEY_TOKENS existed: one key per field. Still read, so an
// upgrade doesn't sign anyone out, and cleared whenever the new key is
// written or the user disconnects. The capture harness seeds this shape too
// (scripts/capture/shim.js), so the fallback is not only for old profiles.
const KEY_REFRESH_TOKEN = 'av.spotify.refreshToken';
const KEY_ACCESS_TOKEN = 'av.spotify.accessToken';
const KEY_TOKEN_EXPIRY = 'av.spotify.tokenExpiry';

/**
 * Write a key, best effort. `setItem` throws synchronously once the origin's
 * ~5 MB quota is exhausted — also in private mode, and on some disk errors —
 * and no credential is worth taking a click handler down over. Returns false
 * if the value did not land, which the token path needs to know.
 */
function write(key: string, value: string): boolean {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch (err) {
    console.error('spotify/storage: persist failed', key, err);
    return false;
  }
}

/** Same, for removal. `removeItem` frees space rather than needing it, so it
 *  throws far more rarely — but not never, and a throw out of disconnect()
 *  would leave the UI mid-sign-out. */
function erase(...keys: string[]): void {
  try {
    for (const key of keys) localStorage.removeItem(key);
  } catch (err) {
    console.error('spotify/storage: clear failed', err);
  }
}

export function getClientId(): string | null {
  // Normalize empty/whitespace to null. A stored '' would otherwise read as
  // "set" to the onboarding gate but falsy to connect(), stranding the user on
  // the authorize screen with no way back to the Client ID input.
  const id = localStorage.getItem(KEY_CLIENT_ID)?.trim();
  return id ? id : null;
}

export function setClientId(id: string): void {
  // If this is refused the user is told nothing, because there is nothing
  // they can do about it — but getClientId reads back null, so connect()
  // leaves them on the onboarding pane rather than half-authorized.
  write(KEY_CLIENT_ID, id.trim());
}

export function clearClientId(): void {
  erase(KEY_CLIENT_ID);
}

/** Last playlist the user opened, restored on the next launch. Only the id is
 *  kept — name, cover and track count are re-fetched so a renamed or
 *  re-covered playlist doesn't come back stale. */
export function getLastPlaylistId(): string | null {
  const id = localStorage.getItem(KEY_LAST_PLAYLIST)?.trim();
  return id ? id : null;
}

export function setLastPlaylistId(id: string): void {
  // Losing this costs the user one click next launch, nothing more.
  write(KEY_LAST_PLAYLIST, id);
}

export function clearLastPlaylistId(): void {
  erase(KEY_LAST_PLAYLIST);
}

export interface StoredTokens {
  accessToken: string;
  refreshToken: string;
  /** Epoch ms when accessToken expires */
  expiresAt: number;
}

/**
 * The newest set, held here only while localStorage is refusing it. Normally
 * null: a successful write clears it.
 *
 * It exists because Spotify ROTATES refresh tokens. If the write of a
 * just-refreshed set fails and we go on reading the stored copy, the next
 * call refreshes with the token the rotation already invalidated, Spotify
 * answers 400, and doRefresh calls clearTokens — a real sign-out caused by a
 * full disk. Preferring the in-memory set downgrades that to "signed out
 * after the next restart", which is all a storage failure should ever cost.
 */
let unpersisted: StoredTokens | null = null;

export function getTokens(): StoredTokens | null {
  if (unpersisted) return unpersisted;
  const current = readTokenSet();
  if (current) return current;
  // Fall back to the pre-KEY_TOKENS shape. Without this every existing user
  // is signed out by the upgrade, which is worse than the tearing it fixes.
  const accessToken = localStorage.getItem(KEY_ACCESS_TOKEN);
  const refreshToken = localStorage.getItem(KEY_REFRESH_TOKEN);
  const expiresAtStr = localStorage.getItem(KEY_TOKEN_EXPIRY);
  if (!refreshToken) return null;
  const expiresAt = expiresAtStr ? Number(expiresAtStr) : 0;
  return { accessToken: accessToken ?? '', refreshToken, expiresAt };
}

function readTokenSet(): StoredTokens | null {
  try {
    const raw = localStorage.getItem(KEY_TOKENS);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredTokens>;
    // A set with no refresh token is not a session, and reading it as one
    // sends the app into a refresh it can't perform.
    if (typeof parsed?.refreshToken !== 'string' || !parsed.refreshToken) return null;
    return {
      accessToken: typeof parsed.accessToken === 'string' ? parsed.accessToken : '',
      refreshToken: parsed.refreshToken,
      expiresAt: typeof parsed.expiresAt === 'number' ? parsed.expiresAt : 0,
    };
  } catch {
    // Absent, corrupt, or localStorage unavailable. Let the legacy keys
    // answer; if they can't either, getTokens returns null and the user
    // re-authorizes.
    return null;
  }
}

/**
 * Replace the whole credential set.
 *
 * One key, one `setItem`, because the three fields used to go out as three
 * calls and a quota throw on the second or third left a fresh access token
 * beside a stale expiry — or an access token with no refresh token at all.
 * Either set looks expired on every read, so every call refreshes; and since
 * Spotify rotates refresh tokens, the second of those refreshes 400s and
 * signs the user out for real. A single write can only succeed or leave the
 * previous set exactly as it was, which is stale but never inconsistent.
 */
export function setTokens(t: StoredTokens): void {
  if (write(KEY_TOKENS, JSON.stringify(t))) {
    unpersisted = null;
    // The old keys are a second, now-stale copy of the credentials, and
    // getTokens falls back to them — so leaving them behind would resurrect
    // a dead session after a disconnect.
    erase(KEY_ACCESS_TOKEN, KEY_REFRESH_TOKEN, KEY_TOKEN_EXPIRY);
    return;
  }
  unpersisted = t;
}

export function updateAccessToken(accessToken: string, expiresAt: number): void {
  const current = getTokens();
  // Only reached from doRefresh, which has already proved a refresh token
  // exists. With nothing to merge into there is nothing to update either:
  // storing an access token on its own recreates the torn state above.
  if (!current) return;
  setTokens({ ...current, accessToken, expiresAt });
}

export function clearTokens(): void {
  unpersisted = null;
  erase(KEY_TOKENS, KEY_ACCESS_TOKEN, KEY_REFRESH_TOKEN, KEY_TOKEN_EXPIRY);
}

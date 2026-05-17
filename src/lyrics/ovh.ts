/**
 * api.lyrics.ovh — free, no-auth, plain-text lyrics.
 *
 * Endpoint: GET /v1/{artist}/{title}
 *   200 → { lyrics: "..." }
 *   404 → { error: "No lyrics found" }
 *
 * Why we use this alongside lrclib: lyrics.ovh responds in ~500–900 ms
 * consistently, while lrclib (which has synced lyrics) is frequently 8–15 s
 * or worse. Showing plain lyrics fast then upgrading to synced is the best
 * UX trade-off available with public free APIs.
 *
 * Cons vs lrclib: plain text only (no LRC timestamps), no instrumental flag,
 * occasionally misses tracks lrclib has.
 */

const TIMEOUT_MS = 5000;

export async function fetchOvhLyrics(
  title: string,
  artist: string,
  externalSignal?: AbortSignal,
): Promise<string | null> {
  // Encode each path segment individually so slashes inside the title or
  // artist (rare but possible) don't confuse the API's routing.
  const url = `https://api.lyrics.ovh/v1/${encodeURIComponent(artist)}/${encodeURIComponent(title)}`;

  const ctrl = new AbortController();
  const timer = window.setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const onExternalAbort = () => ctrl.abort();
  externalSignal?.addEventListener('abort', onExternalAbort);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) return null;
    const body = (await res.json()) as { lyrics?: string };
    const lyrics = body.lyrics?.trim();
    return lyrics && lyrics.length > 0 ? lyrics : null;
  } catch {
    return null;
  } finally {
    window.clearTimeout(timer);
    externalSignal?.removeEventListener('abort', onExternalAbort);
  }
}

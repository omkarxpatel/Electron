import type { SpotifyImage } from '../spotify/types';

/** Pick a small thumbnail (last entry — Spotify orders largest first). */
export function smallestImage(images: SpotifyImage[] | undefined): string | undefined {
  if (!images || images.length === 0) return undefined;
  return images[images.length - 1]?.url;
}

/** Same as smallestImage but returns the SpotifyImage rather than just the URL,
 *  for callers that also want width/height. */
export function pickSmallestImage(images: SpotifyImage[] | undefined): SpotifyImage | null {
  if (!images || images.length === 0) return null;
  return images[images.length - 1] ?? null;
}

/** Pick a mid-size cover (Spotify's second image is usually ~300px). */
export function pickMediumImage(images: SpotifyImage[] | undefined): string | undefined {
  if (!images || images.length === 0) return undefined;
  return images[1]?.url ?? images[0]?.url;
}

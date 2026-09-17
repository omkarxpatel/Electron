import { useEffect, useRef, useState } from 'react';
import type { Palette } from './palettes';
import { extractPaletteFromUrl } from './extractPalette';

/**
 * Hook that resolves a synthesized Palette from an album-art image URL.
 *
 * Returns null when:
 *   - `enabled` is false (toggle off)
 *   - `imageUrl` is null/empty
 *   - extraction is still in flight for the current URL
 *   - extraction failed (CORS, decode, etc.)
 *
 * Successful extractions are cached by URL in a module-scope LRU (last 50
 * tracks). Switching back to a recently-seen track avoids re-downloading +
 * re-sampling the image.
 */

const CACHE_MAX = 50;
// Map iteration order = insertion order, so re-inserting on hit acts as LRU.
const paletteCache = new Map<string, Palette>();

function cacheGet(url: string): Palette | null {
  const hit = paletteCache.get(url);
  if (!hit) return null;
  // Refresh LRU position.
  paletteCache.delete(url);
  paletteCache.set(url, hit);
  return hit;
}

function cacheSet(url: string, palette: Palette): void {
  if (paletteCache.has(url)) paletteCache.delete(url);
  paletteCache.set(url, palette);
  while (paletteCache.size > CACHE_MAX) {
    const oldest = paletteCache.keys().next().value;
    if (oldest === undefined) break;
    paletteCache.delete(oldest);
  }
}

export function useAlbumPalette(
  imageUrl: string | null | undefined,
  enabled: boolean,
): Palette | null {
  const [palette, setPalette] = useState<Palette | null>(() => {
    if (!enabled || !imageUrl) return null;
    return cacheGet(imageUrl);
  });
  // Tracks the URL currently being extracted so a late resolve from a
  // previous URL doesn't clobber the current state.
  const inflightUrlRef = useRef<string | null>(null);

  useEffect(() => {
    if (!enabled || !imageUrl) {
      inflightUrlRef.current = null;
      setPalette(null);
      return;
    }
    const cached = cacheGet(imageUrl);
    if (cached) {
      inflightUrlRef.current = null;
      setPalette(cached);
      return;
    }
    // Don't flash to null on a re-extraction — keep the previous palette
    // until the new one is ready, so the UI doesn't jump to the user's
    // base palette for a frame.
    inflightUrlRef.current = imageUrl;
    let cancelled = false;
    extractPaletteFromUrl(imageUrl).then((p) => {
      if (cancelled) return;
      // Stale extraction (a newer URL was requested while this was running).
      if (inflightUrlRef.current !== imageUrl) return;
      inflightUrlRef.current = null;
      if (p) {
        cacheSet(imageUrl, p);
        setPalette(p);
      } else {
        // Extraction failed — fall back to user palette.
        setPalette(null);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [imageUrl, enabled]);

  return palette;
}

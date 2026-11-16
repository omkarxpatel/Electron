import { useCallback, useEffect, useRef, useState } from 'react';
import type { Palette } from './palettes';
import { mixPalettes } from './palettes';
import { extractPaletteFromUrl } from './extractPalette';

/**
 * Hook that resolves a synthesized Palette from an album-art image URL.
 *
 * Returns null when there is no album tint to apply — the toggle is off, or
 * the colors have settled back on `basePalette`, which the caller already
 * has. A null return is "nothing to override with", never "mid-change".
 *
 * Successful extractions are cached by URL in a module-scope LRU (last 50
 * tracks). Switching back to a recently-seen track avoids re-downloading +
 * re-sampling the image.
 *
 * One track's colors do not cut to the next one's — the hook holds a
 * separate "shown" palette that ramps from wherever it currently is to the
 * newly extracted one. Everything downstream (the render worker, the EQ
 * ombre, the --accent CSS vars) reads that single value, so the whole app
 * changes theme together instead of one surface at a time.
 */

/** How long one theme takes to become the next. Long enough to read as a
 *  fade rather than a cut, short enough that the new track's colors are
 *  established well inside its intro. 900ms read as a flicker: most of a
 *  smoothstep's movement lands in its middle third, so the eye only ever
 *  saw ~300ms of it. Matched to AlbumBackdrop's dissolve so the wash and
 *  the accent colors travel together. */
const FADE_MS = 2200;
/** Ceiling on how often the fade emits. Each emission re-renders the visual
 *  chain and posts the palette to the render worker, so matching a 120 Hz
 *  display would buy a smoothness nobody can see in a slow color ramp at
 *  four times the cost. */
const FADE_HZ = 30;

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
  /** The palette the app wears with no album tint — the user's choice from
   *  Settings. Needed here, not just in the caller, because "no tint" is one
   *  end of the ramp: without a color for it the hook had to cut. Must be
   *  referentially stable (memoize it) or every render restarts the ramp. */
  basePalette: Palette,
): Palette | null {
  const initial = () => {
    if (!enabled || !imageUrl) return null;
    return cacheGet(imageUrl);
  };
  // What extraction has resolved to, and what is actually on screen. They
  // differ only while a fade is in flight.
  const [target, setPalette] = useState<Palette | null>(initial);
  const [shown, setShownState] = useState<Palette | null>(initial);
  // Mirrored in a ref so a fade can read where the colors currently are
  // without depending on `shown` — a dependency there would restart the fade
  // on its own output.
  const shownRef = useRef<Palette | null>(shown);
  const setShown = useCallback((p: Palette | null) => {
    shownRef.current = p;
    setShownState(p);
  }, []);
  // Whether the last ramp ended on album art. Two non-album endpoints in a
  // row means `basePalette` itself changed — the user moving a color picker
  // in Settings, which has to land under their finger, not ramp for two
  // seconds.
  const lastWasAlbumRef = useRef(false);
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

  useEffect(() => {
    // "No album palette" is not an absence of color — the app wears
    // `basePalette` instead — so it is an endpoint like any other and the
    // ramp travels to and from it. Treating it as nothing is what made a
    // cover the extractor rejects (a monochrome sleeve clears every bucket
    // and returns null) cut the whole UI to the Settings palette, and then
    // cut a second time on the next track, because a null `from` left the
    // next ramp with nowhere to start.
    const to = enabled ? target ?? basePalette : null;
    const from = shownRef.current;
    if (from === to) return;
    const toAlbum = enabled && target !== null;
    const fromAlbum = lastWasAlbumRef.current;
    lastWasAlbumRef.current = toAlbum;
    // Nothing to ramp between: the first palette of the session, the toggle
    // being switched off, or the user's own palette being edited in Settings
    // while nothing is tinting — all deliberate, where an instant answer is
    // the right one.
    if (!from || !to || from.id === to.id || (!toAlbum && !fromAlbum)) {
      setShown(to);
      return;
    }
    let raf = 0;
    let start = 0;
    let lastEmit = 0;
    const step = (now: number) => {
      if (start === 0) start = now;
      const t = Math.min(1, (now - start) / FADE_MS);
      if (t >= 1) {
        // Land on the target object itself, not a mix at t=1, so the id and
        // every value downstream match what a cut would have produced.
        setShown(to);
        return;
      }
      if (now - lastEmit >= 1000 / FADE_HZ) {
        lastEmit = now;
        setShown(mixPalettes(from, to, t * t * (3 - 2 * t)));
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
    // A track change mid-fade re-runs this, and `from` is read fresh from the
    // ref, so the new ramp starts at the blend currently on screen rather
    // than snapping back to the previous track's colors first.
  }, [target, enabled, basePalette, setShown]);

  // Null means "no override" to every caller — the visualizer, the notch
  // bridge and the accent vars all substitute the same `basePalette` we just
  // ramped onto, so handing it back would say "override" for a color that is
  // already theirs. The ramp away from album art is still reported, one mix
  // at a time, right up until it lands.
  return shown === basePalette ? null : shown;
}

import type { PaletteId } from '../state/settings';

export interface PaletteStop {
  pos: number;
  color: string;
}

export interface Palette {
  id: PaletteId;
  label: string;
  stops: PaletteStop[];
  glowColor: string;
  /** background radial-glow tint for the stage */
  ambient: string;
}

export const PALETTES: Record<PaletteId, Palette> = {
  aurora: {
    id: 'aurora',
    label: 'Aurora',
    stops: [
      { pos: 0, color: '#a78bfa' },
      { pos: 0.5, color: '#22d3ee' },
      { pos: 1, color: '#2dd4bf' },
    ],
    glowColor: '#22d3ee',
    ambient: 'rgba(34, 211, 238, 0.18)',
  },
  sunset: {
    id: 'sunset',
    label: 'Sunset',
    stops: [
      { pos: 0, color: '#fde68a' },
      { pos: 0.35, color: '#f59e0b' },
      { pos: 0.7, color: '#ec4899' },
      { pos: 1, color: '#8b5cf6' },
    ],
    glowColor: '#ec4899',
    ambient: 'rgba(236, 72, 153, 0.18)',
  },
  neon: {
    id: 'neon',
    label: 'Neon',
    stops: [
      { pos: 0, color: '#ec4899' },
      { pos: 0.5, color: '#06b6d4' },
      { pos: 1, color: '#84cc16' },
    ],
    glowColor: '#06b6d4',
    ambient: 'rgba(6, 182, 212, 0.18)',
  },
  fire: {
    id: 'fire',
    label: 'Fire',
    stops: [
      { pos: 0, color: '#fef3c7' },
      { pos: 0.35, color: '#fbbf24' },
      { pos: 0.7, color: '#ef4444' },
      { pos: 1, color: '#7f1d1d' },
    ],
    glowColor: '#f97316',
    ambient: 'rgba(249, 115, 22, 0.18)',
  },
  ocean: {
    id: 'ocean',
    label: 'Ocean',
    stops: [
      { pos: 0, color: '#67e8f9' },
      { pos: 0.55, color: '#0ea5e9' },
      { pos: 1, color: '#1e3a8a' },
    ],
    glowColor: '#0ea5e9',
    ambient: 'rgba(14, 165, 233, 0.18)',
  },
  mono: {
    id: 'mono',
    label: 'Mono',
    stops: [
      { pos: 0, color: '#ffffff' },
      { pos: 1, color: '#a3a3a3' },
    ],
    glowColor: '#ffffff',
    ambient: 'rgba(255, 255, 255, 0.10)',
  },
  spotify: {
    id: 'spotify',
    label: 'Spotify',
    stops: [
      { pos: 0, color: '#1ED760' },
      { pos: 0.55, color: '#1DB954' },
      { pos: 1, color: '#0e4f24' },
    ],
    glowColor: '#1ED760',
    ambient: 'rgba(29, 185, 84, 0.18)',
  },
  rainbow: {
    id: 'rainbow',
    label: 'Rainbow',
    stops: [
      { pos: 0, color: '#ff006e' },
      { pos: 0.2, color: '#fb5607' },
      { pos: 0.4, color: '#ffbe0b' },
      { pos: 0.6, color: '#06d6a0' },
      { pos: 0.8, color: '#118ab2' },
      { pos: 1, color: '#8338ec' },
    ],
    glowColor: '#ff006e',
    ambient: 'rgba(255, 0, 110, 0.16)',
  },
  cyberpunk: {
    id: 'cyberpunk',
    label: 'Cyberpunk',
    stops: [
      { pos: 0, color: '#ff10f0' },
      { pos: 0.5, color: '#00fff9' },
      { pos: 1, color: '#fffb00' },
    ],
    glowColor: '#ff10f0',
    ambient: 'rgba(255, 16, 240, 0.18)',
  },
  pastel: {
    id: 'pastel',
    label: 'Pastel',
    stops: [
      { pos: 0, color: '#ffb3ba' },
      { pos: 0.33, color: '#ffdfba' },
      { pos: 0.66, color: '#bae1ff' },
      { pos: 1, color: '#c5b3ff' },
    ],
    glowColor: '#ffb3ba',
    ambient: 'rgba(255, 179, 186, 0.14)',
  },
  magenta: {
    id: 'magenta',
    label: 'Magenta',
    stops: [
      { pos: 0, color: '#ff61c5' },
      { pos: 0.5, color: '#c4308a' },
      { pos: 1, color: '#6b1a4a' },
    ],
    glowColor: '#ff61c5',
    ambient: 'rgba(255, 97, 197, 0.16)',
  },
};

/* ─── Gradient cache ─────────────────────────────────────────────────────
 * Every per-frame draw style was allocating fresh CanvasGradient objects by
 * calling ctx.createLinearGradient(). At 60 FPS across 7+ draw paths, that's
 * ~20-30µs per frame just on GC/allocation pressure, plus a GPU sync cost.
 *
 * The cache keys gradients by (palette id, x0|y0, x1|y1, orientation, ctx).
 * Since palettes and visualizer container size both change rarely, the
 * cached gradient is reused frame-after-frame. The cache is scoped per ctx
 * so multiple canvases (e.g. response curve + waveform) don't conflict.
 *
 * Hard cap of CACHE_CEILING entries per ctx, with naive eviction (drop
 * oldest by insertion) — prevents unbounded growth from a misbehaving
 * caller that varies the bounds every frame.
 * ─────────────────────────────────────────────────────────────────────── */

/** Sample a palette at position `t ∈ [0, 1]` and return an `rgb(...)` string.
 *  Linear interpolation between adjacent stops in RGB space — good enough for
 *  UI accents and the per-band EQ activity coloring (where we need a non-
 *  canvas color string). For canvas use, prefer the cached gradient helpers
 *  below since they let the GPU do the interpolation. */
export function sampleAt(palette: Palette, t: number): string {
  const stops = palette.stops;
  if (stops.length === 0) return '#1ed760';
  if (stops.length === 1) return stops[0].color;
  const clamped = Math.max(0, Math.min(1, t));
  // Find the bracketing pair. Stops are stored in increasing pos order, so a
  // linear scan is fast enough for the typical 2-4 stop palettes.
  let lo = stops[0];
  let hi = stops[stops.length - 1];
  for (let i = 0; i < stops.length - 1; i++) {
    if (clamped >= stops[i].pos && clamped <= stops[i + 1].pos) {
      lo = stops[i];
      hi = stops[i + 1];
      break;
    }
  }
  const span = hi.pos - lo.pos;
  const local = span <= 0 ? 0 : (clamped - lo.pos) / span;
  const [lr, lg, lb] = hexToRgbTriplet(lo.color);
  const [hr, hg, hb] = hexToRgbTriplet(hi.color);
  const r = Math.round(lr + (hr - lr) * local);
  const g = Math.round(lg + (hg - lg) * local);
  const b = Math.round(lb + (hb - lb) * local);
  return `rgb(${r}, ${g}, ${b})`;
}

function hexToRgbTriplet(hex: string): [number, number, number] {
  if (!hex.startsWith('#') || hex.length !== 7) return [29, 215, 96];
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}

/** Either flavor of 2D canvas context — main thread or OffscreenCanvas worker. */
export type AnyCanvasCtx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

const CACHE_CEILING = 24;
const gradientCaches = new WeakMap<AnyCanvasCtx, Map<string, CanvasGradient>>();

function getOrCreateGradient(
  ctx: AnyCanvasCtx,
  palette: Palette,
  key: string,
  build: () => CanvasGradient,
): CanvasGradient {
  let cache = gradientCaches.get(ctx);
  if (!cache) {
    cache = new Map();
    gradientCaches.set(ctx, cache);
  }
  const existing = cache.get(key);
  if (existing) return existing;
  if (cache.size >= CACHE_CEILING) {
    // Drop the oldest entry (Map iteration order = insertion order).
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  const g = build();
  for (const stop of palette.stops) g.addColorStop(stop.pos, stop.color);
  cache.set(key, g);
  return g;
}

export function verticalGradient(
  ctx: AnyCanvasCtx,
  palette: Palette,
  y0: number,
  y1: number,
): CanvasGradient {
  const key = `v|${palette.id}|${y0 | 0}|${y1 | 0}`;
  return getOrCreateGradient(ctx, palette, key, () => ctx.createLinearGradient(0, y0, 0, y1));
}

export function horizontalGradient(
  ctx: AnyCanvasCtx,
  palette: Palette,
  x0: number,
  x1: number,
): CanvasGradient {
  const key = `h|${palette.id}|${x0 | 0}|${x1 | 0}`;
  return getOrCreateGradient(ctx, palette, key, () => ctx.createLinearGradient(x0, 0, x1, 0));
}

/** Clear the cache for a specific canvas context — call when the canvas
 *  is resized (the gradient coordinates would no longer match the new size). */
export function clearGradientCache(ctx: AnyCanvasCtx): void {
  gradientCaches.delete(ctx);
}

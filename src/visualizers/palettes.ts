import type { PaletteId } from '../state/settings';

export interface PaletteStop {
  pos: number;
  color: string;
}

export interface Palette {
  // Static palettes use a PaletteId literal; synthesized palettes (album-art
  // extraction) use a hash-like string so the gradient cache keys uniquely
  // per derived color set.
  id: PaletteId | string;
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
  ice: {
    id: 'ice',
    label: 'Ice',
    stops: [
      { pos: 0, color: '#e0f2fe' },
      { pos: 0.5, color: '#7dd3fc' },
      { pos: 1, color: '#0284c7' },
    ],
    glowColor: '#7dd3fc',
    ambient: 'rgba(125, 211, 252, 0.16)',
  },
  ember: {
    id: 'ember',
    label: 'Ember',
    stops: [
      { pos: 0, color: '#fbbf24' },
      { pos: 0.45, color: '#dc2626' },
      { pos: 1, color: '#450a0a' },
    ],
    glowColor: '#f87171',
    ambient: 'rgba(220, 38, 38, 0.16)',
  },
  forest: {
    id: 'forest',
    label: 'Forest',
    stops: [
      { pos: 0, color: '#bef264' },
      { pos: 0.5, color: '#16a34a' },
      { pos: 1, color: '#052e16' },
    ],
    glowColor: '#4ade80',
    ambient: 'rgba(22, 163, 74, 0.16)',
  },
  candy: {
    id: 'candy',
    label: 'Candy',
    stops: [
      { pos: 0, color: '#fda4af' },
      { pos: 0.5, color: '#c084fc' },
      { pos: 1, color: '#38bdf8' },
    ],
    glowColor: '#c084fc',
    ambient: 'rgba(192, 132, 252, 0.16)',
  },
  mono2: {
    id: 'mono2',
    label: 'Bone',
    stops: [
      { pos: 0, color: '#fafaf9' },
      { pos: 0.5, color: '#a8a29e' },
      { pos: 1, color: '#44403c' },
    ],
    glowColor: '#d6d3d1',
    ambient: 'rgba(214, 211, 209, 0.12)',
  },
  // Placeholder so the Record<PaletteId, Palette> stays total. The real
  // custom palette is synthesized per-render from settings.customColors —
  // see buildCustomPalette(). Reading PALETTES.custom directly gives the
  // defaults, which is the right fallback if settings are unavailable.
  custom: {
    id: 'custom',
    label: 'Custom',
    stops: [
      { pos: 0, color: '#7c3aed' },
      { pos: 0.5, color: '#ec4899' },
      { pos: 1, color: '#f59e0b' },
    ],
    glowColor: '#ec4899',
    ambient: 'rgba(236, 72, 153, 0.16)',
  },
};

/** Build the live 'custom' palette from the user's three chosen stops.
 *  `id` embeds the colors so the gradient cache (keyed by palette id) gets a
 *  fresh entry whenever the user picks a new color — otherwise the canvas
 *  would keep drawing the previous gradient. */
export function buildCustomPalette(colors: readonly [string, string, string]): Palette {
  const [low, mid, high] = colors;
  return {
    id: `custom:${low}${mid}${high}`,
    label: 'Custom',
    stops: [
      { pos: 0, color: low },
      { pos: 0.5, color: mid },
      { pos: 1, color: high },
    ],
    glowColor: mid,
    ambient: hexToAmbient(mid),
  };
}

/**
 * A palette partway between two others, for crossfading one theme into the
 * next. `t` of 0 gives a's colors, 1 gives b's.
 *
 * Both sides are resampled at b's stop positions rather than paired up
 * stop-for-stop. The palettes in this file carry anywhere from two to four
 * stops and album-art extraction always synthesizes three, so there is often
 * no stop-for-stop pairing to make; and interpolating position alongside
 * color would slide the gradient's shape around mid-fade when all that was
 * asked for was a change of color.
 *
 * The id encodes both endpoints and the step, and has to: every gradient
 * cache in the render path keys on palette.id, so a reused id would serve the
 * first step's colors for the length of the fade.
 */
export function mixPalettes(a: Palette, b: Palette, t: number): Palette {
  const k = Math.max(0, Math.min(1, t));
  const stops = b.stops.map(({ pos }) => {
    const from = sampleRgbAt(a, pos);
    const to = sampleRgbAt(b, pos);
    return { pos, color: rgbToHex(mix(from[0], to[0], k), mix(from[1], to[1], k), mix(from[2], to[2], k)) };
  });
  const ga = hexToRgbTriplet(a.glowColor);
  const gb = hexToRgbTriplet(b.glowColor);
  return {
    id: `mix:${a.id}>${b.id}@${Math.round(k * 1000)}`,
    label: b.label,
    stops,
    glowColor: rgbToHex(mix(ga[0], gb[0], k), mix(ga[1], gb[1], k), mix(ga[2], gb[2], k)),
    ambient: mixAmbient(a.ambient, b.ambient, k),
  };
}

function mix(x: number, y: number, t: number): number {
  return Math.round(x + (y - x) * t);
}

function rgbToHex(r: number, g: number, b: number): string {
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
}

/** Interpolate two `rgba(...)` strings. Alpha is interpolated too rather than
 *  taken from either end, because it is not constant across these palettes —
 *  mono sits at 0.10 and most of the rest at 0.16 or 0.18, so holding one
 *  end's value would step the stage wash at the start or the finish of a
 *  fade. Falls back to the destination if either side isn't an rgb/rgba. */
function mixAmbient(a: string, b: string, t: number): string {
  const pa = parseRgba(a);
  const pb = parseRgba(b);
  if (!pa || !pb) return b;
  const alpha = pa[3] + (pb[3] - pa[3]) * t;
  return `rgba(${mix(pa[0], pb[0], t)}, ${mix(pa[1], pb[1], t)}, ${mix(pa[2], pb[2], t)}, ${alpha.toFixed(3)})`;
}

function parseRgba(s: string): [number, number, number, number] | null {
  const m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(s.trim());
  if (!m) return null;
  return [+m[1], +m[2], +m[3], m[4] === undefined ? 1 : +m[4]];
}

/** Hex -> low-alpha rgba for the stage ambient wash. Falls back to a neutral
 *  tint if the string isn't a 6-digit hex (e.g. a named color from a paste). */
function hexToAmbient(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return 'rgba(255, 255, 255, 0.12)';
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, 0.16)`;
}

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
  const [r, g, b] = sampleRgbAt(palette, t);
  return `rgb(${r}, ${g}, ${b})`;
}

/** Same interpolation as `sampleAt`, returned as a numeric triplet so callers
 *  that need to do further color math (the Scope's per-copy hue fan) don't
 *  have to parse a string back apart. */
export function sampleRgbAt(palette: Palette, t: number): [number, number, number] {
  const stops = palette.stops;
  if (stops.length === 0) return [29, 215, 96];
  if (stops.length === 1) return hexToRgbTriplet(stops[0].color);
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
  return [
    Math.round(lr + (hr - lr) * local),
    Math.round(lg + (hg - lg) * local),
    Math.round(lb + (hb - lb) * local),
  ];
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

/**
 * Album-art palette extraction.
 *
 * Given an image URL, loads it (with CORS), downsamples to a small canvas,
 * buckets pixels in HSL space, and synthesizes a Palette object whose shape
 * matches the static PALETTES in palettes.ts. The result feeds the worker
 * draw loop, the UI accent CSS vars, and the EQ band-activity ombre.
 *
 * Spotify's i.scdn.co serves album art with `Access-Control-Allow-Origin: *`
 * so `crossOrigin = 'anonymous'` works — without it the canvas read throws a
 * security error on tainted-canvas access.
 */

import type { Palette } from './palettes';

const TARGET_SIZE = 64;
// Reject near-grey pixels; they don't carry hue information.
const MIN_SATURATION = 0.22;
// Reject near-black + near-white so the palette doesn't get pinned to the
// background of an album cover (lots of black/white covers exist).
const MIN_LIGHTNESS = 0.18;
const MAX_LIGHTNESS = 0.88;
const HUE_BUCKETS = 18;
const SAT_BUCKETS = 4;
const LIGHT_BUCKETS = 4;
// Secondary stop should be visually distinct from primary; require at least
// this much hue separation (in fractional revolutions, so 60° == 1/6).
const MIN_HUE_SEPARATION = 60 / 360;

interface BucketAcc {
  rSum: number;
  gSum: number;
  bSum: number;
  hSum: number;
  sSum: number;
  lSum: number;
  weight: number;
}

interface RankedColor {
  r: number;
  g: number;
  b: number;
  hue: number;
  sat: number;
  light: number;
  score: number;
}

export async function extractPaletteFromUrl(url: string): Promise<Palette | null> {
  let img: HTMLImageElement;
  try {
    img = await loadImage(url);
  } catch (err) {
    console.warn('[extractPalette] image load failed', url, err);
    return null;
  }
  return extractPaletteFromImage(img);
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = (e) => reject(e);
    img.src = url;
  });
}

function extractPaletteFromImage(img: HTMLImageElement): Palette | null {
  const canvas = document.createElement('canvas');
  canvas.width = TARGET_SIZE;
  canvas.height = TARGET_SIZE;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  try {
    ctx.drawImage(img, 0, 0, TARGET_SIZE, TARGET_SIZE);
  } catch (err) {
    console.warn('[extractPalette] drawImage failed', err);
    return null;
  }
  let imageData: ImageData;
  try {
    imageData = ctx.getImageData(0, 0, TARGET_SIZE, TARGET_SIZE);
  } catch (err) {
    // Tainted canvas — CORS denied or anonymous request failed.
    console.warn('[extractPalette] getImageData failed (CORS?)', err);
    return null;
  }
  const data = imageData.data;

  const buckets = new Map<number, BucketAcc>();
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const a = data[i + 3];
    if (a < 128) continue;
    const [h, s, l] = rgbToHsl(r, g, b);
    if (l < MIN_LIGHTNESS || l > MAX_LIGHTNESS) continue;
    if (s < MIN_SATURATION) continue;
    const hBucket = Math.min(HUE_BUCKETS - 1, Math.floor(h * HUE_BUCKETS));
    const sBucket = Math.min(SAT_BUCKETS - 1, Math.floor(s * SAT_BUCKETS));
    const lBucket = Math.min(LIGHT_BUCKETS - 1, Math.floor(l * LIGHT_BUCKETS));
    const key = hBucket * SAT_BUCKETS * LIGHT_BUCKETS + sBucket * LIGHT_BUCKETS + lBucket;
    // Pixels at mid-lightness with high saturation are most "useful" as accents —
    // weight them more than dim or washed-out pixels.
    const lightnessFactor = 1 - Math.abs(l - 0.55) * 2;
    const weight = s * (0.35 + Math.max(0, lightnessFactor) * 0.65);

    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { rSum: 0, gSum: 0, bSum: 0, hSum: 0, sSum: 0, lSum: 0, weight: 0 };
      buckets.set(key, bucket);
    }
    bucket.rSum += r * weight;
    bucket.gSum += g * weight;
    bucket.bSum += b * weight;
    bucket.hSum += h * weight;
    bucket.sSum += s * weight;
    bucket.lSum += l * weight;
    bucket.weight += weight;
  }

  if (buckets.size === 0) return null;

  const ranked: RankedColor[] = [];
  for (const acc of buckets.values()) {
    if (acc.weight <= 0) continue;
    ranked.push({
      r: clamp255(Math.round(acc.rSum / acc.weight)),
      g: clamp255(Math.round(acc.gSum / acc.weight)),
      b: clamp255(Math.round(acc.bSum / acc.weight)),
      hue: acc.hSum / acc.weight,
      sat: acc.sSum / acc.weight,
      light: acc.lSum / acc.weight,
      score: acc.weight,
    });
  }
  if (ranked.length === 0) return null;
  ranked.sort((a, b) => b.score - a.score);

  const primary = ranked[0];
  // Secondary = highest-scoring color with hue separated from primary.
  let secondary: RankedColor = ranked[1] ?? primary;
  for (let i = 1; i < ranked.length; i++) {
    if (hueDelta(ranked[i].hue, primary.hue) >= MIN_HUE_SEPARATION) {
      secondary = ranked[i];
      break;
    }
  }

  const primaryHex = rgbToHex(primary.r, primary.g, primary.b);
  const secondaryHex = rgbToHex(secondary.r, secondary.g, secondary.b);
  // Tertiary = darkened primary, for gradient depth at the bottom stop.
  const [dr, dg, db] = darken(primary.r, primary.g, primary.b, 0.55);
  const darkHex = rgbToHex(dr, dg, db);

  return {
    // Synthesized id keys the gradient cache uniquely per album-derived color
    // set — two different album palettes won't collide on cached gradients.
    id: `auto-${primaryHex}-${secondaryHex}`,
    label: 'Album',
    stops: [
      { pos: 0, color: secondaryHex },
      { pos: 0.55, color: primaryHex },
      { pos: 1, color: darkHex },
    ],
    glowColor: primaryHex,
    ambient: `rgba(${primary.r}, ${primary.g}, ${primary.b}, 0.18)`,
  };
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === rn) h = (gn - bn) / d + (gn < bn ? 6 : 0);
  else if (max === gn) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;
  return [h / 6, s, l];
}

function hueDelta(a: number, b: number): number {
  const d = Math.abs(a - b);
  return d > 0.5 ? 1 - d : d;
}

function rgbToHex(r: number, g: number, b: number): string {
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function toHex(n: number): string {
  const h = clamp255(n).toString(16);
  return h.length === 1 ? `0${h}` : h;
}

function darken(r: number, g: number, b: number, factor: number): [number, number, number] {
  return [Math.round(r * factor), Math.round(g * factor), Math.round(b * factor)];
}

function clamp255(n: number): number {
  return n < 0 ? 0 : n > 255 ? 255 : n;
}

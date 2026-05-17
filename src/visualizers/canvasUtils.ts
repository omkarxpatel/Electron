import type { Settings } from '../state/settings';
import type { AnyCanvasCtx } from './palettes';

/**
 * Decay the canvas alpha to create motion trails. The canvas stays transparent,
 * so any CSS background on the stage shines through faded old frames.
 */
export function applyTrails(
  ctx: AnyCanvasCtx,
  width: number,
  height: number,
  trail: number,
): void {
  if (trail <= 0) {
    ctx.clearRect(0, 0, width, height);
    return;
  }
  const prevComp = ctx.globalCompositeOperation;
  ctx.globalCompositeOperation = 'destination-out';
  // 1 - trail = alpha removed each frame; higher trail = longer ghosting
  ctx.fillStyle = `rgba(0,0,0,${1 - trail})`;
  ctx.fillRect(0, 0, width, height);
  ctx.globalCompositeOperation = prevComp;
}

/**
 * Translate the glow setting into pixel blur radius. shadowBlur is in CSS
 * pixels here because we've already scaled the ctx by dpr.
 */
export function glowBlur(settings: Settings): number {
  return settings.glow * 32; // 0..32 px
}

export function roundRectPath(
  ctx: AnyCanvasCtx,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  if (w <= 0 || h <= 0) return;
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

/**
 * Configure the canvas backing-store to match the element's CSS box at the
 * current device pixel ratio. Re-applies the dpr transform.
 *
 * Returns `true` if the canvas's intrinsic dimensions actually changed —
 * callers should use this to invalidate any caches (gradients, etc.) keyed
 * on canvas size. Re-running setupHiDPI when nothing changed is wasted
 * work AND a GC sync point (setting canvas.width/height clears the buffer
 * even if assigning the same value).
 */
/**
 * Worker-side counterpart to setupHiDPI. The worker can't read DPR or layout
 * dimensions (no DOM in a worker), so the main thread passes them in and
 * this helper applies them to the OffscreenCanvas + transform. Returns true
 * iff dimensions actually changed (caller uses this to invalidate caches).
 */
export function setupOffscreenCanvas(
  canvas: OffscreenCanvas,
  ctx: OffscreenCanvasRenderingContext2D,
  cssWidth: number,
  cssHeight: number,
  dpr: number,
): boolean {
  const targetW = Math.max(1, Math.round(cssWidth * dpr));
  const targetH = Math.max(1, Math.round(cssHeight * dpr));
  if (canvas.width === targetW && canvas.height === targetH) return false;
  canvas.width = targetW;
  canvas.height = targetH;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return true;
}

export function setupHiDPI(canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D): boolean {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const targetW = Math.max(1, Math.round(rect.width * dpr));
  const targetH = Math.max(1, Math.round(rect.height * dpr));
  if (canvas.width === targetW && canvas.height === targetH) {
    // Nothing actually changed — skip the (expensive) buffer reallocation.
    return false;
  }
  canvas.width = targetW;
  canvas.height = targetH;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return true;
}

import type { Settings } from '../state/settings';

/**
 * Decay the canvas alpha to create motion trails. The canvas stays transparent,
 * so any CSS background on the stage shines through faded old frames.
 */
export function applyTrails(
  ctx: CanvasRenderingContext2D,
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
  ctx: CanvasRenderingContext2D,
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

export function setupHiDPI(canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D): number {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.max(1, rect.width * dpr);
  canvas.height = Math.max(1, rect.height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return dpr;
}

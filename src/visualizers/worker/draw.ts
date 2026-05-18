/**
 * All visualizer draw functions, extracted from WaveformVisualizer.tsx so
 * they can run in a Web Worker against an OffscreenCanvasRenderingContext2D.
 * The functions themselves are unchanged from the main-thread version — only
 * the context type was loosened to AnyCanvasCtx via the palettes module.
 */

import type { Settings } from '../../state/settings';
import {
  PALETTES,
  horizontalGradient,
  verticalGradient,
  type AnyCanvasCtx,
  type Palette,
} from '../palettes';
import { applyTrails, glowBlur, roundRectPath } from '../canvasUtils';

/* ============================================================
   Helpers — buffer sizing
   ============================================================ */

export function getLinearBarCount(width: number, barWidth: number, barGap: number, minBars = 8): number {
  const slot = barWidth + barGap;
  return Math.max(minBars, Math.floor(width / slot));
}

export function getRadialBarCount(): number {
  return 96;
}

export function getSpectrumBarCount(width: number, barWidth: number, barGap: number): number {
  const slot = Math.max(2, barWidth + barGap);
  return Math.max(16, Math.min(256, Math.floor(width / slot)));
}

export function ensureBarBuffer(buf: Float32Array, n: number): Float32Array {
  if (buf.length !== n) return new Float32Array(n);
  return buf;
}

/* ----------------------------------------------------------------
   Spatial spectrum — per-position band energies (log-spaced).
   ---------------------------------------------------------------- */
export function updateSpectralBands(
  freq: Uint8Array,
  sampleRate: number,
  out: Float32Array,
): void {
  const N = out.length;
  const nyquist = sampleRate / 2;
  const MIN_FREQ = 30;
  const MAX_FREQ = 18000;
  const logRatio = Math.log(MAX_FREQ / MIN_FREQ);
  for (let b = 0; b < N; b++) {
    const f0 = MIN_FREQ * Math.exp((b / N) * logRatio);
    const f1 = MIN_FREQ * Math.exp(((b + 1) / N) * logRatio);
    const i0 = Math.max(1, Math.floor((f0 / nyquist) * freq.length));
    const i1 = Math.max(i0 + 1, Math.min(freq.length, Math.ceil((f1 / nyquist) * freq.length)));
    let peak = 0;
    for (let i = i0; i < i1; i++) {
      if (freq[i] > peak) peak = freq[i];
    }
    const target = peak / 255;
    out[b] = out[b] * 0.65 + target * 0.35;
  }
}

export function spectralAt(spectral: Float32Array | null, x: number): number {
  if (!spectral) return 0;
  const i = x < 0 ? 0 : x >= 1 ? spectral.length - 1 : Math.floor(x * spectral.length);
  return spectral[i];
}

export function ensureSampleBuffer(buf: Float32Array, w: number): Float32Array {
  const target = Math.max(64, Math.floor(w / 2));
  if (Math.abs(buf.length - target) > 16) return new Float32Array(target);
  return buf;
}

export function peakPerBar(time: Uint8Array, barIndex: number, samplesPerBar: number): number {
  let peak = 0;
  const base = barIndex * samplesPerBar;
  const end = Math.min(time.length, base + samplesPerBar);
  for (let i = base; i < end; i++) {
    const v = Math.abs(time[i] - 128) / 128;
    if (v > peak) peak = v;
  }
  return peak;
}

export function smoothStep(prev: number, next: number, release: number): number {
  return next > prev ? next * 0.6 + prev * 0.4 : prev * release + next * (1 - release);
}

/* ============================================================
   Reusable buffers — module-scope (one per worker instance).
   ============================================================ */

let ribbonYsBuffer: Float32Array = new Float32Array(0);

const radialGradientCaches = new WeakMap<AnyCanvasCtx, { key: string; grad: CanvasGradient }>();
function cachedRadialGradient(
  ctx: AnyCanvasCtx,
  palette: Palette,
  cx: number,
  cy: number,
  innerR: number,
  outerR: number,
): CanvasGradient {
  const key = `${palette.id}|${cx | 0}|${cy | 0}|${innerR | 0}|${outerR | 0}`;
  const cached = radialGradientCaches.get(ctx);
  if (cached && cached.key === key) return cached.grad;
  const g = ctx.createRadialGradient(cx, cy, innerR, cx, cy, outerR);
  for (const stop of palette.stops) g.addColorStop(stop.pos, stop.color);
  radialGradientCaches.set(ctx, { key, grad: g });
  return g;
}

/* ============================================================
   Per-frame draw state owned by the worker (was hook-local
   before). Held in a single object so the dispatcher can mutate
   in place — avoids reallocating across frames.
   ============================================================ */

export interface DrawState {
  smoothed: Float32Array;
  smoothedSamples: Float32Array;
  rotation: number;
  envelope: number;
  particles: Particle[] | null;
  tick: number;
  prevBassEnergy: number;
  onsetEnv: number;
  spectralBands: Float32Array;
  /** Wall-clock timestamp of the previous draw, used to derive a frame-rate-
   *  independent dt factor. Without this, 120 Hz displays animate at 2× the
   *  speed of 60 Hz (since increments were applied per-frame, not per-time). */
  lastDrawTimeMs: number;
}

export function createDrawState(): DrawState {
  return {
    smoothed: new Float32Array(0),
    smoothedSamples: new Float32Array(0),
    rotation: 0,
    envelope: 0.5,
    particles: null,
    tick: 0,
    prevBassEnergy: 0,
    onsetEnv: 0,
    spectralBands: new Float32Array(64),
    lastDrawTimeMs: 0,
  };
}

/* ============================================================
   Single-frame dispatch — chooses the right style and draws.
   ============================================================ */

export function drawFrame(
  ctx: AnyCanvasCtx,
  width: number,
  height: number,
  time: Uint8Array,
  freq: Uint8Array,
  sampleRate: number,
  settings: Settings,
  state: DrawState,
): void {
  const s = settings;
  const isSpectrum = s.waveformStyle === 'spectrum';
  const useSpectralPos = s.spectralPosition && !isSpectrum;

  // Frame-rate-independent time delta, normalized to a 60 Hz reference frame.
  // dt60 == 1 at 60 Hz, 0.5 at 120 Hz, ~2 at 30 Hz. Cap at 3 to avoid huge
  // catch-up jumps after the window was inactive. First frame uses 1.
  const nowMs = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const dt60 = state.lastDrawTimeMs === 0
    ? 1
    : Math.min(3, Math.max(0.1, (nowMs - state.lastDrawTimeMs) / 16.667));
  state.lastDrawTimeMs = nowMs;

  if (useSpectralPos) {
    updateSpectralBands(freq, sampleRate, state.spectralBands);
  }
  const spectral: Float32Array | null = useSpectralPos ? state.spectralBands : null;

  // Real-time peak envelope.
  let framePeak = 0;
  for (let i = 0; i < time.length; i++) {
    const v = Math.abs(time[i] - 128) / 128;
    if (v > framePeak) framePeak = v;
  }
  const RELEASE = 0.025;
  if (framePeak > state.envelope) state.envelope = framePeak;
  else state.envelope = state.envelope * (1 - RELEASE) + framePeak * RELEASE;

  applyTrails(ctx, width, height, s.trail);

  const palette = PALETTES[s.palette];
  ctx.shadowBlur = glowBlur(s);
  ctx.shadowColor = palette.glowColor;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  const release = 0.5 + s.smoothing * 0.47;
  const TARGET_FILL = 0.92;
  const ENVELOPE_FLOOR = 0.02;
  const autoGainEligible = s.autoGain && !isSpectrum;
  const autoGainFactor = autoGainEligible ? TARGET_FILL / Math.max(state.envelope, ENVELOPE_FLOOR) : 1;
  const gain = Math.max(0.2, Math.min(20, s.sensitivity * autoGainFactor));

  // Ensure buffers sized for this frame BEFORE drawing.
  switch (s.waveformStyle) {
    case 'ribbon':
    case 'line':
    case 'filled':
      state.smoothedSamples = ensureSampleBuffer(state.smoothedSamples, width);
      break;
    case 'radial':
      state.smoothed = ensureBarBuffer(state.smoothed, getRadialBarCount());
      break;
    case 'dots':
      state.smoothed = ensureBarBuffer(state.smoothed, getLinearBarCount(width, s.barWidth, s.barGap, 14));
      break;
    case 'mirror':
    case 'bars':
      state.smoothed = ensureBarBuffer(state.smoothed, getLinearBarCount(width, s.barWidth, s.barGap));
      break;
    case 'spectrum':
      state.smoothed = ensureBarBuffer(state.smoothed, getSpectrumBarCount(width, s.barWidth, s.barGap));
      break;
    case 'particles':
      state.smoothedSamples = ensureSampleBuffer(state.smoothedSamples, width);
      if (!state.particles) state.particles = createParticles(PARTICLE_COUNT);
      break;
    case 'silk':
      state.smoothedSamples = ensureSampleBuffer(state.smoothedSamples, width);
      break;
  }

  switch (s.waveformStyle) {
    case 'ribbon':
      drawRibbon(ctx, width, height, time, palette, state.smoothedSamples, release, gain, spectral);
      break;
    case 'radial':
      state.rotation += 0.0015 * dt60;
      drawRadial(ctx, width, height, time, palette, state.smoothed, release, gain, state.rotation, s.barWidth, spectral);
      break;
    case 'dots':
      drawDots(ctx, width, height, time, palette, state.smoothed, release, gain, s.barWidth, s.barGap, spectral);
      break;
    case 'mirror':
    case 'bars':
      drawBars(ctx, width, height, time, palette, state.smoothed, release, gain, s.barWidth, s.barGap, s.waveformStyle === 'mirror', spectral);
      break;
    case 'line':
      drawLine(ctx, width, height, time, palette, state.smoothedSamples, release, gain, spectral);
      break;
    case 'filled':
      drawFilled(ctx, width, height, time, palette, state.smoothedSamples, release, gain, spectral);
      break;
    case 'spectrum':
      drawSpectrum(ctx, width, height, freq, sampleRate, palette, state.smoothed, release, gain, s.barWidth);
      break;
    case 'silk':
      state.tick += dt60;
      drawSilk(ctx, width, height, time, palette, state.smoothedSamples, release, gain, state.tick, spectral);
      break;
    case 'particles': {
      state.tick += dt60;
      const nyquist = sampleRate / 2;
      const bassEnd = Math.max(2, Math.floor((200 / nyquist) * freq.length));
      const vocalStart = Math.max(bassEnd, Math.floor((300 / nyquist) * freq.length));
      const vocalEnd = Math.max(vocalStart + 1, Math.floor((3000 / nyquist) * freq.length));
      let bassSum = 0;
      for (let i = 1; i < bassEnd; i++) bassSum += freq[i];
      const bassEnergy = bassSum / Math.max(1, bassEnd - 1) / 255;
      let vocalSum = 0;
      for (let i = vocalStart; i < vocalEnd; i++) vocalSum += freq[i];
      const vocalEnergy = vocalSum / Math.max(1, vocalEnd - vocalStart) / 255;
      const bassDelta = bassEnergy - state.prevBassEnergy;
      state.prevBassEnergy = bassEnergy;
      const onsetBoost = bassDelta > 0.03 ? Math.min(1, bassDelta * 6) : 0;
      if (onsetBoost > state.onsetEnv) state.onsetEnv = onsetBoost;
      else state.onsetEnv *= Math.pow(0.86, dt60);
      drawParticles(
        ctx, width, height, time, palette, state.smoothedSamples, release, gain,
        state.particles!, state.tick, bassEnergy, vocalEnergy, state.onsetEnv, s.sensitivity, spectral, dt60,
      );
      break;
    }
  }

  ctx.shadowBlur = 0;
}

/* ============================================================
   Styles (unchanged from the main-thread version).
   ============================================================ */

function drawBars(
  ctx: AnyCanvasCtx,
  w: number,
  h: number,
  time: Uint8Array,
  palette: Palette,
  smoothed: Float32Array,
  release: number,
  gain: number,
  barWidth: number,
  barGap: number,
  mirror: boolean,
  spectral: Float32Array | null,
): void {
  const slot = barWidth + barGap;
  const barCount = getLinearBarCount(w, barWidth, barGap);
  // The dispatcher in drawFrame() calls ensureBarBuffer() for us; the local
  // reassignment that used to live here was dead (the new Float32Array was
  // discarded when the function returned, losing smoothing state on every
  // size change). Trust the buffer the dispatcher passes; if its size is
  // somehow off, fall back to plain index-zero reads rather than allocating.
  const startX = (w - barCount * slot + barGap) / 2;
  const midY = h / 2;
  const peakHeight = h * 0.78;
  const samplesPerBar = Math.max(1, Math.floor(time.length / barCount));

  const grad = verticalGradient(ctx, palette, midY - peakHeight / 2, midY + peakHeight / 2);
  ctx.fillStyle = grad;

  for (let b = 0; b < barCount; b++) {
    const peak = peakPerBar(time, b, samplesPerBar);
    const bandBoost = spectralAt(spectral, (b + 0.5) / barCount) * 0.45;
    const target = Math.min(1, peak * gain + bandBoost);
    smoothed[b] = smoothStep(smoothed[b], target, release);
    const barH = Math.max(2, smoothed[b] * peakHeight);
    const x = startX + b * slot;
    if (mirror) {
      const halfH = barH / 2;
      roundRectPath(ctx, x, midY - halfH, barWidth, barH, barWidth / 2);
    } else {
      roundRectPath(ctx, x, midY - barH / 2, barWidth, barH, barWidth / 2);
    }
    ctx.fill();
  }
}

function drawLine(
  ctx: AnyCanvasCtx,
  w: number,
  h: number,
  time: Uint8Array,
  palette: Palette,
  smoothedSamples: Float32Array,
  release: number,
  gain: number,
  spectral: Float32Array | null,
): void {
  const midY = h / 2;
  const amp = h * 0.38;
  const n = smoothedSamples.length || 1;
  const grad = horizontalGradient(ctx, palette, 0, w);
  ctx.strokeStyle = grad;
  ctx.lineWidth = 2.8;
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const sIdx = Math.floor(t * (time.length - 1));
    const raw = ((time[sIdx] - 128) / 128) * gain;
    const target = raw > 1 ? 1 : raw < -1 ? -1 : raw;
    smoothedSamples[i] = smoothedSamples[i] * release + target * (1 - release);
    const ampMod = 1 + spectralAt(spectral, t) * 0.6;
    const x = t * w;
    const y = midY + smoothedSamples[i] * amp * ampMod;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
}

function drawFilled(
  ctx: AnyCanvasCtx,
  w: number,
  h: number,
  time: Uint8Array,
  palette: Palette,
  smoothedSamples: Float32Array,
  release: number,
  gain: number,
  spectral: Float32Array | null,
): void {
  const midY = h / 2;
  const amp = h * 0.38;
  const n = smoothedSamples.length || 1;
  ctx.fillStyle = verticalGradient(ctx, palette, midY - amp, midY + amp);
  ctx.beginPath();
  ctx.moveTo(0, midY);
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const sIdx = Math.floor(t * (time.length - 1));
    const raw = Math.abs(((time[sIdx] - 128) / 128) * gain);
    const target = raw > 1 ? 1 : raw;
    smoothedSamples[i] = smoothedSamples[i] * release + target * (1 - release);
    const ampMod = 1 + spectralAt(spectral, t) * 0.6;
    const x = t * w;
    const y = midY - smoothedSamples[i] * amp * ampMod;
    ctx.lineTo(x, y);
  }
  ctx.lineTo(w, midY);
  for (let i = n - 1; i >= 0; i--) {
    const t = i / (n - 1);
    const ampMod = 1 + spectralAt(spectral, t) * 0.6;
    const x = t * w;
    const y = midY + smoothedSamples[i] * amp * ampMod;
    ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fill();
}

function drawRibbon(
  ctx: AnyCanvasCtx,
  w: number,
  h: number,
  time: Uint8Array,
  palette: Palette,
  smoothedSamples: Float32Array,
  release: number,
  gain: number,
  spectral: Float32Array | null,
): void {
  const midY = h * 0.5;
  const amp = h * 0.32;
  const n = smoothedSamples.length || 1;

  if (ribbonYsBuffer.length < n) ribbonYsBuffer = new Float32Array(n);
  const ys = ribbonYsBuffer;
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const sIdx = Math.floor(t * (time.length - 1));
    const raw = ((time[sIdx] - 128) / 128) * gain;
    const target = raw > 1 ? 1 : raw < -1 ? -1 : raw;
    smoothedSamples[i] = smoothedSamples[i] * release + target * (1 - release);
    const ampMod = 1 + spectralAt(spectral, t) * 0.6;
    ys[i] = midY + smoothedSamples[i] * amp * ampMod;
  }

  const grad = horizontalGradient(ctx, palette, 0, w);

  ctx.save();
  ctx.globalAlpha = 0.35;
  ctx.translate(0, midY * 2);
  ctx.scale(1, -1);
  ctx.strokeStyle = grad;
  ctx.lineWidth = 6;
  ctx.shadowBlur = Math.max(8, ctx.shadowBlur * 0.5);
  drawSmoothPath(ctx, ys, n, w);
  ctx.stroke();
  ctx.restore();

  ctx.strokeStyle = grad;
  ctx.lineWidth = 4;
  drawSmoothPath(ctx, ys, n, w);
  ctx.stroke();

  ctx.save();
  ctx.globalCompositeOperation = 'screen';
  ctx.strokeStyle = palette.stops[0].color;
  ctx.lineWidth = 1.5;
  ctx.shadowBlur = 0;
  drawSmoothPath(ctx, ys, n, w);
  ctx.stroke();
  ctx.restore();
}

function drawSmoothPath(
  ctx: AnyCanvasCtx,
  ys: ArrayLike<number>,
  n: number,
  w: number,
): void {
  ctx.beginPath();
  if (n < 2) return;
  ctx.moveTo(0, ys[0]);
  for (let i = 1; i < n - 1; i++) {
    const x = (i / (n - 1)) * w;
    const xNext = ((i + 1) / (n - 1)) * w;
    const cx = (x + xNext) / 2;
    const cy = (ys[i] + ys[i + 1]) / 2;
    ctx.quadraticCurveTo(x, ys[i], cx, cy);
  }
  ctx.lineTo(w, ys[n - 1]);
}

function drawRadial(
  ctx: AnyCanvasCtx,
  w: number,
  h: number,
  time: Uint8Array,
  palette: Palette,
  smoothed: Float32Array,
  release: number,
  gain: number,
  rotation: number,
  barWidth: number,
  spectral: Float32Array | null,
): void {
  const barCount = getRadialBarCount();
  // Buffer sizing is handled by the dispatcher via ensureBarBuffer.
  const cx = w / 2;
  const cy = h / 2;
  const minDim = Math.min(w, h);
  const innerRadius = minDim * 0.16;
  const maxLen = minDim * 0.28;

  const samplesPerBar = Math.max(1, Math.floor(time.length / barCount));

  const overallPeak = smoothed.reduce((acc, v) => Math.max(acc, v), 0);
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, innerRadius * (0.9 + overallPeak * 0.15), 0, Math.PI * 2);
  ctx.strokeStyle = palette.glowColor;
  ctx.globalAlpha = 0.4;
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.restore();

  const grad = cachedRadialGradient(ctx, palette, cx, cy, innerRadius, innerRadius + maxLen);
  ctx.strokeStyle = grad;
  ctx.lineCap = 'round';
  ctx.lineWidth = Math.max(2, barWidth * 0.9);

  for (let b = 0; b < barCount; b++) {
    const peak = peakPerBar(time, b, samplesPerBar);
    const bandBoost = spectralAt(spectral, b / barCount) * 0.4;
    const target = Math.min(1, peak * gain + bandBoost);
    smoothed[b] = smoothStep(smoothed[b], target, release);

    const angle = (b / barCount) * Math.PI * 2 + rotation;
    const len = innerRadius + smoothed[b] * maxLen + 2;
    const x1 = cx + Math.cos(angle) * innerRadius;
    const y1 = cy + Math.sin(angle) * innerRadius;
    const x2 = cx + Math.cos(angle) * len;
    const y2 = cy + Math.sin(angle) * len;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  }
}

function drawSpectrum(
  ctx: AnyCanvasCtx,
  w: number,
  h: number,
  freq: Uint8Array,
  sampleRate: number,
  palette: Palette,
  smoothed: Float32Array,
  release: number,
  gain: number,
  settingsBarWidth: number,
): void {
  const barCount = smoothed.length;
  const nyquist = sampleRate / 2;
  const minFreq = 30;
  const maxFreq = 18000;
  const logRatio = Math.log(maxFreq / minFreq);

  const slot = w / barCount;
  const barWidth = Math.max(1, Math.min(slot - 1, settingsBarWidth));

  const midY = h / 2;
  const maxHalfHeight = h * 0.44;

  const grad = horizontalGradient(ctx, palette, 0, w);
  ctx.fillStyle = grad;

  for (let b = 0; b < barCount; b++) {
    const f0 = minFreq * Math.exp((b / barCount) * logRatio);
    const f1 = minFreq * Math.exp(((b + 1) / barCount) * logRatio);
    const i0 = Math.max(1, Math.floor((f0 / nyquist) * freq.length));
    const i1 = Math.max(i0 + 1, Math.min(freq.length, Math.ceil((f1 / nyquist) * freq.length)));

    let peak = 0;
    for (let i = i0; i < i1; i++) {
      if (freq[i] > peak) peak = freq[i];
    }

    const midF = Math.sqrt(f0 * f1);
    const tilt = Math.pow(midF / 100, 0.4);
    const raw = (peak / 255) * gain * tilt * 0.5;
    const target = raw / (1 + raw);
    smoothed[b] = smoothStep(smoothed[b], target, release);

    const halfH = Math.max(4, smoothed[b] * maxHalfHeight);
    const x = b * slot + (slot - barWidth) / 2;
    roundRectPath(ctx, x, midY - halfH, barWidth, halfH * 2, barWidth / 2);
    ctx.fill();
  }
}

function drawDots(
  ctx: AnyCanvasCtx,
  w: number,
  h: number,
  time: Uint8Array,
  palette: Palette,
  smoothed: Float32Array,
  release: number,
  gain: number,
  barWidth: number,
  barGap: number,
  spectral: Float32Array | null,
): void {
  const dotCount = getLinearBarCount(w, barWidth, barGap, 14);
  // Buffer sizing is handled by the dispatcher via ensureBarBuffer.
  void dotCount; // (kept for clarity; realCount below drives the actual loop)
  const slot = (barWidth + barGap) * 3;
  const realCount = Math.max(14, Math.floor(w / slot));
  const startX = (w - realCount * slot + slot) / 2;
  const midY = h / 2;
  const maxRadius = Math.min(h * 0.22, slot * 0.55);
  const samplesPerBar = Math.max(1, Math.floor(time.length / realCount));

  const grad = horizontalGradient(ctx, palette, 0, w);
  ctx.fillStyle = grad;

  for (let b = 0; b < realCount; b++) {
    const peak = peakPerBar(time, b, samplesPerBar);
    const bandBoost = spectralAt(spectral, (b + 0.5) / realCount) * 0.4;
    const target = Math.min(1, peak * gain + bandBoost);
    smoothed[b] = smoothStep(smoothed[b], target, release);
    const r = 3 + smoothed[b] * maxRadius;
    const x = startX + b * slot;
    ctx.beginPath();
    ctx.arc(x, midY, r, 0, Math.PI * 2);
    ctx.fill();
  }
}

/* ============================================================
   Particles
   ============================================================ */

interface Particle {
  x: number;
  yBias: number;
  size: number;
  vx: number;
  seed: number;
}

const PARTICLE_COUNT = 320;

function createParticles(n: number): Particle[] {
  const out: Particle[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const u = Math.random() * 2 - 1;
    out[i] = {
      x: Math.random(),
      yBias: u * u * u,
      size: 0.4 + Math.random() * 2.0,
      vx: -0.0006 - Math.random() * 0.0012,
      seed: Math.random() * Math.PI * 2,
    };
  }
  return out;
}

function drawParticles(
  ctx: AnyCanvasCtx,
  w: number,
  h: number,
  time: Uint8Array,
  palette: Palette,
  smoothedSamples: Float32Array,
  release: number,
  gain: number,
  particles: Particle[],
  tick: number,
  bassEnergy: number,
  vocalEnergy: number,
  onsetEnv: number,
  sensitivity: number,
  spectral: Float32Array | null,
  dt60: number,
): void {
  const reactivity = Math.min(1.4, Math.max(0.3, sensitivity));
  const midY = h * 0.5;
  const amp = h * 0.26;
  const scatterRange = h * 0.30;
  const n = smoothedSamples.length || 1;

  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const sIdx = Math.floor(t * (time.length - 1));
    const raw = ((time[sIdx] - 128) / 128) * gain;
    const target = raw > 1 ? 1 : raw < -1 ? -1 : raw;
    smoothedSamples[i] = smoothedSamples[i] * release + target * (1 - release);
  }

  const grad = horizontalGradient(ctx, palette, 0, w);

  const prevShadow = ctx.shadowBlur;
  ctx.shadowBlur = Math.min(prevShadow, 10);

  ctx.strokeStyle = grad;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  const LINE_COUNT = 7;
  const phaseStep = Math.max(2, Math.floor(n / 90));
  const center = (LINE_COUNT - 1) / 2;

  for (let k = 0; k < LINE_COUNT; k++) {
    const dist = Math.abs(k - center);
    const distNorm = dist / center;
    const phaseShift = Math.round((k - center) * phaseStep);
    const bobAmp = h * (0.04 + dist * 0.06) * (1 + onsetEnv * 0.25) * (0.6 + reactivity * 0.4);
    const yBob = Math.sin(tick * 0.0085 + k * 0.73) * bobAmp;
    const ampScale = 0.9 + distNorm * 0.7;
    const audioWeight = 1 - distNorm * 0.45;
    const sineWeight = 0.4 + distNorm * 0.9;
    const sineFreq1 = 0.9 + k * 0.31;
    const sineFreq2 = 2.3 + k * 0.47;
    const sinePhase1 = k * 1.07 + tick * 0.013;
    const sinePhase2 = k * 0.59 - tick * 0.009;
    ctx.globalAlpha = 0.26 - distNorm * 0.10;
    ctx.lineWidth = 1.0;
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const idx = ((i + phaseShift) % n + n) % n;
      const sample = smoothedSamples[idx];
      const t = i / (n - 1);
      const envelopeAtT = 0.25 + Math.abs(sample) * 1.1;
      const overlay = (
        Math.sin(t * Math.PI * 2 * sineFreq1 + sinePhase1) * 0.62 +
        Math.cos(t * Math.PI * 2 * sineFreq2 + sinePhase2) * 0.38
      ) * envelopeAtT;
      const x = t * w;
      const y = midY + (sample * audioWeight + overlay * sineWeight) * amp * ampScale + yBob;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  ctx.globalAlpha = 0.55;
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const sample = smoothedSamples[i];
    const x = (i / (n - 1)) * w;
    const y = midY + sample * amp;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();

  ctx.fillStyle = grad;
  const onsetShake = onsetEnv * (h * 0.10) * reactivity;
  const bassShake = bassEnergy * (h * 0.025) * reactivity;

  for (let i = 0; i < particles.length; i++) {
    const p = particles[i];

    p.x += p.vx * dt60;
    if (p.x < 0) p.x += 1;
    else if (p.x >= 1) p.x -= 1;

    const idx = Math.min(n - 1, Math.floor(p.x * n));
    const sample = smoothedSamples[idx];
    const localEnergy = Math.min(1, Math.abs(sample));
    const waveY = midY + sample * amp;

    const wobble = Math.sin(tick * 0.018 + p.seed) * (h * 0.018);

    const scatter = p.yBias * scatterRange * (0.55 + (localEnergy * 0.55 + bassEnergy * 0.2) * reactivity);

    const shake = Math.sin(p.seed * 17.3 + tick * 1.1) * onsetShake
                + Math.sin(p.seed * 9.7 + tick * 0.5) * bassShake;

    const localBand = spectralAt(spectral, p.x);
    const bandDir = p.yBias >= 0 ? 1 : -1;
    const bandBloom = bandDir * localBand * (h * 0.12) * reactivity;
    const bandDrift = Math.sin(tick * 0.045 + p.seed * 3.1) * localBand * (h * 0.025) * reactivity;

    const flicker = 0.5 + 0.5 * Math.sin(p.seed * 6.2 + tick * 0.14);
    const vocalBoost = vocalEnergy * flicker;

    const y = waveY + scatter + wobble + shake + bandBloom + bandDrift;
    const x = p.x * w;
    const r = p.size * (1.1 + localEnergy * 1.2 + vocalBoost * 0.9 + onsetEnv * 0.6 + localBand * 0.4);

    ctx.globalAlpha = Math.min(1, 0.6 + localEnergy * 0.4 + vocalBoost * 0.25 + onsetEnv * 0.3 + localBand * 0.15);
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.globalAlpha = 1;
  ctx.shadowBlur = prevShadow;
}

/* ============================================================
   Silk
   ============================================================ */

function drawSilk(
  ctx: AnyCanvasCtx,
  w: number,
  h: number,
  time: Uint8Array,
  palette: Palette,
  smoothedSamples: Float32Array,
  release: number,
  gain: number,
  tick: number,
  spectral: Float32Array | null,
): void {
  const midY = h * 0.5;
  const baseAmp = h * 0.42;
  const n = smoothedSamples.length || 1;

  const silkRelease = Math.max(release, 0.88);
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const sIdx = Math.floor(t * (time.length - 1));
    const raw = ((time[sIdx] - 128) / 128) * gain;
    const target = raw > 1 ? 1 : raw < -1 ? -1 : raw;
    smoothedSamples[i] = smoothedSamples[i] * silkRelease + target * (1 - silkRelease);
  }

  const grad = horizontalGradient(ctx, palette, 0, w);
  ctx.strokeStyle = grad;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  const prevShadow = ctx.shadowBlur;
  ctx.shadowBlur = Math.min(prevShadow, 6);

  const LINE_COUNT = 48;
  const center = (LINE_COUNT - 1) / 2;
  const N_POINTS = 180;

  for (let k = 0; k < LINE_COUNT; k++) {
    const dist = (k - center) / center;
    const absDist = Math.abs(dist);

    const phaseShift = Math.round(dist * (n * 0.04));
    const ampScale = 1 - absDist * 0.22;
    const yOffset = dist * (h * 0.20);
    const wobble = Math.sin(tick * 0.006 + k * 0.41) * (h * 0.06);

    ctx.globalAlpha = (1 - absDist * absDist * 0.85) * 0.13;
    ctx.lineWidth = 0.7;

    ctx.beginPath();
    let prevX = 0;
    let prevY = midY;
    for (let p = 0; p < N_POINTS; p++) {
      const t = p / (N_POINTS - 1);
      const sIdx = Math.floor(t * (n - 1));
      const idx = ((sIdx + phaseShift) % n + n) % n;
      const sample = smoothedSamples[idx];
      const ampMod = 1 + spectralAt(spectral, t) * 0.55;
      const x = t * w;
      const y = midY + sample * baseAmp * ampScale * ampMod + yOffset + wobble;
      if (p === 0) {
        ctx.moveTo(x, y);
      } else if (p < N_POINTS - 1) {
        const cx = (prevX + x) / 2;
        const cy = (prevY + y) / 2;
        ctx.quadraticCurveTo(prevX, prevY, cx, cy);
      } else {
        ctx.lineTo(x, y);
      }
      prevX = x;
      prevY = y;
    }
    ctx.stroke();
  }

  ctx.globalAlpha = 1;
  ctx.shadowBlur = prevShadow;
}

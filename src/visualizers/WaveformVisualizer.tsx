import { useEffect, useRef } from 'react';
import type { VisualizerProps } from './types';
import { PALETTES, verticalGradient, horizontalGradient, type Palette } from './palettes';
import { applyTrails, glowBlur, roundRectPath, setupHiDPI } from './canvasUtils';

export function WaveformVisualizer({ analyser, settings }: VisualizerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  useEffect(() => {
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext('2d')!;
    const time = new Uint8Array(analyser.fftSize);
    const freq = new Uint8Array(analyser.frequencyBinCount);
    const sampleRate = analyser.context.sampleRate;
    let rafId = 0;

    // Per-bar smoothed amplitudes — persists across frames so values ease
    // toward their target instead of snapping every frame. This is what
    // turns the visualizer from "jittery" into "breathing".
    let smoothed: Float32Array = new Float32Array(0);
    // Per-sample smoothed time-domain values for line/ribbon/filled styles.
    let smoothedSamples: Float32Array = new Float32Array(0);
    // Slow rotation for the radial style.
    let rotation = 0;

    setupHiDPI(canvas, ctx);
    const ro = new ResizeObserver(() => setupHiDPI(canvas, ctx));
    ro.observe(canvas);

    const draw = () => {
      rafId = requestAnimationFrame(draw);
      const s = settingsRef.current;
      const isSpectrum = s.waveformStyle === 'spectrum';
      if (isSpectrum) {
        analyser.getByteFrequencyData(freq);
      } else {
        analyser.getByteTimeDomainData(time);
      }

      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      applyTrails(ctx, w, h, s.trail);

      const palette = PALETTES[s.palette];
      ctx.shadowBlur = glowBlur(s);
      ctx.shadowColor = palette.glowColor;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      // Temporal smoothing coefficient. higher s.smoothing → calmer motion.
      // Map 0..0.95 to a release factor 0.5..0.97. Attack is always fast (~1).
      const release = 0.5 + s.smoothing * 0.47;
      const gain = s.sensitivity;

      // Ensure buffers are sized BEFORE drawing — otherwise the first frame
      // after a resize draws into a zero-length buffer and renders nothing.
      switch (s.waveformStyle) {
        case 'ribbon':
        case 'line':
        case 'filled':
          smoothedSamples = ensureSampleBuffer(smoothedSamples, w);
          break;
        case 'radial':
          smoothed = ensureBarBuffer(smoothed, getRadialBarCount());
          break;
        case 'dots':
          smoothed = ensureBarBuffer(smoothed, getLinearBarCount(w, s.barWidth, s.barGap, 14));
          break;
        case 'mirror':
        case 'bars':
          smoothed = ensureBarBuffer(smoothed, getLinearBarCount(w, s.barWidth, s.barGap));
          break;
        case 'spectrum':
          smoothed = ensureBarBuffer(smoothed, getSpectrumBarCount(w, s.barWidth, s.barGap));
          break;
      }

      switch (s.waveformStyle) {
        case 'ribbon':
          drawRibbon(ctx, w, h, time, palette, smoothedSamples, release, gain);
          break;
        case 'radial':
          rotation += 0.0015;
          drawRadial(ctx, w, h, time, palette, smoothed, release, gain, rotation, s.barWidth);
          break;
        case 'dots':
          drawDots(ctx, w, h, time, palette, smoothed, release, gain, s.barWidth, s.barGap);
          break;
        case 'mirror':
        case 'bars':
          drawBars(ctx, w, h, time, palette, smoothed, release, gain, s.barWidth, s.barGap, s.waveformStyle === 'mirror');
          break;
        case 'line':
          drawLine(ctx, w, h, time, palette, smoothedSamples, release, gain);
          break;
        case 'filled':
          drawFilled(ctx, w, h, time, palette, smoothedSamples, release, gain);
          break;
        case 'spectrum':
          drawSpectrum(ctx, w, h, freq, sampleRate, palette, smoothed, release, gain, s.barWidth);
          break;
      }

      ctx.shadowBlur = 0;
    };
    draw();

    return () => {
      cancelAnimationFrame(rafId);
      ro.disconnect();
    };
  }, [analyser]);

  return <canvas ref={canvasRef} style={{ width: '100%', height: '100%', display: 'block' }} />;
}

/* ============================================================
   Helpers — buffer sizing
   ============================================================ */

function getLinearBarCount(width: number, barWidth: number, barGap: number, minBars = 8): number {
  const slot = barWidth + barGap;
  return Math.max(minBars, Math.floor(width / slot));
}

function getRadialBarCount(): number {
  return 96; // fixed count for the radial style — looks great at this density
}

/** Spectrum bar count driven by the same Width/Gap sliders as the other bar
 *  styles. Capped to a sane upper bound so very small Width values don't
 *  push us past a few hundred FFT-tiny bars. */
function getSpectrumBarCount(width: number, barWidth: number, barGap: number): number {
  const slot = Math.max(2, barWidth + barGap);
  return Math.max(16, Math.min(256, Math.floor(width / slot)));
}

function ensureBarBuffer(buf: Float32Array, n: number): Float32Array {
  if (buf.length !== n) return new Float32Array(n);
  return buf;
}

function ensureSampleBuffer(buf: Float32Array, w: number): Float32Array {
  const target = Math.max(64, Math.floor(w / 2));
  if (Math.abs(buf.length - target) > 16) return new Float32Array(target);
  return buf;
}

function peakPerBar(time: Uint8Array, barIndex: number, samplesPerBar: number): number {
  let peak = 0;
  const base = barIndex * samplesPerBar;
  const end = Math.min(time.length, base + samplesPerBar);
  for (let i = base; i < end; i++) {
    const v = Math.abs(time[i] - 128) / 128;
    if (v > peak) peak = v;
  }
  return peak;
}

function smoothStep(prev: number, next: number, release: number): number {
  // fast attack, slow release
  return next > prev ? next * 0.6 + prev * 0.4 : prev * release + next * (1 - release);
}

/* ============================================================
   Styles
   ============================================================ */

function drawBars(
  ctx: CanvasRenderingContext2D,
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
): void {
  const slot = barWidth + barGap;
  const barCount = getLinearBarCount(w, barWidth, barGap);
  if (smoothed.length !== barCount) {
    // First frame after resize — just fill in fresh values
    const next = new Float32Array(barCount);
    smoothed.set(smoothed.subarray(0, Math.min(smoothed.length, barCount)));
    smoothed = next;
  }
  const startX = (w - barCount * slot + barGap) / 2;
  const midY = h / 2;
  const peakHeight = h * 0.78;
  const samplesPerBar = Math.max(1, Math.floor(time.length / barCount));

  const grad = verticalGradient(ctx, palette, midY - peakHeight / 2, midY + peakHeight / 2);
  ctx.fillStyle = grad;

  for (let b = 0; b < barCount; b++) {
    const peak = peakPerBar(time, b, samplesPerBar);
    const target = Math.min(1, peak * gain);
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
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  time: Uint8Array,
  palette: Palette,
  smoothedSamples: Float32Array,
  release: number,
  gain: number,
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
    const target = ((time[sIdx] - 128) / 128) * gain;
    smoothedSamples[i] = smoothedSamples[i] * release + target * (1 - release);
    const x = t * w;
    const y = midY + smoothedSamples[i] * amp;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
}

function drawFilled(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  time: Uint8Array,
  palette: Palette,
  smoothedSamples: Float32Array,
  release: number,
  gain: number,
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
    const target = Math.abs(((time[sIdx] - 128) / 128) * gain);
    smoothedSamples[i] = smoothedSamples[i] * release + target * (1 - release);
    const x = t * w;
    const y = midY - smoothedSamples[i] * amp;
    ctx.lineTo(x, y);
  }
  ctx.lineTo(w, midY);
  for (let i = n - 1; i >= 0; i--) {
    const t = i / (n - 1);
    const x = t * w;
    const y = midY + smoothedSamples[i] * amp;
    ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fill();
}

/**
 * Ribbon — a smooth gradient curve flowing across the canvas with a soft
 * mirror reflection underneath. Uses quadratic-midpoint smoothing to
 * eliminate hard angles between points.
 */
function drawRibbon(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  time: Uint8Array,
  palette: Palette,
  smoothedSamples: Float32Array,
  release: number,
  gain: number,
): void {
  const midY = h * 0.5;
  const amp = h * 0.32;
  const n = smoothedSamples.length || 1;

  // Smooth-update sample buffer
  const ys = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const sIdx = Math.floor(t * (time.length - 1));
    const target = ((time[sIdx] - 128) / 128) * gain;
    smoothedSamples[i] = smoothedSamples[i] * release + target * (1 - release);
    ys[i] = midY + smoothedSamples[i] * amp;
  }

  const grad = horizontalGradient(ctx, palette, 0, w);

  // ─── reflection (drawn first, underneath the main ribbon)
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

  // ─── main ribbon
  ctx.strokeStyle = grad;
  ctx.lineWidth = 4;
  drawSmoothPath(ctx, ys, n, w);
  ctx.stroke();

  // ─── highlight stroke on top — half-width, brighter
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
  ctx: CanvasRenderingContext2D,
  ys: number[],
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

/**
 * Radial — bars laid out around a circle. Rotates slowly for visual
 * interest, and the bars extend from an inner ring outward, with a
 * subtle inner-glow ring.
 */
function drawRadial(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  time: Uint8Array,
  palette: Palette,
  smoothed: Float32Array,
  release: number,
  gain: number,
  rotation: number,
  barWidth: number,
): void {
  const barCount = getRadialBarCount();
  if (smoothed.length !== barCount) smoothed = new Float32Array(barCount);

  const cx = w / 2;
  const cy = h / 2;
  const minDim = Math.min(w, h);
  const innerRadius = minDim * 0.16;
  const maxLen = minDim * 0.28;

  const samplesPerBar = Math.max(1, Math.floor(time.length / barCount));

  // ─── inner glow ring
  const overallPeak = smoothed.reduce((acc, v) => Math.max(acc, v), 0);
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, innerRadius * (0.9 + overallPeak * 0.15), 0, Math.PI * 2);
  ctx.strokeStyle = palette.glowColor;
  ctx.globalAlpha = 0.4;
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.restore();

  // ─── radial bars
  const grad = ctx.createRadialGradient(cx, cy, innerRadius, cx, cy, innerRadius + maxLen);
  for (const stop of palette.stops) grad.addColorStop(stop.pos, stop.color);
  ctx.strokeStyle = grad;
  ctx.lineCap = 'round';
  ctx.lineWidth = Math.max(2, barWidth * 0.9);

  for (let b = 0; b < barCount; b++) {
    const peak = peakPerBar(time, b, samplesPerBar);
    const target = Math.min(1, peak * gain);
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

/**
 * Spectrum — log-spaced frequency bars mirrored about the midline.
 * Uses FFT magnitude (getByteFrequencyData) rather than time-domain peaks,
 * so vocals and other mid-band content register independently from bass.
 * A gentle high-tilt (^0.4) compensates for music's natural -3dB/octave
 * slope so highs aren't visually swallowed by the low end.
 */
function drawSpectrum(
  ctx: CanvasRenderingContext2D,
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
  // Honor the Width slider directly, but never draw a bar wider than its slot.
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
    const target = Math.min(1, (peak / 255) * gain * tilt * 0.75);
    smoothed[b] = smoothStep(smoothed[b], target, release);

    // 4px min so the bars are clearly visible at rest — useful when first
    // switching styles before audio reaches the analyser.
    const halfH = Math.max(4, smoothed[b] * maxHalfHeight);
    const x = b * slot + (slot - barWidth) / 2;
    roundRectPath(ctx, x, midY - halfH, barWidth, halfH * 2, barWidth / 2);
    ctx.fill();
  }
}

/**
 * Dots — a row of pulsing orbs. Each dot's radius (and bloom) responds to
 * the local amplitude. Subtle gravity toward a baseline keeps the look
 * peaceful even with energetic music.
 */
function drawDots(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  time: Uint8Array,
  palette: Palette,
  smoothed: Float32Array,
  release: number,
  gain: number,
  barWidth: number,
  barGap: number,
): void {
  const dotCount = getLinearBarCount(w, barWidth, barGap, 14);
  if (smoothed.length !== dotCount) smoothed = new Float32Array(dotCount);

  const slot = (barWidth + barGap) * 3; // dots want more breathing room
  const realCount = Math.max(14, Math.floor(w / slot));
  const startX = (w - realCount * slot + slot) / 2;
  const midY = h / 2;
  const maxRadius = Math.min(h * 0.22, slot * 0.55);
  const samplesPerBar = Math.max(1, Math.floor(time.length / realCount));

  const grad = horizontalGradient(ctx, palette, 0, w);
  ctx.fillStyle = grad;

  for (let b = 0; b < realCount; b++) {
    const peak = peakPerBar(time, b, samplesPerBar);
    const target = Math.min(1, peak * gain);
    smoothed[b] = smoothStep(smoothed[b], target, release);
    const r = 3 + smoothed[b] * maxRadius;
    const x = startX + b * slot;
    ctx.beginPath();
    ctx.arc(x, midY, r, 0, Math.PI * 2);
    ctx.fill();
  }
}

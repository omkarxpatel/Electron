/**
 * All visualizer draw functions, extracted from WaveformVisualizer.tsx so
 * they can run in a Web Worker against an OffscreenCanvasRenderingContext2D.
 * The functions themselves are unchanged from the main-thread version — only
 * the context type was loosened to AnyCanvasCtx via the palettes module.
 */

import type { ResolvedSettings } from '../../state/settings';
import {
  PALETTES,
  horizontalGradient,
  sampleRgbAt,
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
  ripples: Ripple[];
  /** Smoothed scope points, centre-relative so the whole trace can be
   *  rotated by the canvas transform rather than recomputed per copy. */
  scopeX: Float32Array | null;
  scopeY: Float32Array | null;
  /** Continuously advancing plot rotation. */
  scopeAngle: number;
  /** Slow-following peak magnitude, used to auto-range the plot so it fills
   *  the stage regardless of how hot the source is. */
  scopePeak: number;
  /** Tick of the last footprint clear — see the quantization note below. */
  scopeClearedAt: number;
  /** Frames left in a footprint fade-out. Counts down; 0 means idle.
   *  Bloom only — Scope ages each trace individually, see scopeEchoes. */
  scopeWipeFor: number;
  /** Recent Scope traces with the tick each was drawn on, oldest first.
   *  Redrawn every frame at an age-derived alpha. */
  scopeEchoes: { path: Path2D; born: number }[];
  /** Lattice strength, 0 = off. Re-rolled on onsets. */
  scopeLattice: number;
  /** Which grid geometry the lattice snaps to — see SCOPE_GRID_*. */
  scopeGridKind: number;
  /** Smoothed tonality of the signal, plus the slow bounds it is normalized
   *  against. See coherenceOf. */
  scopeCoherence: number;
  scopeCohLo: number;
  scopeCohHi: number;
  /** Slow running peak of the bass delta, used to scale the onset threshold
   *  to the material. */
  scopeDeltaPeak: number;
  /** Tick of the last shape re-roll, so a figure cannot hold forever. */
  scopeLastRoll: number;
  /** Rotational symmetry, re-rolled on strong onsets. */
  scopeSymmetry: number;
  /** Spin direction, +1 or -1. Flips on some onsets. Shared by both radial
   *  styles. */
  scopeSpin: number;
  /** Rotation-rate multiplier: the value being eased toward, and the eased
   *  value actually applied. Separate so a rate change glides instead of
   *  stepping. */
  scopeSpinTarget: number;
  scopeSpinCur: number;
  /** Transient boost added by bass onsets, decaying back to zero. */
  scopeSpinKick: number;
  /** Peripheral ambience: one lit-ness value per corner band, and the slow
   *  running peak each is normalized against. See drawScopeAmbience. */
  scopeAmbEnv: Float32Array;
  scopeAmbPeak: Float32Array;
  /** Frequency ratio applied to the R axis, re-rolled on onsets. Integer-ish
   *  ratios are what turn a Lissajous figure into a closed geometric form. */
  scopeRatio: number;
  /** Crystal: nested copies of the figure, 1..3. */
  crystalLayers: number;
  /** Crystal: superformula fold count. Snapped on change, never interpolated
   *  — a fractional m leaves the curve open where it should close. */
  crystalM: number;
  /** Crystal: superformula exponents [n1, n2, n3], eased toward crystalNTo so
   *  a shape change morphs instead of cutting. */
  crystalN: Float32Array;
  crystalNTo: Float32Array;
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
    ripples: [],
    scopeX: null,
    scopeY: null,
    scopeAngle: 0,
    scopePeak: 0.5,
    scopeClearedAt: 0,
    scopeWipeFor: 0,
    scopeEchoes: [],
    scopeLattice: 1,
    // Module consts are initialised before any call to this, so the forward
    // reference is safe and reads better than a bare 0.
    scopeGridKind: SCOPE_GRID_POLAR,
    scopeCoherence: 0.5,
    scopeCohLo: 0.3,
    scopeCohHi: 0.7,
    scopeDeltaPeak: 0.02,
    scopeLastRoll: 0,
    scopeSymmetry: 3,
    scopeSpin: 1,
    scopeSpinTarget: 1,
    scopeSpinCur: 1,
    scopeSpinKick: 0,
    scopeAmbEnv: new Float32Array(4),
    scopeAmbPeak: new Float32Array(4),
    scopeRatio: 1,
    crystalLayers: 2,
    crystalM: 6,
    crystalN: new Float32Array([0.6, 1.4, 1.4]),
    crystalNTo: new Float32Array([0.6, 1.4, 1.4]),
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
  settings: ResolvedSettings,
  state: DrawState,
  paletteOverride: Palette | null = null,
  /** Per-channel time domain. Only supplied for stereo styles; undefined
   *  otherwise, in which case those styles fall back to mono. */
  timeL?: Uint8Array,
  timeR?: Uint8Array,
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

  // Scope is a phosphor accumulator rather than a redraw: each frame lays down
  // a faint trace and the figure BUILDS over time, then decays. The global
  // trail range (0..0.6) wipes a frame in about five frames, far too fast for
  // anything to accumulate, so it is remapped into a persistence range while
  // the slider still controls relative length.
  // Coherence decides how long a pattern is allowed to stand, never how
  // bright it is. Driving brightness from it made the whole stage pulse in
  // and out with the music, which reads as the visualizer flickering rather
  // than as a pattern resolving. coherenceOf carries smoothing state — call
  // it exactly once per frame, and it has to happen here because applyTrails
  // runs before the style switch.
  const scopeInk =
    s.waveformStyle === 'lissajous'
      ? Math.pow(coherenceOf(freq, sampleRate, state, dt60), 2)
      : 0;

  // Capped below 0.94: past that the quantization floor (see
  // scopeOnsetAndWipe) leaves residue bright enough to read as a grey
  // footprint over the whole stage.
  let effTrail =
    s.waveformStyle === 'lissajous' || s.waveformStyle === 'crystal'
      ? 0.88 + Math.min(0.6, s.trail) * 0.085
      : s.trail;

  // ── Footprint fade-out ──
  // This used to be a clearRect, which emptied the stage between one frame
  // and the next — the footprint wasn't decaying, it was being deleted.
  // Ramping the decay down dissolves it over about half a second instead.
  // The floor has to dip below 0.5 to achieve anything: above that,
  // `round(1 * trail) === 1` and the faintest residue rounds back to itself
  // forever, which is the whole reason a periodic clear was needed at all.
  if (state.scopeWipeFor > 0) {
    const t = state.scopeWipeFor / SCOPE_WIPE_FRAMES;
    effTrail = 0.44 + (effTrail - 0.44) * t;
    state.scopeWipeFor = Math.max(0, state.scopeWipeFor - dt60);
  }
  if (s.waveformStyle === 'lissajous') {
    // Scope repaints its history from the echo buffer every frame, so the
    // canvas starts clean instead of carrying anything over.
    ctx.clearRect(0, 0, width, height);
  } else {
    applyTrails(ctx, width, height, effTrail);
  }

  // Album-art tint overrides the static palette when present. The worker
  // receives null when "Auto-tint from album art" is off or no track is
  // playing — fall back to the user's selection in ResolvedSettings.
  const palette = paletteOverride ?? PALETTES[s.palette];

  // ── Why the radial styles opt out of the canvas shadow ──
  // Scope and Bloom draw their own glow: a wide, very translucent stroke of
  // the whole path underneath the fine ones. The canvas shadow does the same
  // job again, and it is not a cheap duplicate — shadowBlur is applied per
  // stroke, and Scope issues roughly fifty per frame (symmetry copies times
  // dwell levels, plus the echo history), each blurred across the entire
  // backing store. Measured on a 1512x850 retina stage: 250 ms a frame with
  // the shadow on, 8.3 ms with it off, same geometry. That is 4 fps versus
  // the display's full rate, and it is the whole of the reported lag.
  const ownBloom = s.waveformStyle === 'lissajous' || s.waveformStyle === 'crystal';
  ctx.shadowBlur = ownBloom ? 0 : glowBlur(s);
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
    case 'particles': {
      state.smoothedSamples = ensureSampleBuffer(state.smoothedSamples, width);
      // Density, not a fixed count — 320 particles look right in the banner
      // and vanishingly sparse over a fullscreen stage.
      // `s` is already resolved against this stage's profile by the main
      // thread, so density is simply the active stage's value.
      const want = particleCountFor(width, height, s.particleDensity);
      if (!state.particles || state.particles.length !== want) {
        state.particles = createParticles(want);
      }
      break;
    }
    case 'silk':
      state.smoothedSamples = ensureSampleBuffer(state.smoothedSamples, width);
      break;
    case 'lissajous':
    case 'crystal':
    case 'ripples':
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
        s.particleSize,
      );
      break;
    }
    case 'lissajous': {
      state.tick += dt60;
      const n = Math.min((timeL ?? time).length, (timeR ?? time).length);
      if (!state.scopeX || state.scopeX.length !== n) {
        state.scopeX = new Float32Array(n);
        state.scopeY = new Float32Array(n);
      }
      // Light the rim before anything else goes down, so the geometry and
      // its echo history both sit on top of it. Immersive only: four corner
      // glows across a 110px banner strip is a smear, not a surround.
      if (isLargeStage(stageScaleOf(height))) {
        drawScopeAmbience(ctx, width, height, freq, sampleRate, palette, state, s.scopeAmbience, dt60);
      }
      // ── Spend the ink on the coherent frames ──
      // scopeInk was measured above, before applyTrails.
      // Most of the time this style is plotting noise, and only occasionally
      // does the signal line up into a closed figure. Rather than average the
      // two together — which is what produced a permanent wash of slop with
      // the good moments buried in it — measure which one is happening and
      // spend accordingly: coherent frames draw bright, hold still and are
      // left alone to accumulate; incoherent ones barely mark the canvas.
      // What survives on screen after a few seconds is the geometry.
      const ink = scopeInk;
      {
        const bDelta = bassDeltaOf(freq, sampleRate, state);
        // Re-rolling symmetry, spin, ratio and lattice on bass hits is what
        // makes the figure evolve instead of being one shape forever.
        // Coherence biases this rather than blocking it: a hard gate held the
        // shape frozen through every tonal passage, which traded away all the
        // variety to buy stability. A probability keeps a good pattern
        // standing most of the time while still letting it surprise you.
        // ── Onset threshold, relative to the material ──
        // A fixed threshold only fires on music with hard bass transients.
        // Measured over 30 s against three signals it produced 172 shape
        // changes on a punchy kick and exactly zero on both sustained and
        // compressed bass — so on most produced music the figure locked and
        // never moved again. Scaling to the loudest delta seen recently makes
        // "an onset" mean something relative to this track rather than to an
        // absolute level that half of all material never reaches.
        state.scopeDeltaPeak = Math.max(bDelta, state.scopeDeltaPeak * 0.999);
        const onsetThresh = Math.max(0.012, state.scopeDeltaPeak * 0.45);

        // Each onset shoves the rotation and the shove bleeds off, so hits
        // land as a visible lurch on top of whatever the steady rate is.
        if (bDelta > onsetThresh) {
          state.scopeSpinKick = Math.min(2.5, state.scopeSpinKick + bDelta * 5);
        }
        state.scopeSpinKick *= Math.pow(0.93, dt60);
        const stale = state.tick - state.scopeLastRoll > SCOPE_MAX_DWELL;

        if ((bDelta > onsetThresh || stale) && Math.random() > ink * 0.6) {
          state.scopeLastRoll = state.tick;
          const roll = Math.random();
          if (roll < 0.34) {
            state.scopeSymmetry = 2 + Math.floor(Math.random() * 7); // 2..8
          } else if (roll < 0.5) {
            // Direction and rate together. Flipping direction alone always
            // looked the same, because the rate never changed — the figure
            // wheeled at one speed forever and only ever reversed. Re-rolling
            // the multiplier is what makes the motion read as phrased rather
            // than as a metronome. 0 is in the set not to stop the figure —
            // measured, it is never still, because the onset kick keeps
            // feeding it — but to drop the steady rate away so that between
            // hits it drifts and on each hit it lurches.
            if (Math.random() < 0.55) state.scopeSpin = -state.scopeSpin;
            const RATES = [0, 0.3, 0.7, 1, 1.6, 2.6, 4];
            state.scopeSpinTarget = RATES[Math.floor(Math.random() * RATES.length)];
          } else if (roll < 0.74) {
            // Small rational ratios give closed, knot-like figures; anything
            // far from one just smears. A wider set than before, since this
            // is the main source of shape variety.
            const RATIOS = [0.5, 2 / 3, 0.75, 1, 1.25, 1.5, 5 / 3, 2, 2.5, 3, 4];
            state.scopeRatio = RATIOS[Math.floor(Math.random() * RATIOS.length)];
          } else {
            // Weighted hard toward the coarse grid. The even-ish split this
            // replaces spent more than half its time at lattice 0 — the
            // ungridded free curve — and only about a sixth on the coarse
            // grid, which is the look actually worth showing. 2 and 3 stay in
            // as occasional variety and 0 as contrast, but none of them are
            // the default any more.
            const r = Math.random();
            state.scopeLattice = r < 0.7 ? 1 : r < 0.82 ? 2 : r < 0.9 ? 3 : 0;
            // Change the grid's geometry only some of the time, so a given
            // cell shape gets to be explored at several coarsenesses before
            // it is swapped out.
            if (Math.random() < 0.45) {
              state.scopeGridKind = Math.floor(Math.random() * SCOPE_GRID_COUNT);
            }
          }
        }
      }
      // Eased toward the target so a rate change glides rather than steps —
      // an instant jump in angular velocity reads as a glitch.
      state.scopeSpinCur +=
        (state.scopeSpinTarget - state.scopeSpinCur) * (1 - Math.pow(0.97, dt60));
      // Slower while a pattern is resolving: a figure that holds its angle
      // superimposes on itself frame after frame and sharpens, where one that
      // keeps turning smears its own detail away.
      state.scopeAngle +=
        (0.0004 + Math.min(0.001, state.envelope * 0.0015)) *
        (1 - 0.35 * ink) *
        (state.scopeSpinCur + state.scopeSpinKick) *
        state.scopeSpin * dt60;
      state.scopePeak = drawLissajous(
        ctx, width, height, time, timeL, timeR, palette, gain,
        state.scopeX, state.scopeY!, s.glow, s.smoothing, state.scopeAngle,
        state.scopePeak, state.tick, state.scopeSymmetry, state.scopeRatio,
        s.scopeDensity, state.scopeLattice, state.scopeGridKind,
        state.scopeEchoes,
      );
      break;
    }
    case 'crystal': {
      state.tick += dt60;
      const n = Math.min((timeL ?? time).length, (timeR ?? time).length);
      if (!state.scopeX || state.scopeX.length !== n) {
        state.scopeX = new Float32Array(n);
        state.scopeY = new Float32Array(n);
      }
      // Picking a new shape on strong bass hits is what makes the figure
      // evolve instead of being one form forever. Long persistence means the
      // old outline is still fading as the new one draws, so a change reads
      // as a morph rather than a cut.
      {
        const bDelta = scopeOnsetAndWipe(freq, sampleRate, state);
        if (bDelta > 0.055) {
          const roll = Math.random();
          if (roll < 0.58) {
            const pick = CRYSTAL_SHAPES[Math.floor(Math.random() * CRYSTAL_SHAPES.length)];
            state.crystalM = pick[0];
            state.crystalNTo[0] = pick[1];
            state.crystalNTo[1] = pick[2];
            state.crystalNTo[2] = pick[3];
          } else if (roll < 0.8) {
            state.scopeSpin = -state.scopeSpin;
          } else {
            state.crystalLayers = 1 + Math.floor(Math.random() * 3); // 1..3
          }
        }
      }
      // Ease the exponents toward the target. Both endpoints come from the
      // curated table, so the path between them stays in the part of the
      // parameter space that looks like something.
      {
        const k = 1 - Math.pow(0.94, dt60);
        for (let i = 0; i < 3; i++) {
          state.crystalN[i] += (state.crystalNTo[i] - state.crystalN[i]) * k;
        }
      }
      state.scopeAngle +=
        (0.0008 + Math.min(0.002, state.envelope * 0.003)) * state.scopeSpin * dt60;
      state.scopePeak = drawCrystal(
        ctx, width, height, time, timeL, timeR, palette, gain,
        state.scopeX, state.scopeY!, s.glow, s.smoothing, state.scopeAngle,
        state.scopePeak, state.tick, state.crystalLayers, state.crystalM,
        state.crystalN, s.scopeDensity,
      );
      break;
    }
    case 'ripples': {
      state.tick += dt60;
      const nyq = sampleRate / 2;
      const bEnd = Math.max(2, Math.floor((200 / nyq) * freq.length));
      let bSum = 0;
      for (let i = 1; i < bEnd; i++) bSum += freq[i];
      const bEnergy = bSum / Math.max(1, bEnd - 1) / 255;
      const bDelta = bEnergy - state.prevBassEnergy;
      state.prevBassEnergy = bEnergy;
      if (bDelta > 0.035) {
        state.ripples.push({ r: 0, born: state.tick, strength: Math.min(1, bDelta * 5) });
        // Cap so a noisy onset detector can't grow this without bound.
        if (state.ripples.length > 28) state.ripples.shift();
      }
      drawRipples(ctx, width, height, palette, state.ripples, state.tick, dt60, gain, state.envelope);
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
  /** 0 = far, 1 = near. Only used on large stages, where it drives parallax
   *  drift, radius and alpha so the field reads as depth instead of a flat
   *  sheet of identical specks. */
  depth: number;
}

/* ── Stage scale ───────────────────────────────────────────────────────
 * Every vertical term in these draw styles is expressed as a fraction of
 * canvas height, which is correct for size but wrong for *motion*. The
 * banner is ~110px; immersive is ~900px. A shake written as `h * 0.10` goes
 * from an 11px shimmer to an 89px convulsion while its oscillation rate
 * stays put, which is why fullscreen particles read as vibration rather
 * than movement.
 *
 * `stageScale` is height relative to the banner. Amplitudes that represent
 * MOTION get damped by `motionDamp` so they grow with sqrt(height) instead
 * of height — big stages move further in absolute pixels, but far less than
 * proportionally, so the perceived tempo stays put. Amplitudes that
 * represent LAYOUT (waveform height, scatter spread) keep scaling linearly,
 * because those should fill the stage.
 * ─────────────────────────────────────────────────────────────────────── */

const BANNER_H = 110;

/** Height relative to the reference banner. 1 in the strip, ~8 fullscreen. */
function stageScaleOf(h: number): number {
  return Math.max(1, h / BANNER_H);
}

/** Motion damping: 1 at banner size, ~0.35 at 8x. Multiply any oscillating
 *  amplitude by this so its absolute travel grows sub-linearly. */
function motionDampOf(scale: number): number {
  return 1 / Math.sqrt(scale);
}

/** Gentler damping for SLOW oscillations. A 0.5 Hz sway can afford to grow
 *  most of the way with the stage — it reads as majesty, not jitter. Only
 *  fast terms (particles' ~10 Hz shake) need the full sqrt damp. */
function slowDampOf(damp: number): number {
  return 0.55 + 0.45 * damp;
}

/** Immersive gets extra detail the strip has no room for. */
function isLargeStage(scale: number): boolean {
  return scale >= 3;
}

const PARTICLE_COUNT = 320;
/** Particles per 100k css px^2, used to hold density constant as area grows.
 *  Capped so a 4K stage doesn't quietly become a 5000-particle loop. */
const PARTICLE_DENSITY = 320 / (1280 * BANNER_H / 100000);
const PARTICLE_MAX = 1400;

/** Floor is low enough to be genuinely sparse — at density 0.15 on a banner
 *  you want a scattering, not a crowd — but never zero, which would read as
 *  the style being broken rather than dialled down. */
const PARTICLE_MIN = 24;

function particleCountFor(w: number, h: number, density: number): number {
  const area = (w * h) / 100000;
  const base = Math.max(PARTICLE_COUNT, area * PARTICLE_DENSITY);
  return Math.max(PARTICLE_MIN, Math.min(PARTICLE_MAX, Math.round(base * density)));
}

function createParticles(n: number): Particle[] {
  const out: Particle[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const u = Math.random() * 2 - 1;
    out[i] = {
      x: Math.random(),
      yBias: u * u * u,
      size: 0.4 + Math.random() * 2.0,
      depth: Math.random(),
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
  sizeMul: number,
): void {
  const reactivity = Math.min(1.4, Math.max(0.3, sensitivity));
  const scale = stageScaleOf(h);
  const damp = motionDampOf(scale);
  const large = isLargeStage(scale);
  const slowDamp = slowDampOf(damp);
  const midY = h * 0.5;
  // Layout terms stay proportional — the field should fill whatever stage
  // it's given. Only the oscillating terms below get damped.
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
    const bobAmp =
      h * (0.04 + dist * 0.06) * (1 + onsetEnv * 0.25) * (0.6 + reactivity * 0.4) * slowDamp;
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
  // Damped: these are oscillations, not layout. Undamped they scaled 8x into
  // fullscreen at unchanged frequency, which is the "vibration" problem.
  const onsetShake = onsetEnv * (h * 0.10) * reactivity * damp;
  const bassShake = bassEnergy * (h * 0.025) * reactivity * damp;
  // Radius has to grow with the stage or particles stay 0.4-2.4px specks on
  // a 900px canvas. sqrt keeps them from becoming blobs.
  const sizeScale = Math.sqrt(scale) * sizeMul;

  for (let i = 0; i < particles.length; i++) {
    const p = particles[i];

    // Depth only registers on a large stage; in the strip there isn't enough
    // vertical room for parallax to read as anything but noise.
    const depth = large ? 0.45 + p.depth * 0.55 : 1;

    p.x += p.vx * dt60 * depth;
    if (p.x < 0) p.x += 1;
    else if (p.x >= 1) p.x -= 1;

    const idx = Math.min(n - 1, Math.floor(p.x * n));
    const sample = smoothedSamples[idx];
    const localEnergy = Math.min(1, Math.abs(sample));
    const waveY = midY + sample * amp * depth;

    const wobble = Math.sin(tick * 0.018 + p.seed) * (h * 0.018) * damp;

    const scatter = p.yBias * scatterRange * (0.55 + (localEnergy * 0.55 + bassEnergy * 0.2) * reactivity);

    const shake = (Math.sin(p.seed * 17.3 + tick * 1.1) * onsetShake
                + Math.sin(p.seed * 9.7 + tick * 0.5) * bassShake) * depth;

    const localBand = spectralAt(spectral, p.x);
    const bandDir = p.yBias >= 0 ? 1 : -1;
    const bandBloom = bandDir * localBand * (h * 0.12) * reactivity * depth;
    const bandDrift = Math.sin(tick * 0.045 + p.seed * 3.1) * localBand * (h * 0.025) * reactivity * damp;

    const flicker = 0.5 + 0.5 * Math.sin(p.seed * 6.2 + tick * 0.14);
    const vocalBoost = vocalEnergy * flicker;

    const y = waveY + scatter + wobble + shake + bandBloom + bandDrift;
    const x = p.x * w;
    const r = p.size * sizeScale * depth
      * (1.1 + localEnergy * 1.2 + vocalBoost * 0.9 + onsetEnv * 0.6 + localBand * 0.4);

    // Fade with depth so the far layer recedes instead of every particle
    // competing at full strength — this is most of what makes the large
    // stage read as a field rather than static.
    ctx.globalAlpha =
      Math.min(1, 0.6 + localEnergy * 0.4 + vocalBoost * 0.25 + onsetEnv * 0.3 + localBand * 0.15)
      * (large ? 0.35 + depth * 0.65 : 1);
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
  const slowDamp = slowDampOf(motionDampOf(stageScaleOf(h)));
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
    const wobble = Math.sin(tick * 0.006 + k * 0.41) * (h * 0.06) * slowDamp;

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


/* ── Scope (stereo goniometer) ─────────────────────────────────────────── */

/**
 * Plots left channel against right as an XY scope — the classic studio
 * goniometer, rotated 45 degrees so mono sits vertical.
 *
 * Reading it: a mono signal puts L === R, which collapses to a single
 * vertical line. Widening the stereo image opens that line into a blob or
 * loop. Out-of-phase content swings toward horizontal. So the shape IS the
 * stereo image, which is why this is worth having next to an EQ.
 *
 * Falls back to a diagonal mono trace when per-channel data is absent (the
 * graph hasn't built its splitter yet), rather than rendering nothing.
 */
/** Fraction of the available radius the auto-range aims to fill. */
const SCOPE_FILL = 0.92;

/** Frames a footprint fade-out runs for — long enough to read as the trace
 *  dissolving rather than being cut away. Crystal only. */
const SCOPE_WIPE_FRAMES = 34;

/* ── Scope echoes ──────────────────────────────────────────────────────────
 *
 * Scope keeps its recent traces and redraws them each frame at an alpha set by
 * their age, rather than letting them pile up on the canvas under a decay.
 *
 * Canvas decay cannot express "gone after one second". It is multiplicative
 * and alpha is 8-bit, so `round(a * trail) === a` for any small a: the
 * faintest ink stalls a hair above zero and stays there. Measured over thirty
 * seconds the stage only cleared six times, so what was on screen was a
 * superposition of hundreds of frames — and since that pile dwarfed each new
 * trace, the figure looked static even though its shape was re-rolling about
 * twice a second. Giving every trace a real age fixes the footprint and the
 * staleness together.
 * ─────────────────────────────────────────────────────────────────────── */

/** Ticks a trace stays visible — one second at 60 Hz. */
const SCOPE_ECHO_LIFE = 60;

/* ── Grid geometries ───────────────────────────────────────────────────────
 *
 * The lattice snaps each point onto a grid; these are the grids it can snap
 * to. Only the polar one existed at first, which meant every gridded figure
 * was built from spokes and rings. The rest give the same construction a
 * different underlying cell — square, diamond, triangular — and the shapes
 * that grow outward from them differ accordingly.
 * ─────────────────────────────────────────────────────────────────────── */
const SCOPE_GRID_POLAR = 0;
const SCOPE_GRID_SQUARE = 1;
const SCOPE_GRID_DIAMOND = 2;
const SCOPE_GRID_TRIANGLE = 3;
const SCOPE_GRID_COUNT = 4;

/** Longest a single figure may hold before a re-roll is forced, regardless of
 *  what the onset detector thinks. Ambient material can genuinely contain no
 *  onsets at all, and the visualizer still has to go somewhere. */
const SCOPE_MAX_DWELL = 300;
/** Capture one trace in every N frames. */
const SCOPE_ECHO_EVERY = 3;
/** Points kept per captured trace. */
const SCOPE_ECHO_POINTS = 160;
/** Peak echo alpha, at age zero. Tuned so the stage reads at the same overall
 *  brightness as the decay-based version it replaces. */
const SCOPE_ECHO_ALPHA = 0.11;

/* ── Scope colour ──────────────────────────────────────────────────────────
 *
 * Two things make the middle of the figure illegible, and they compound.
 * Every symmetry copy is rotated about the origin, so near r = 0 they all
 * coincide and lay down N times the ink the rim gets. And a palette's first
 * stop — its brightest — sits at pos 0, which is exactly there. The result
 * saturates to a featureless white mass while the interesting geometry is
 * out at the edges.
 *
 * So: fan the copies apart by hue, and fade the core out.
 * ─────────────────────────────────────────────────────────────────────── */

/** Degrees of hue the copies are spread across. Wide enough to separate them
 *  at a glance, short of a full wheel so the figure still reads as one
 *  object rather than a pile of unrelated shapes. */
const SCOPE_HUE_ARC = 210;
/** Saturation floor and lightness ceiling forced on the offset copies.
 *  Rotating the hue of a monochrome palette (Mono, Bone, a greyscale album
 *  tint) does nothing, and a near-white stop swallows whatever saturation you
 *  hand it — so the spread would vanish on exactly the palettes that need it
 *  most. Copy 0 is exempt from both: the trace the eye locks onto is still
 *  the color the user picked. */
const SCOPE_COPY_SAT = 0.5;
const SCOPE_COPY_LIGHT = 0.66;
/** Fraction of the radius the stroke fades up over, from fully transparent
 *  at the centre. This is the de-cluttering half of the change — it costs
 *  nothing per stroke because it rides along in the gradient that was
 *  already being used as the stroke style. */
const SCOPE_CORE_FADE = 0.34;

/** Build the stroke gradient for one symmetry copy: the palette, hue-rotated
 *  by `hueShift` degrees, ramped from transparent at the centre. */
function scopeGradient(
  ctx: AnyCanvasCtx,
  radius: number,
  palette: Palette,
  hueShift: number,
  recolor: boolean,
): CanvasGradient {
  const g = ctx.createRadialGradient(0, 0, 0, 0, 0, radius);
  // The palette's own stops, plus three inside the fade zone — palettes
  // rarely place anything down there and the alpha ramp needs the resolution.
  const positions = new Set<number>([0, SCOPE_CORE_FADE * 0.4, SCOPE_CORE_FADE]);
  for (const s of palette.stops) positions.add(Math.min(1, Math.max(0, s.pos)));
  for (const pos of [...positions].sort((a, b) => a - b)) {
    // Squared-ish ramp rather than linear: a straight fade still leaves the
    // centre bright enough to pile up, since the overlap there is severe.
    const alpha = Math.pow(Math.min(1, pos / SCOPE_CORE_FADE), 1.7);
    const [r, gr, b] = sampleRgbAt(palette, pos);
    if (!recolor && hueShift === 0) {
      g.addColorStop(pos, `rgba(${r}, ${gr}, ${b}, ${alpha.toFixed(3)})`);
      continue;
    }
    let [hh, ss, ll] = rgbToHsl(r, gr, b);
    hh = (((hh + hueShift / 360) % 1) + 1) % 1;
    if (recolor) {
      ss = Math.max(ss, SCOPE_COPY_SAT);
      ll = Math.min(ll, SCOPE_COPY_LIGHT);
    }
    const [cr, cg, cb] = hslToRgb(hh, ss, ll);
    g.addColorStop(pos, `rgba(${cr}, ${cg}, ${cb}, ${alpha.toFixed(3)})`);
  }
  return g;
}

/** 0..255 channels in, h/s/l in 0..1 out. */
function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return [0, 0, l];
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6;
  else if (max === gn) h = ((bn - rn) / d + 2) / 6;
  else h = ((rn - gn) / d + 4) / 6;
  return [h, s, l];
}

/** Inverse of rgbToHsl. */
function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) {
    const v = Math.round(l * 255);
    return [v, v, v];
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const chan = (t: number) => {
    let x = t;
    if (x < 0) x += 1;
    if (x > 1) x -= 1;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  return [
    Math.round(chan(h + 1 / 3) * 255),
    Math.round(chan(h) * 255),
    Math.round(chan(h - 1 / 3) * 255),
  ];
}

/** Bass-onset detection plus the periodic hard wipe, shared by both radial
 *  styles since both build their image up over many frames.
 *
 *  The wipe is not optional. Alpha decay is multiplicative and canvas alpha
 *  is 8-bit, so once a pixel reaches 1/255, `1 * 0.9` rounds straight back to
 *  1: faint geometry stalls just above zero and accumulates into a permanent
 *  grey footprint that decay can never clear. Scheduling a hard fade-out on a
 *  strong onset hides the reset behind the burst of new energy that
 *  immediately repaints the figure.
 *
 *  Returns the frame's bass delta so the caller can drive its own geometry
 *  changes from the same onset. */
function bassDeltaOf(freq: Uint8Array, sampleRate: number, state: DrawState): number {
  const nyq = sampleRate / 2;
  const bEnd = Math.max(2, Math.floor((200 / nyq) * freq.length));
  let bSum = 0;
  for (let i = 1; i < bEnd; i++) bSum += freq[i];
  const bEnergy = bSum / Math.max(1, bEnd - 1) / 255;
  const bDelta = bEnergy - state.prevBassEnergy;
  state.prevBassEnergy = bEnergy;
  return bDelta;
}

/** Bloom's variant: the same onset reading plus the periodic footprint fade
 *  it still relies on. Scope ages each trace instead. */
function scopeOnsetAndWipe(
  freq: Uint8Array,
  sampleRate: number,
  state: DrawState,
  minFrames = 170,
  maxFrames = 620,
): number {
  const bDelta = bassDeltaOf(freq, sampleRate, state);
  const sinceClear = state.tick - state.scopeClearedAt;
  if ((bDelta > 0.05 && sinceClear > minFrames) || sinceClear > maxFrames) {
    state.scopeWipeFor = SCOPE_WIPE_FRAMES;
    state.scopeClearedAt = state.tick;
  }
  return bDelta;
}

/**
 * How tonal this frame is, 0..1 — in effect, "is the Scope about to look
 * good?"
 *
 * Spectral flatness (geometric mean over arithmetic mean) sits near 0 when a
 * few partials dominate and near 1 for broadband noise. That maps directly
 * onto whether the goniometer will close, because a Lissajous figure only
 * closes when both axes are driven by a few harmonically related tones. The
 * detector and the thing being detected are the same property.
 *
 * The result is normalized against slowly tracked bounds rather than an
 * absolute threshold. Raw flatness on a dense trap mix never approaches what
 * a solo piano hits, so a fixed cutoff would leave the effect permanently off
 * for some music and permanently on for other music. Bracketing the last ~30
 * seconds instead means "coherent for this song" always spans the full range.
 */
function coherenceOf(
  freq: Uint8Array,
  sampleRate: number,
  state: DrawState,
  dt60: number,
): number {
  const nyq = sampleRate / 2;
  const lo = Math.max(1, Math.floor((60 / nyq) * freq.length));
  const hi = Math.min(freq.length - 1, Math.floor((5000 / nyq) * freq.length));
  if (hi <= lo) return 0;
  let logSum = 0;
  let sum = 0;
  for (let i = lo; i <= hi; i++) {
    // The epsilon keeps log() finite on empty bins and sets how much a silent
    // band counts as "tonal"; without it a near-silent frame reads as pure
    // tone and the figure flares during gaps.
    const v = freq[i] / 255 + 0.004;
    logSum += Math.log(v);
    sum += v;
  }
  const count = hi - lo + 1;
  const flatness = Math.exp(logSum / count) / (sum / count);
  const tonal = 1 - Math.min(1, flatness);

  const k = 1 - Math.pow(0.88, dt60);
  state.scopeCoherence += (tonal - state.scopeCoherence) * k;
  const c = state.scopeCoherence;

  // Each bound snaps outward immediately and relaxes back toward the signal
  // slowly, so the pair brackets recent material instead of latching onto the
  // loudest moment of the session.
  const relax = Math.pow(0.9995, dt60);
  state.scopeCohLo = c < state.scopeCohLo ? c : state.scopeCohLo * relax + c * (1 - relax);
  state.scopeCohHi = c > state.scopeCohHi ? c : state.scopeCohHi * relax + c * (1 - relax);

  const span = Math.max(0.02, state.scopeCohHi - state.scopeCohLo);
  return Math.min(1, Math.max(0, (c - state.scopeCohLo) / span));
}

/* ============================================================
   Peripheral ambience
   ============================================================ */

/** One frequency band per corner, walking the rim in ascending order so the
 *  lighting reads as the spectrum wrapped around the frame rather than as
 *  four unrelated lamps. Lows sit at the bottom, air at the top. */
const SCOPE_AMB_BANDS: readonly (readonly [number, number])[] = [
  [20, 140],     // bottom-left  — sub
  [140, 620],    // bottom-right — low-mid
  [620, 2800],   // top-right    — high-mid
  [2800, 11000], // top-left     — air
];
/** Corner positions as fractions of the stage, in the same order. */
const SCOPE_AMB_AT: readonly (readonly [number, number])[] = [
  [0, 1], [1, 1], [1, 0], [0, 0],
];
/** How far a corner glow reaches, relative to the longer stage edge. Large
 *  enough that adjacent corners overlap along the edge between them —
 *  otherwise the four midpoints of the frame stay black and the effect reads
 *  as spotlights rather than as surround. */
const SCOPE_AMB_REACH = 0.8;
/** Lit-ness release per 60 Hz frame. Attack is instant. Slow on purpose: the
 *  brief was "mild", and a rim that tracks the envelope sample-for-sample
 *  strobes. */
const SCOPE_AMB_RELEASE = 0.94;
/** Per-band headroom decay. Same trick as the onset threshold and the
 *  coherence bounds — a fixed scale would leave the air corner permanently
 *  dark, since it never approaches the level the bass band sits at. */
const SCOPE_AMB_PEAK_DECAY = 0.9995;
/** Degrees of hue between one corner and the next. Sampling the palette at
 *  four positions is not enough on its own: most of these palettes are a
 *  narrow ramp, and Spotify is a single green, so all four corners came out
 *  the same colour and the rim read as a flat vignette. Rotating the hue as
 *  well spreads them over about two thirds of the wheel, which stays related
 *  to the palette while making each corner its own light. Same arc idea as
 *  SCOPE_HUE_ARC, which fans the symmetry copies. */
const SCOPE_AMB_HUE_STEP = 62;
/** Saturation floor, so a near-white or near-grey palette stop still tints
 *  its corner instead of washing it out. */
const SCOPE_AMB_SAT = 0.45;

/**
 * A soft wash of light around the edge of the stage, under everything else.
 *
 * Scope draws inside the middle of the frame and leaves the corners black,
 * which is what made a large stage feel empty around the geometry. This fills
 * that space with light rather than with more geometry — four corner
 * gradients in `lighter`, each driven by its own band, each drifting through
 * the palette at its own offset. It adds no lines to read, so the figure
 * keeps its legibility while the frame stops being dead.
 */
function drawScopeAmbience(
  ctx: AnyCanvasCtx,
  w: number,
  h: number,
  freq: Uint8Array,
  sampleRate: number,
  palette: Palette,
  state: DrawState,
  amount: number,
  dt60: number,
): void {
  const nyq = sampleRate / 2;
  const rel = Math.pow(SCOPE_AMB_RELEASE, dt60);
  const decay = Math.pow(SCOPE_AMB_PEAK_DECAY, dt60);
  const env = state.scopeAmbEnv;
  const peak = state.scopeAmbPeak;

  for (let b = 0; b < SCOPE_AMB_BANDS.length; b++) {
    const [loHz, hiHz] = SCOPE_AMB_BANDS[b];
    const i0 = Math.max(1, Math.floor((loHz / nyq) * freq.length));
    const i1 = Math.min(freq.length, Math.max(i0 + 1, Math.floor((hiHz / nyq) * freq.length)));
    let sum = 0;
    for (let i = i0; i < i1; i++) sum += freq[i];
    const raw = sum / (i1 - i0) / 255;
    peak[b] = Math.max(raw, peak[b] * decay);
    const lit = Math.min(1, raw / Math.max(0.02, peak[b]));
    env[b] = lit > env[b] ? lit : env[b] * rel + lit * (1 - rel);
  }

  const reach = Math.max(w, h) * SCOPE_AMB_REACH;
  ctx.save();
  // Additive, so the surround can only ever brighten the stage. Anything
  // that could darken would fight the figure drawn on top of it.
  ctx.globalCompositeOperation = 'lighter';
  for (let b = 0; b < SCOPE_AMB_AT.length; b++) {
    // Squared. The analyser has already smoothed these bands and the
    // per-band normalization pins each one's recent peak at 1, so the raw
    // value spends most of its time in the top third — measured, the treble
    // corners averaged 0.87 and barely moved. Expanding the low end gives
    // them somewhere to fall back to, which is what makes the rim breathe.
    const lit = env[b] * env[b];
    // A floor so a silent corner is still a presence rather than a hole, and
    // the rest earned by its band. `amount` is the user's slider, applied
    // straight: at 0 the layer is gone, at 2 it is twice the tuned level.
    // Nothing downstream clamps it — the control is the last word on how
    // bright this gets.
    const alpha = (0.05 + lit * 0.22) * amount;
    // Colour comes from two places: a palette position a quarter-turn apart
    // per corner and creeping forward for all four together, and a fixed hue
    // rotation on top of that. The first keeps the rim recognisably the
    // user's palette and slowly moving; the second is what separates the
    // corners when the palette is too narrow to do it alone.
    const [sr, sg, sb] = sampleRgbAt(palette, ((b / 4 + state.tick * 0.0004) % 1 + 1) % 1);
    const [h0, s0, l0] = rgbToHsl(sr, sg, sb);
    const [r, g, bl] = hslToRgb(
      (((h0 + (b * SCOPE_AMB_HUE_STEP) / 360) % 1) + 1) % 1,
      Math.max(s0, SCOPE_AMB_SAT),
      l0,
    );
    const cx = SCOPE_AMB_AT[b][0] * w;
    const cy = SCOPE_AMB_AT[b][1] * h;
    const rad = reach * (0.66 + lit * 0.34);
    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, rad);
    // Front-loaded: the light belongs at the rim. A gentler falloff reaches
    // the middle of the stage as a grey fog and costs the figure its
    // contrast, which is the one thing this layer must not do.
    grad.addColorStop(0, `rgba(${r},${g},${bl},${alpha})`);
    grad.addColorStop(0.32, `rgba(${r},${g},${bl},${alpha * 0.3})`);
    grad.addColorStop(0.72, `rgba(${r},${g},${bl},${alpha * 0.05})`);
    grad.addColorStop(1, `rgba(${r},${g},${bl},0)`);
    ctx.fillStyle = grad;
    // Only the gradient's bounding box. Alpha is exactly zero outside `rad`,
    // so clipping to it is lossless and keeps the layer from costing four
    // full screens of fill.
    ctx.fillRect(
      Math.max(0, cx - rad), Math.max(0, cy - rad),
      Math.min(w, cx + rad) - Math.max(0, cx - rad),
      Math.min(h, cy + rad) - Math.max(0, cy - rad),
    );
  }
  ctx.restore();
}

/** Returns the updated peak tracker. */
function drawLissajous(
  ctx: AnyCanvasCtx,
  w: number,
  h: number,
  time: Uint8Array,
  timeL: Uint8Array | undefined,
  timeR: Uint8Array | undefined,
  palette: Palette,
  gain: number,
  px: Float32Array,
  py: Float32Array,
  glow: number,
  smoothing: number,
  angle: number,
  prevPeak: number,
  tick: number,
  symmetry: number,
  ratio: number,
  density: number,
  /** 0 = smooth trace; 1..3 snap the trace onto a grid, coarse to fine. */
  lattice: number,
  /** Which grid geometry to snap to — see SCOPE_GRID_*. */
  gridKind: number,
  echoes: { path: Path2D; born: number }[],
): number {
  const cx = w * 0.5;
  const cy = h * 0.5;
  const baseR = Math.min(w, h) * 0.46;
  const L = timeL ?? time;
  const R = timeR ?? time;
  const n = Math.min(L.length, R.length, px.length);
  if (n < 2) return prevPeak;

  const breathe = 1 + Math.sin(tick * 0.008) * 0.07;
  const radius = baseR * breathe;

  // ── Spatial smoothing, NOT temporal ──
  // Averaging a point against the same index in the previous frame collapses
  // the figure: the analyser buffer isn't phase-locked, so index i sits at a
  // different phase each frame and blending averages random phases toward
  // zero. Averaging along the trace instead is a low-pass on the waveform —
  // it removes the high-frequency chatter that read as violence while leaving
  // the large excursions, and therefore the size, intact.
  const win = 1 + Math.round(Math.min(0.95, smoothing) * 7);

  // ── Decimation ──
  // The analyser hands over 2048 points; drawing every one produces a hairball
  // where nothing is legible. Stride after the smoothing window (not before)
  // so thinning the trace low-passes it rather than aliasing it — skipping raw
  // samples would fold high frequencies back in as fake structure.
  const stride = Math.max(1, Math.round(1 / Math.max(0.05, Math.min(1, density))));
  const count = Math.max(24, Math.floor(n / stride));

  let peak = 1e-4;
  for (let j = 0; j < count; j++) {
    const i = j * stride;
    let sl = 0;
    let sr = 0;
    for (let k = 0; k < win; k++) {
      const q = (i + k) % n;
      sl += L[q] - 128;
      sr += R[q] - 128;
    }
    const l = (sl / win / 128) * gain;
    const r = (sr / win / 128) * gain;
    px[j] = l;
    // Ratio warps one axis against the other. At 1 this is a plain scope; at
    // small rational values the trace closes into knots and rosettes, which
    // is where the geometric look comes from.
    py[j] = -r * Math.cos(ratio * Math.PI * (j / count)) - r * 0.35;
    const m = Math.abs(l) > Math.abs(r) ? Math.abs(l) : Math.abs(r);
    if (m > peak) peak = m;
  }

  // ── Auto-range ──
  // Rises fast so a transient never clips outside the stage, falls slowly so
  // quiet passages bloom back up instead of pumping. Without this the figure
  // is at the mercy of how hot the source happens to be.
  const nextPeak = peak > prevPeak ? peak : prevPeak * 0.985 + peak * 0.015;
  const scale = (radius * SCOPE_FILL) / Math.max(0.05, nextPeak);
  for (let i = 0; i < count; i++) {
    px[i] *= scale;
    py[i] *= scale;
  }

  // ── Shape mode ──
  // px/py currently hold the auto-ranged goniometer trace. Every mode other
  // than TRACE overwrites it in place and reports a new point count.
  // ── Polar lattice ──
  // Snapping each point onto a coarse grid of angles and radii replaces the
  // smooth trace with straight chords between lattice nodes — that is what
  // produces the angular, faceted forms. Because every symmetry copy snaps to
  // the same grid, the overlaps land on shared nodes and build a visible mesh
  // with figures growing around it, rather than blurring into one another.
  // Applied after scaling, so the grid sits in screen space and holds still
  // while the trace moves through it.
  if (lattice > 0) {
    const steps = 3 + lattice * 3;
    const cell = (radius * SCOPE_FILL) / steps;
    if (gridKind === SCOPE_GRID_SQUARE) {
      // Axis-aligned. Rotated by each symmetry copy, overlapping square grids
      // are what produce the interlocking quadrilaterals.
      for (let i = 0; i < count; i++) {
        px[i] = Math.round(px[i] / cell) * cell;
        py[i] = Math.round(py[i] / cell) * cell;
      }
    } else if (gridKind === SCOPE_GRID_DIAMOND) {
      // The square grid in a basis rotated 45°, so cells meet point-to-point.
      const c = Math.SQRT1_2;
      for (let i = 0; i < count; i++) {
        const u = Math.round(((px[i] + py[i]) * c) / cell) * cell;
        const v = Math.round(((py[i] - px[i]) * c) / cell) * cell;
        px[i] = (u - v) * c;
        py[i] = (u + v) * c;
      }
    } else if (gridKind === SCOPE_GRID_TRIANGLE) {
      // Basis vectors at 0° and 60°: the triangular/hexagonal lattice. Snap in
      // lattice coordinates, then map back.
      const h = Math.sqrt(3) / 2;
      for (let i = 0; i < count; i++) {
        const b = Math.round(py[i] / (cell * h));
        const a = Math.round((px[i] - b * cell * 0.5) / cell);
        px[i] = a * cell + b * cell * 0.5;
        py[i] = b * cell * h;
      }
    } else {
      // Polar: spokes and rings.
      const sectors = 6 + lattice * 6;
      const dA = (Math.PI * 2) / sectors;
      for (let i = 0; i < count; i++) {
        const a = Math.round(Math.atan2(py[i], px[i]) / dA) * dA;
        const r = Math.round(Math.hypot(px[i], py[i]) / cell) * cell;
        px[i] = Math.cos(a) * r;
        py[i] = Math.sin(a) * r;
      }
    }
  }

  // Beam dwell: a CRT burns brighter where the beam lingers. One Path2D per
  // intensity level keeps this to a handful of strokes per copy.
  const LEVELS = 5;
  let total = 0;
  for (let i = 1; i < count; i++) {
    total += Math.abs(px[i] - px[i - 1]) + Math.abs(py[i] - py[i - 1]);
  }
  const meanLen = Math.max(1e-3, total / Math.max(1, count - 1));

  const paths: Path2D[] = [];
  for (let lvl = 0; lvl < LEVELS; lvl++) {
    const loT = lvl / LEVELS;
    const hiT = (lvl + 1) / LEVELS;
    const path = new Path2D();
    let open = false;
    for (let i = 1; i < count; i++) {
      const len = Math.abs(px[i] - px[i - 1]) + Math.abs(py[i] - py[i - 1]);
      const dwell = 1 / (1 + len / meanLen);
      if (dwell < loT || dwell >= hiT) {
        open = false;
        continue;
      }
      if (!open) {
        path.moveTo(px[i - 1], py[i - 1]);
        open = true;
      }
      path.lineTo(px[i], py[i]);
    }
    paths.push(path);
  }

  const whole = new Path2D();
  whole.moveTo(px[0], py[0]);
  for (let i = 1; i < count; i++) whole.lineTo(px[i], py[i]);

  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // Width stays independent of density on purpose. Thickening the line to
  // compensate for fewer strokes destroys the thing that makes this look
  // good — the figure reads as fine wire, and heavier strokes turn it into
  // a blunt scribble. Fewer lines, same weight.
  const baseW = Math.max(0.7, Math.min(2.4, baseR * 0.006));
  // This pass carries the whole glow now, because the canvas shadow is off
  // for this style (see drawFrame). Dropping the shadow cost 42% of the
  // light — mean luminance at a 1512x850 stage fell from 4.95 to 2.86 — so
  // the width and alpha here are set to put it back. One wide translucent
  // stroke per copy is linear in the area it covers, where shadowBlur was a
  // gaussian re-run for every one of ~50 strokes a frame.
  const bloomW = Math.max(2, baseR * 0.05 * (0.4 + glow));

  const sym = Math.max(1, Math.min(8, symmetry));
  // Same geometry, different hue per copy. Built once per frame rather than
  // per stroke — there are at most eight of them and they all share a radius.
  const grads: CanvasGradient[] = [];
  for (let c = 0; c < sym; c++) {
    grads.push(scopeGradient(ctx, radius, palette, (c / sym) * SCOPE_HUE_ARC, c > 0));
  }

  // ── Capture this trace, retire the expired ones ──
  // Symmetry copies are baked in at capture time so redrawing an echo costs
  // one stroke rather than `sym` of them, and the points are decimated since
  // an echo is read as a shape, not inspected.
  if (echoes.length === 0 || tick - echoes[echoes.length - 1].born >= SCOPE_ECHO_EVERY) {
    const step = Math.max(1, Math.floor(count / SCOPE_ECHO_POINTS));
    const single = new Path2D();
    single.moveTo(px[0], py[0]);
    for (let i = step; i < count; i += step) single.lineTo(px[i], py[i]);
    const baked = new Path2D();
    for (let c = 0; c < sym; c++) {
      const a = angle + (c * Math.PI * 2) / sym;
      const cos = Math.cos(a);
      const sin = Math.sin(a);
      baked.addPath(single, new DOMMatrix([cos, sin, -sin, cos, 0, 0]));
    }
    echoes.push({ path: baked, born: tick });
  }
  while (echoes.length > 0 && tick - echoes[0].born > SCOPE_ECHO_LIFE) echoes.shift();

  ctx.save();
  ctx.translate(cx, cy);

  // History first, so the live trace lands on top. Stroked with the palette
  // gradient rather than a flat grey: the radial colour ramp is most of what
  // gives the figure its colour, and a grey trail would wash it out.
  ctx.strokeStyle = grads[0];
  ctx.lineWidth = baseW * 0.85;
  for (let e = 0; e < echoes.length; e++) {
    const age = (tick - echoes[e].born) / SCOPE_ECHO_LIFE;
    if (age >= 1) continue;
    // Squared falloff: linear keeps old traces legible too long and the stage
    // fills up again.
    const k = 1 - age;
    ctx.globalAlpha = k * k * SCOPE_ECHO_ALPHA;
    ctx.stroke(echoes[e].path);
  }

  for (let c = 0; c < sym; c++) {
    ctx.save();
    ctx.rotate(angle + (c * Math.PI * 2) / sym);
    const copyAlpha = c === 0 ? 1 : 0.32;
    ctx.strokeStyle = grads[c];

    // Per-frame alpha is deliberately small. With persistence doing the work,
    // a bright per-frame stroke would saturate instantly and there would be
    // nothing left to build.
    ctx.globalAlpha = (0.05 + glow * 0.07) * copyAlpha * 2;
    ctx.lineWidth = bloomW;
    ctx.stroke(whole);

    for (let lvl = 0; lvl < LEVELS; lvl++) {
      ctx.globalAlpha = (0.1 + (lvl / (LEVELS - 1)) * 0.75) * copyAlpha * 0.34;
      ctx.lineWidth = baseW * (0.75 + (lvl / (LEVELS - 1)) * 0.6);
      ctx.stroke(paths[lvl]);
    }
    ctx.restore();
  }
  ctx.restore();
  ctx.globalAlpha = 1;

  return nextPeak;
}

/* ── Crystal (geometric figure) ───────────────────────────────────────── */

/**
 * An m-fold closed figure whose outline the audio ripples.
 *
 * The curved counterpart to Scope. Scope is the angular one — straight
 * chords, lattice grids, stars — so this one takes the organic half of the
 * space: lobes, petals, rosettes, rippled discs. Between them they cover
 * both halves without competing for the same look.
 *
 * It is also the inverse of Scope's bargain. Scope plots the signal
 * directly, so its geometry is real but intermittent: a Lissajous figure
 * only closes into a shape when both axes are near-periodic, and on a dense
 * mix they are broadband noise and the trace collapses into a hairball. The
 * shapes there aren't produced, they're handed over by the music, which is
 * why they come and go.
 *
 * Here the shape is the substrate and the audio decorates it. A Gielis
 * superformula supplies the outline — triangle, square, pentagram,
 * hexagonal snowflake — and the waveform displaces its edge. Every frame is
 * a clean closed curve by construction, whatever is playing.
 *
 * It stays a stereo instrument by working in mid/side rather than L/R: the
 * mid signal breathes the outline in and out, the side signal (the width)
 * grows the fine frills. A mono source draws a clean shape; a wide one
 * crystallizes detail onto it. What it does not do is read phase — for that,
 * use Scope.
 */

/** Curated [m, n1, n2, n3] parameter sets.
 *
 *  Most of the superformula's parameter space is ugly, and the few regions
 *  that aren't are what people mean by "geometric". Randomizing the
 *  exponents lands in the ugly part most of the time. A fixed table cannot.
 *  Interpolating between two entries stays near the good region, so morphing
 *  between them is safe where a random walk was not.
 *
 *  These are all chosen from the curved side of that space: n1 below 1 with
 *  low n2/n3 gives smooth lobes, where the large exponents that produce
 *  hard-edged polygons and cusped stars belong to Scope. */
const CRYSTAL_SHAPES: readonly [number, number, number, number][] = [
  [3, 0.5, 1.5, 1.5],  // trefoil — three smooth lobes
  [4, 0.5, 1.5, 1.5],  // quatrefoil
  [5, 0.4, 1.6, 1.6],  // five-petal rose
  [6, 0.6, 1.4, 1.4],  // six-petal bloom
  [8, 0.5, 1.3, 1.3],  // eight-lobe rosette
  [2, 1, 4, 8],        // teardrop
  [7, 3, 4, 17],       // ruffled flower
  [5, 2, 13, 3],       // soft-armed starfish
  [3, 1, 1, 1],        // rounded triangle
  [6, 1, 1, 1],        // rounded hexagon
  [12, 1, 1, 1],       // rippled disc
  [16, 1.2, 1, 1],     // fine ripple ring
];

/** Gielis superformula radius at `theta`, with a = b = 1. */
function superRadius(theta: number, m: number, n1: number, n2: number, n3: number): number {
  const t = (m * theta) / 4;
  const a = Math.pow(Math.abs(Math.cos(t)), n2);
  const b = Math.pow(Math.abs(Math.sin(t)), n3);
  const d = a + b;
  return d < 1e-9 ? 0 : Math.pow(d, -1 / n1);
}

/** How far the mid signal displaces the outline, as a fraction of radius. */
const CRYSTAL_MID_DEPTH = 0.34;
/** Side-signal frill depth. Smaller — it is detail, not structure. */
const CRYSTAL_SIDE_DEPTH = 0.16;
/** Returns the updated peak tracker. */
function drawCrystal(
  ctx: AnyCanvasCtx,
  w: number,
  h: number,
  time: Uint8Array,
  timeL: Uint8Array | undefined,
  timeR: Uint8Array | undefined,
  palette: Palette,
  gain: number,
  px: Float32Array,
  py: Float32Array,
  glow: number,
  smoothing: number,
  angle: number,
  prevPeak: number,
  tick: number,
  layers: number,
  m: number,
  nParams: Float32Array,
  density: number,
): number {
  const cx = w * 0.5;
  const cy = h * 0.5;
  const baseR = Math.min(w, h) * 0.46;
  const L = timeL ?? time;
  const R = timeR ?? time;
  const n = Math.min(L.length, R.length);
  if (n < 2) return prevPeak;

  const breathe = 1 + Math.sin(tick * 0.008) * 0.07;
  const radius = baseR * breathe;

  // Density reads as resolution here, not as a line count — the figure is one
  // closed curve either way. Low gives a faceted polygon, high a smooth one.
  const dens = Math.min(1, Math.max(0.05, density));
  const count = Math.min(px.length, Math.max(48, Math.round(120 + dens * 600)));

  // Spatial low-pass before the waveform touches the outline. Same reasoning
  // as in Scope: raw buffer chatter reads as noise on the edge, not detail.
  const win = 1 + Math.round(Math.min(0.95, smoothing) * 10);

  // Overall level, so the figure pumps with the music. The outline itself is
  // deterministic, so without this the whole thing would sit at one size no
  // matter what was playing.
  let sq = 0;
  for (let i = 0; i < n; i++) {
    const v = (time[i] - 128) / 128;
    sq += v * v;
  }
  const level = Math.min(1, Math.sqrt(sq / n) * gain * 2.4);
  const sizeMul = 0.58 + level * 0.42;

  const n1 = Math.max(0.15, nParams[0]);
  const n2 = Math.max(0.15, nParams[1]);
  const n3 = Math.max(0.15, nParams[2]);
  const half = count / 2;

  let peak = 1e-4;
  for (let j = 0; j < count; j++) {
    const th = (j / count) * Math.PI * 2;

    // The waveform is mirrored around the figure rather than wrapped. Walking
    // the buffer linearly leaves r(2π) ≠ r(0), and the curve shows a radial
    // seam where it closes. Mirroring makes the modulation periodic by
    // construction — and the bilateral symmetry that falls out is a good part
    // of what makes these read as snowflakes rather than as scribbles.
    const u = j < half ? j / half : (count - j) / half;
    const i0 = Math.min(n - 1, Math.floor(u * (n - 1)));

    let sm = 0;
    let ss = 0;
    for (let k = 0; k < win; k++) {
      const q = (i0 + k) % n;
      const l = L[q] - 128;
      const r = R[q] - 128;
      sm += l + r;
      ss += l - r;
    }
    const mid = (sm / win / 256) * gain;
    const side = (ss / win / 256) * gain;

    const rr =
      superRadius(th, m, n1, n2, n3) * (1 + mid * CRYSTAL_MID_DEPTH) +
      side * CRYSTAL_SIDE_DEPTH;
    const clamped = rr > 0 ? rr : 0;
    px[j] = Math.cos(th) * clamped;
    py[j] = Math.sin(th) * clamped;
    if (clamped > peak) peak = clamped;
  }

  // ── Auto-range ──
  // Normalizes each shape to its own extent: the star presets overshoot a
  // unit circle by a wide margin, so without this a pentagram and a hexagon
  // would be wildly different sizes on screen. Eased, so that a morph
  // resizes smoothly rather than stepping.
  const nextPeak = prevPeak * 0.9 + peak * 0.1;
  const scale = (radius * SCOPE_FILL * sizeMul) / Math.max(0.05, nextPeak);
  for (let i = 0; i < count; i++) {
    px[i] *= scale;
    py[i] *= scale;
  }

  // Beam dwell: a CRT burns brighter where the beam lingers. One Path2D per
  // intensity level keeps this to a handful of strokes per layer. Indices
  // wrap, since the curve is closed.
  const LEVELS = 5;
  let total = 0;
  for (let i = 1; i <= count; i++) {
    const a = i % count;
    total += Math.abs(px[a] - px[i - 1]) + Math.abs(py[a] - py[i - 1]);
  }
  const meanLen = Math.max(1e-3, total / count);

  const paths: Path2D[] = [];
  for (let lvl = 0; lvl < LEVELS; lvl++) {
    const loT = lvl / LEVELS;
    const hiT = (lvl + 1) / LEVELS;
    const path = new Path2D();
    let open = false;
    for (let i = 1; i <= count; i++) {
      const a = i % count;
      const len = Math.abs(px[a] - px[i - 1]) + Math.abs(py[a] - py[i - 1]);
      const dwell = 1 / (1 + len / meanLen);
      if (dwell < loT || dwell >= hiT) {
        open = false;
        continue;
      }
      if (!open) {
        path.moveTo(px[i - 1], py[i - 1]);
        open = true;
      }
      path.lineTo(px[a], py[a]);
    }
    paths.push(path);
  }

  const whole = new Path2D();
  whole.moveTo(px[0], py[0]);
  for (let i = 1; i < count; i++) whole.lineTo(px[i], py[i]);
  whole.closePath();

  const lay = Math.max(1, Math.min(3, layers));
  const grads: CanvasGradient[] = [];
  for (let c = 0; c < lay; c++) {
    grads.push(scopeGradient(ctx, radius, palette, (c / lay) * SCOPE_HUE_ARC, c > 0));
  }

  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // Width stays independent of density on purpose. Thickening the line to
  // compensate for fewer strokes destroys the thing that makes this look
  // good — the figure reads as fine wire, and heavier strokes turn it into
  // a blunt scribble. Fewer lines, same weight.
  const baseW = Math.max(0.7, Math.min(2.4, baseR * 0.006));
  const bloomW = Math.max(3, baseR * 0.045 * (0.4 + glow));

  ctx.save();
  ctx.translate(cx, cy);
  for (let c = 0; c < lay; c++) {
    ctx.save();
    // Layers are offset by a fraction of the shape's OWN fold angle. Rotating
    // by an arbitrary 2π/copies instead — what Scope does, correctly, for an
    // unstructured trace — would beat the outline's m-fold periodicity
    // against an unrelated one, and that interference is precisely what reads
    // as clutter. Aligning to m means the layers interlock.
    ctx.rotate(angle + (c * Math.PI * 2) / (Math.max(1, m) * lay));
    const shrink = 1 - c * 0.24;
    ctx.scale(shrink, shrink);
    const copyAlpha = c === 0 ? 1 : 0.5;
    ctx.strokeStyle = grads[c];

    // Per-frame alpha is deliberately tiny. With persistence doing the work,
    // a bright per-frame stroke would saturate instantly and there would be
    // nothing left to build.
    ctx.globalAlpha = (0.05 + glow * 0.07) * copyAlpha * 0.45;
    ctx.lineWidth = bloomW;
    ctx.stroke(whole);

    for (let lvl = 0; lvl < LEVELS; lvl++) {
      ctx.globalAlpha = (0.1 + (lvl / (LEVELS - 1)) * 0.75) * copyAlpha * 0.38;
      ctx.lineWidth = baseW * (0.75 + (lvl / (LEVELS - 1)) * 0.6);
      ctx.stroke(paths[lvl]);
    }
    ctx.restore();
  }
  ctx.restore();
  ctx.globalAlpha = 1;

  return nextPeak;
}

/* ── Ripples ───────────────────────────────────────────────────────────── */

interface Ripple {
  /** Current radius as a fraction of max — grows toward 1, then retires. */
  r: number;
  born: number;
  strength: number;
}

/**
 * Concentric rings emitted on bass onsets, expanding and fading.
 *
 * Chosen for large stages specifically: ring radius wants room, so this gets
 * better as the canvas grows rather than needing the motion damping the
 * pixel-displacement styles do. Expansion is in normalized units and scaled
 * to the canvas at draw time, so it is resolution-independent by
 * construction.
 */
function drawRipples(
  ctx: AnyCanvasCtx,
  w: number,
  h: number,
  palette: Palette,
  ripples: Ripple[],
  tick: number,
  dt60: number,
  gain: number,
  envelope: number,
): void {
  const cx = w * 0.5;
  const cy = h * 0.5;
  const maxR = Math.hypot(w, h) * 0.5;

  // Advance and retire in one pass, writing survivors back in place so the
  // array never reallocates per frame.
  let write = 0;
  for (let i = 0; i < ripples.length; i++) {
    const rp = ripples[i];
    rp.r += 0.006 * dt60 * (0.7 + rp.strength * 0.6);
    if (rp.r < 1) ripples[write++] = rp;
  }
  ripples.length = write;

  const grad = verticalGradient(ctx, palette, cy - maxR, cy + maxR);
  ctx.strokeStyle = grad;

  for (let i = 0; i < ripples.length; i++) {
    const rp = ripples[i];
    // Fade out over the ring's life, weighted by how hard the onset hit.
    const fade = (1 - rp.r) * (1 - rp.r);
    ctx.globalAlpha = Math.min(0.85, fade * (0.35 + rp.strength * 0.65));
    ctx.lineWidth = Math.max(0.5, (1 - rp.r) * 4 * (0.5 + rp.strength));
    ctx.beginPath();
    ctx.arc(cx, cy, rp.r * maxR, 0, Math.PI * 2);
    ctx.stroke();
  }

  // Breathing core so the centre isn't dead between onsets.
  const pulse = Math.min(1, envelope * gain);
  const coreR = Math.min(w, h) * (0.03 + pulse * 0.05) * (1 + Math.sin(tick * 0.03) * 0.06);
  ctx.globalAlpha = 0.16 + pulse * 0.3;
  ctx.fillStyle = palette.glowColor;
  ctx.beginPath();
  ctx.arc(cx, cy, coreR, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1;
}

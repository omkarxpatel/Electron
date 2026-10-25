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
import { applyTrails, glowBlur, roundRectSubPath } from '../canvasUtils';

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
  /** Two timbral profiles of the same signal at different time constants.
   *  Their divergence is what marks a section change. See sectionNoveltyOf. */
  scopeProfShort: Float32Array;
  scopeProfLong: Float32Array;
  /** Set when the music has moved on, cleared when the next beat lands the
   *  change. Splits "should the figure change" from "change it now". */
  scopeRollArmed: boolean;
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
  /** Crystal: superformula fold counts, one per term. Snapped on change,
   *  never interpolated — a fractional fold count leaves the curve open where
   *  it should close. Unequal means an asymmetric form. */
  crystalM1: number;
  crystalM2: number;
  /** Crystal: superformula exponents [n1, n2, n3], eased toward crystalNTo so
   *  a shape change morphs instead of cutting. */
  crystalN: Float32Array;
  crystalNTo: Float32Array;
  /** Expanse / Nova: the last few frames' finished geometry, newest first.
   *  A stamp draws its own age out of this, so the tiles of a field are
   *  different moments rather than copies. See TILE_STAGGER. */
  tileFrames: TileFrame[];
  /** Expanse / Nova: which full-stage layout the figure is stamped into.
   *  See FIELD_*. Re-rolled by the same machinery that re-rolls symmetry. */
  fieldMode: number;
  /** Expanse / Nova: how many copies that layout uses, 2..4. Means columns
   *  for the tiling, shell spacing for the radiating one, satellites for the
   *  orbit. */
  fieldCount: number;
  /** Nova: outward-travelling shells, oldest first. Each is a scale factor
   *  that grows past the corners and then retires. */
  novaShells: Shell[];
  /** Nova: tick of the last shell spawn, so sustained material with no bass
   *  transients still emits. */
  novaLastShell: number;
  /** Perimeter spectrum band: one lit-ness per segment plus the slow running
   *  peak each is normalized against. See drawRimSpectrum. */
  rimEnv: Float32Array;
  rimPeak: Float32Array;
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
    scopeProfShort: new Float32Array(SCOPE_NOV_BANDS),
    scopeProfLong: new Float32Array(SCOPE_NOV_BANDS),
    scopeRollArmed: false,
    scopeSymmetry: 3,
    scopeSpin: 1,
    scopeSpinTarget: 1,
    scopeSpinCur: 1,
    scopeSpinKick: 0,
    scopeAmbEnv: new Float32Array(4),
    scopeAmbPeak: new Float32Array(4),
    scopeRatio: 1,
    crystalLayers: 2,
    crystalM1: 6,
    crystalM2: 6,
    crystalN: new Float32Array([0.6, 1.4, 1.4]),
    crystalNTo: new Float32Array([0.6, 1.4, 1.4]),
    tileFrames: [],
    fieldMode: FIELD_TILE,
    fieldCount: 3,
    novaShells: [],
    novaLastShell: 0,
    rimEnv: new Float32Array(RIM_BANDS),
    rimPeak: new Float32Array(RIM_BANDS),
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
    s.waveformStyle === 'lissajous' || s.waveformStyle === 'expanse'
      ? Math.pow(coherenceOf(freq, sampleRate, state, dt60), 2)
      : 0;

  // Both radial styles repaint their history from an echo buffer every frame,
  // so the canvas starts clean instead of carrying anything over.
  //
  // What this replaces, for both of them, was multiplicative decay plus a
  // periodic hard fade-out. Decay alone cannot finish the job: alpha is 8-bit
  // and `round(a * trail) === a` for small a, so the faintest residue rounds
  // back to itself forever and accumulates into a grey footprint across the
  // whole stage. The scheduled fade-out existed only to clear that, and it is
  // what made the background disappear all at once every few seconds. Ageing
  // each trace on its own clock instead means the oldest material leaves
  // continuously and nothing needs wiping.
  if (
    s.waveformStyle === 'lissajous' ||
    s.waveformStyle === 'crystal' ||
    s.waveformStyle === 'expanse' ||
    s.waveformStyle === 'nova'
  ) {
    ctx.clearRect(0, 0, width, height);
  } else {
    applyTrails(ctx, width, height, s.trail);
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
  const ownBloom =
    s.waveformStyle === 'lissajous' ||
    s.waveformStyle === 'crystal' ||
    s.waveformStyle === 'expanse' ||
    s.waveformStyle === 'nova' ||
    s.waveformStyle === 'silk';
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
    case 'expanse':
    case 'nova':
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
      drawSilk(ctx, width, height, time, palette, state.smoothedSamples, release, gain, state.tick, spectral, s.glow);
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
        const novelty = sectionNoveltyOf(freq, sampleRate, state, dt60);
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
        // This stays per-beat: the beat should be legible in the motion even
        // while the shape holds.
        if (bDelta > onsetThresh) {
          state.scopeSpinKick = Math.min(2.5, state.scopeSpinKick + bDelta * 5);
        }
        state.scopeSpinKick *= Math.pow(0.93, dt60);

        // ── When the figure is allowed to become something else ──
        // The music moving on arms a change; the next beat lands it. Keeping
        // those separate is the whole point. Re-rolling on the onset alone
        // asked the wrong question — an onset means a beat happened, not that
        // anything is different — and the figure turned over roughly twice a
        // second on any kick-driven track. Arming on novelty instead means a
        // change coincides with something actually arriving in the music,
        // and firing it on the following transient means it still lands on a
        // beat rather than drifting in between them.
        //
        // Coherence biases the arming rather than blocking it: a hard gate
        // held the shape frozen through every tonal passage, which traded
        // away all the variety to buy stability.
        const dwell = state.tick - state.scopeLastRoll;
        if (dwell > SCOPE_MIN_DWELL && novelty > SCOPE_NOV_ARM) {
          state.scopeRollArmed = true;
        }
        // Coherence biases which beat lands an armed change, not whether one
        // does. A hard gate held the shape frozen through every tonal
        // passage, trading away all the variety to buy stability; as a
        // per-beat probability it lets a pattern that is resolving stand
        // through another hit or two and no longer than that. It belongs on
        // this decision and not on the arming above, which is evaluated every
        // frame and would shrug the probability off within a few of them.
        const landed = state.scopeRollArmed && bDelta > onsetThresh && Math.random() > ink * 0.6;
        // The backstop, for material that neither changes nor punches —
        // without it, sustained and compressed mixes hold one figure
        // indefinitely, which is the failure this style had before.
        if (landed || dwell > SCOPE_MAX_DWELL) {
          state.scopeRollArmed = false;
          state.scopeLastRoll = state.tick;
          // Twice, because changes are now an order of magnitude rarer and
          // each one should read as a decision. The two picks can collide, so
          // some transitions move one facet and some move two — which is
          // itself variety.
          rollScopeShape(state);
          rollScopeShape(state);
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
      // Light the rim before anything else goes down. Immersive only: four
      // corner glows across a 110px banner strip is a smear, not a surround.
      if (isLargeStage(stageScaleOf(height))) {
        drawScopeAmbience(ctx, width, height, freq, sampleRate, palette, state, s.scopeAmbience, dt60);
      }
      // ── When the figure becomes another shape ──
      // Same arrangement as Scope: novelty arms a change and the next beat
      // lands it. This used to fire on a fixed bass delta of 0.055, which is
      // the bug Scope was measured out of — against three signals a fixed
      // threshold produced 172 changes on a punchy kick and exactly zero on
      // both sustained and compressed bass, so on most produced music the
      // form locked and never moved again.
      //
      // Long persistence means the old outline is still fading as the new one
      // draws, so a change here reads as a morph rather than a cut.
      {
        const bDelta = bassDeltaOf(freq, sampleRate, state);
        const novelty = sectionNoveltyOf(freq, sampleRate, state, dt60);
        state.scopeDeltaPeak = Math.max(bDelta, state.scopeDeltaPeak * 0.999);
        const onsetThresh = Math.max(0.012, state.scopeDeltaPeak * 0.45);

        // The rotation gets shoved on every beat regardless, so the beat
        // stays legible in the motion while the form holds.
        if (bDelta > onsetThresh) {
          state.scopeSpinKick = Math.min(2.5, state.scopeSpinKick + bDelta * 5);
        }
        state.scopeSpinKick *= Math.pow(0.93, dt60);

        const dwell = state.tick - state.scopeLastRoll;
        if (dwell > SCOPE_MIN_DWELL && novelty > SCOPE_NOV_ARM) {
          state.scopeRollArmed = true;
        }
        if ((state.scopeRollArmed && bDelta > onsetThresh) || dwell > SCOPE_MAX_DWELL) {
          state.scopeRollArmed = false;
          state.scopeLastRoll = state.tick;
          const roll = Math.random();
          if (roll < 0.58) {
            const pick = CRYSTAL_SHAPES[Math.floor(Math.random() * CRYSTAL_SHAPES.length)];
            state.crystalM1 = pick[0];
            state.crystalM2 = pick[1];
            state.crystalNTo[0] = pick[2];
            state.crystalNTo[1] = pick[3];
            state.crystalNTo[2] = pick[4];
          } else if (roll < 0.8) {
            // Direction and rate together, as in Scope. Flipping direction
            // alone always looked the same, because the rate never changed.
            if (Math.random() < 0.6) state.scopeSpin = -state.scopeSpin;
            const RATES = [0, 0.35, 0.7, 1, 1.5, 2.4];
            state.scopeSpinTarget = RATES[Math.floor(Math.random() * RATES.length)];
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
      // Eased toward the target so a rate change glides rather than steps —
      // an instant jump in angular velocity reads as a glitch.
      state.scopeSpinCur +=
        (state.scopeSpinTarget - state.scopeSpinCur) * (1 - Math.pow(0.97, dt60));
      state.scopeAngle +=
        (0.0008 + Math.min(0.002, state.envelope * 0.003)) *
        (state.scopeSpinCur + state.scopeSpinKick) *
        state.scopeSpin * dt60;
      state.scopePeak = drawCrystal(
        ctx, width, height, time, timeL, timeR, palette, gain,
        state.scopeX, state.scopeY!, s.glow, s.smoothing, state.scopeAngle,
        state.scopePeak, state.tick, state.crystalLayers,
        state.crystalM1, state.crystalM2, state.crystalN, s.scopeDensity,
        state.scopeEchoes,
      );
      break;
    }
    case 'expanse': {
      // Scope's selection logic verbatim — novelty arms a change, the next
      // beat lands it — with the layout added as one more facet it can roll.
      state.tick += dt60;
      const n = Math.min((timeL ?? time).length, (timeR ?? time).length);
      if (!state.scopeX || state.scopeX.length !== n) {
        state.scopeX = new Float32Array(n);
        state.scopeY = new Float32Array(n);
      }
      const large = isLargeStage(stageScaleOf(height));
      if (large) {
        drawScopeAmbience(ctx, width, height, freq, sampleRate, palette, state, s.scopeAmbience, dt60);
        drawRimSpectrum(ctx, width, height, freq, sampleRate, palette, state, s.scopeAmbience, dt60);
      }
      const ink = scopeInk;
      {
        const bDelta = bassDeltaOf(freq, sampleRate, state);
        const novelty = sectionNoveltyOf(freq, sampleRate, state, dt60);
        state.scopeDeltaPeak = Math.max(bDelta, state.scopeDeltaPeak * 0.999);
        const onsetThresh = Math.max(0.012, state.scopeDeltaPeak * 0.45);

        if (bDelta > onsetThresh) {
          state.scopeSpinKick = Math.min(2.5, state.scopeSpinKick + bDelta * 5);
        }
        state.scopeSpinKick *= Math.pow(0.93, dt60);

        const dwell = state.tick - state.scopeLastRoll;
        if (dwell > SCOPE_MIN_DWELL && novelty > SCOPE_NOV_ARM) {
          state.scopeRollArmed = true;
        }
        const landed = state.scopeRollArmed && bDelta > onsetThresh && Math.random() > ink * 0.6;
        if (landed || dwell > SCOPE_MAX_DWELL) {
          state.scopeRollArmed = false;
          state.scopeLastRoll = state.tick;
          rollScopeShape(state);
          rollScopeShape(state);
          // Rarest of the facets on purpose. The others move one thing about
          // the figure; this moves everything on the stage at once, and at
          // every roll it would read as the visualizer being unable to settle.
          if (Math.random() < 0.4) rollField(state, EXPANSE_MODES);
        }
      }
      state.scopeSpinCur +=
        (state.scopeSpinTarget - state.scopeSpinCur) * (1 - Math.pow(0.97, dt60));
      state.scopeAngle +=
        (0.0004 + Math.min(0.001, state.envelope * 0.0015)) *
        (1 - 0.35 * ink) *
        (state.scopeSpinCur + state.scopeSpinKick) *
        state.scopeSpin * dt60;
      state.scopePeak = drawExpanse(
        ctx, width, height, time, timeL, timeR, palette, gain,
        state.scopeX, state.scopeY!, s.glow, s.smoothing, state.scopeAngle,
        state.scopePeak, state.tick, state.scopeSymmetry, state.scopeRatio,
        s.scopeDensity, state.scopeLattice, state.scopeGridKind,
        state.scopeEchoes, state.tileFrames, state.fieldMode, state.fieldCount, large,
      );
      break;
    }
    case 'nova': {
      // Bloom's selection logic verbatim, plus the shells — which are the one
      // layout that carries its own state, because each is a thing travelling
      // rather than a position in a static arrangement.
      state.tick += dt60;
      const n = Math.min((timeL ?? time).length, (timeR ?? time).length);
      if (!state.scopeX || state.scopeX.length !== n) {
        state.scopeX = new Float32Array(n);
        state.scopeY = new Float32Array(n);
      }
      const large = isLargeStage(stageScaleOf(height));
      if (large) {
        drawScopeAmbience(ctx, width, height, freq, sampleRate, palette, state, s.scopeAmbience, dt60);
        drawRimSpectrum(ctx, width, height, freq, sampleRate, palette, state, s.scopeAmbience, dt60);
      }
      {
        const bDelta = bassDeltaOf(freq, sampleRate, state);
        const novelty = sectionNoveltyOf(freq, sampleRate, state, dt60);
        state.scopeDeltaPeak = Math.max(bDelta, state.scopeDeltaPeak * 0.999);
        const onsetThresh = Math.max(0.012, state.scopeDeltaPeak * 0.45);

        if (bDelta > onsetThresh) {
          state.scopeSpinKick = Math.min(2.5, state.scopeSpinKick + bDelta * 5);
        }
        state.scopeSpinKick *= Math.pow(0.93, dt60);

        if (large && state.fieldMode === FIELD_SHELLS) {
          const r0 = Math.min(width, height) * 0.46;
          advanceShells(state.novaShells, r0, Math.hypot(width, height) * 0.5, dt60);
          // The idle timer is not a fallback for a mistuned threshold — it is
          // the only thing that emits on material with no bass transients at
          // all, and an empty stage is the failure this style exists to fix.
          const idle = state.tick - state.novaLastShell;
          if (
            (bDelta > onsetThresh || idle > SHELL_IDLE_TICKS) &&
            state.novaShells.length < SHELL_MAX
          ) {
            state.novaShells.push({
              k: SHELL_BIRTH,
              born: state.tick,
              strength: Math.min(1, Math.max(0.3, bDelta * 6)),
            });
            state.novaLastShell = state.tick;
          }
        } else if (state.novaShells.length > 0) {
          // Leaving the mode retires them rather than freezing them in place.
          state.novaShells.length = 0;
        }

        const dwell = state.tick - state.scopeLastRoll;
        if (dwell > SCOPE_MIN_DWELL && novelty > SCOPE_NOV_ARM) {
          state.scopeRollArmed = true;
        }
        if ((state.scopeRollArmed && bDelta > onsetThresh) || dwell > SCOPE_MAX_DWELL) {
          state.scopeRollArmed = false;
          state.scopeLastRoll = state.tick;
          const roll = Math.random();
          if (roll < 0.5) {
            const pick = CRYSTAL_SHAPES[Math.floor(Math.random() * CRYSTAL_SHAPES.length)];
            state.crystalM1 = pick[0];
            state.crystalM2 = pick[1];
            state.crystalNTo[0] = pick[2];
            state.crystalNTo[1] = pick[3];
            state.crystalNTo[2] = pick[4];
          } else if (roll < 0.7) {
            if (Math.random() < 0.6) state.scopeSpin = -state.scopeSpin;
            const RATES = [0, 0.35, 0.7, 1, 1.5, 2.4];
            state.scopeSpinTarget = RATES[Math.floor(Math.random() * RATES.length)];
          } else if (roll < 0.82) {
            state.crystalLayers = 1 + Math.floor(Math.random() * 3); // 1..3
          } else {
            rollField(state, NOVA_MODES);
          }
        }
      }
      {
        const k = 1 - Math.pow(0.94, dt60);
        for (let i = 0; i < 3; i++) {
          state.crystalN[i] += (state.crystalNTo[i] - state.crystalN[i]) * k;
        }
      }
      state.scopeSpinCur +=
        (state.scopeSpinTarget - state.scopeSpinCur) * (1 - Math.pow(0.97, dt60));
      state.scopeAngle +=
        (0.0008 + Math.min(0.002, state.envelope * 0.003)) *
        (state.scopeSpinCur + state.scopeSpinKick) *
        state.scopeSpin * dt60;
      state.scopePeak = drawNova(
        ctx, width, height, time, timeL, timeR, palette, gain,
        state.scopeX, state.scopeY!, s.glow, s.smoothing, state.scopeAngle,
        state.scopePeak, state.tick, state.crystalLayers,
        state.crystalM1, state.crystalM2, state.crystalN, s.scopeDensity,
        state.scopeEchoes, state.tileFrames, state.fieldMode, state.fieldCount,
        state.novaShells, large,
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

  // One path for every bar, one fill. See roundRectSubPath — per-bar fills
  // re-ran the shadow blur once per bar and cost ~5x the frame rate.
  ctx.beginPath();
  for (let b = 0; b < barCount; b++) {
    const peak = peakPerBar(time, b, samplesPerBar);
    const bandBoost = spectralAt(spectral, (b + 0.5) / barCount) * 0.45;
    const target = Math.min(1, peak * gain + bandBoost);
    smoothed[b] = smoothStep(smoothed[b], target, release);
    const barH = Math.max(2, smoothed[b] * peakHeight);
    const x = startX + b * slot;
    if (mirror) {
      const halfH = barH / 2;
      roundRectSubPath(ctx, x, midY - halfH, barWidth, barH, barWidth / 2);
    } else {
      roundRectSubPath(ctx, x, midY - barH / 2, barWidth, barH, barWidth / 2);
    }
  }
  ctx.fill();
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

  ctx.beginPath();
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
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
  }
  ctx.stroke();
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

  ctx.beginPath();
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
    roundRectSubPath(ctx, x, midY - halfH, barWidth, halfH * 2, barWidth / 2);
  }
  ctx.fill();
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
  glow: number,
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

  // ── Why this draws its own glow ──
  // Silk strokes 48 curves a frame and used to set shadowBlur for each one.
  // shadowBlur is applied per stroke, across the whole backing store, so that
  // was 48 full-canvas blurs a frame: measured on a 1512x850 retina stage,
  // 58.0 ms with it and 1.6 ms without, same geometry. 17 fps against the
  // display's full rate, and the whole of the reported lag. Scope hit exactly
  // this and the fix is the same — carry the glow in the geometry instead, as
  // one wide translucent pass under the fine one.
  //
  // The slider now reaches this style properly, too. The old blur was
  // min(glow * 32, 6), which saturated at a glow of 0.19 and so sat at 6 for
  // almost the whole range of the control.
  const bloomW = 2 + glow * 7;

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

    const coreAlpha = (1 - absDist * absDist * 0.85) * 0.13;

    // Built once and stroked twice. Rebuilding 180 curve segments for the
    // second pass would cost more than the pass itself.
    const path = new Path2D();
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
        path.moveTo(x, y);
      } else if (p < N_POINTS - 1) {
        const cx = (prevX + x) / 2;
        const cy = (prevY + y) / 2;
        path.quadraticCurveTo(prevX, prevY, cx, cy);
      } else {
        path.lineTo(x, y);
      }
      prevX = x;
      prevY = y;
    }
    // Wide and faint first, then the core on top. The bloom's share is set
    // so the pair lays down the ink the blurred stroke did rather than
    // whatever looked bright in isolation: ink goes as alpha times width, so
    // spreading over bloomW and keeping the alpha it had would have been
    // several times the original. Measured against the shadow version at the
    // same geometry, this lands within a few percent on both mean ink and
    // lit-pixel coverage.
    ctx.globalAlpha = coreAlpha * 0.16;
    ctx.lineWidth = bloomW;
    ctx.stroke(path);
    ctx.globalAlpha = coreAlpha;
    ctx.lineWidth = 0.7;
    ctx.stroke(path);
  }

  ctx.globalAlpha = 1;
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
const SCOPE_MAX_DWELL = 840;
/** Floor on how long a figure holds, in the same units. Nothing re-rolls
 *  inside this window however much the music changes. Without it the figure
 *  turned over about twice a second on any kick-driven track, which reads as
 *  churn rather than as the visual following the music. */
const SCOPE_MIN_DWELL = 360;
/** Shape distance above which a change is armed, in sectionNoveltyOf's 0..2
 *  space. Chosen from measurement, not taste: across two minutes each of
 *  four synthetic materials, constant instrumentation never exceeded 0.009
 *  while real section boundaries peaked between 0.222 and 0.343. Anywhere in
 *  that gap works; this sits low in it so a modest arrangement change still
 *  counts, and the dwell floor rather than the threshold is what bounds how
 *  often the figure can turn over. */
const SCOPE_NOV_ARM = 0.15;
/** Bands in the timbral profile, log-spaced across the range below. Coarse
 *  on purpose: this should notice an instrument arriving, not a melody
 *  moving. */
const SCOPE_NOV_BANDS = 12;
const SCOPE_NOV_EDGES = (() => {
  const LO = 40;
  const HI = 12000;
  const e = new Float32Array(SCOPE_NOV_BANDS + 1);
  for (let i = 0; i <= SCOPE_NOV_BANDS; i++) {
    e[i] = LO * Math.pow(HI / LO, i / SCOPE_NOV_BANDS);
  }
  return e;
})();
/** The two profile rates, per 60 Hz frame. Short is about 1.5 s — longer
 *  than a beat at any tempo that matters, so a kick lands inside it rather
 *  than against it. Long is about 8 s, roughly a musical phrase.
 *
 *  The pair is the point. Comparing a single frame against one slow average
 *  measures the beat, not the arrangement: measured that way a constant
 *  four-on-the-floor loop armed a change on every kick and the figure sat
 *  pinned against its minimum dwell. A repeating beat contributes equally to
 *  both of these, so it cancels, and only a sustained change in content
 *  pulls them apart. */
const SCOPE_NOV_SHORT = 0.989;
const SCOPE_NOV_LONG = 0.998;
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

/**
 * How different the music is right now from what it has been, 0..1 — in
 * effect, "has a new section started?"
 *
 * A bass onset says a beat landed. It says nothing about whether anything
 * changed, which is why arming a re-roll on onsets alone turned the figure
 * over several times a second on anything with a kick in it — measured at
 * 916 changes in two minutes. This tracks a coarse timbral profile at two
 * time constants and measures how far they have come apart, so it responds
 * to an instrument entering, a drop, or a chorus arriving, and stays flat
 * while the same beat repeats.
 */
function sectionNoveltyOf(
  freq: Uint8Array,
  sampleRate: number,
  state: DrawState,
  dt60: number,
): number {
  const nyq = sampleRate / 2;
  const short = state.scopeProfShort;
  const long = state.scopeProfLong;
  const ks = 1 - Math.pow(SCOPE_NOV_SHORT, dt60);
  const kl = 1 - Math.pow(SCOPE_NOV_LONG, dt60);
  let sumShort = 0;
  let sumLong = 0;
  for (let b = 0; b < SCOPE_NOV_BANDS; b++) {
    const i0 = Math.max(1, Math.floor((SCOPE_NOV_EDGES[b] / nyq) * freq.length));
    const i1 = Math.min(
      freq.length,
      Math.max(i0 + 1, Math.floor((SCOPE_NOV_EDGES[b + 1] / nyq) * freq.length)),
    );
    let sum = 0;
    for (let i = i0; i < i1; i++) sum += freq[i];
    const now = sum / (i1 - i0) / 255;
    short[b] += (now - short[b]) * ks;
    long[b] += (now - long[b]) * kl;
    sumShort += short[b];
    sumLong += long[b];
  }
  if (sumShort < 0.01 || sumLong < 0.01) return 0;

  // Each profile is normalized to unit sum before they are compared, so what
  // comes back is the distance between two SHAPES and carries no information
  // about level. Dividing the raw distance by the long profile's total is not
  // the same thing and is not enough: it rescales the measurement but leaves
  // a level change in it, so a passage that merely swelled read as a new one.
  // Measured that way a slow tremolo on otherwise constant material reached
  // 0.42, overlapping the 0.25 that real section changes produced, and no
  // threshold could separate them. A drop or a build still registers strongly
  // here, because instruments leaving changes the shape too.
  //
  // Range is 0..2 (total variation between two distributions). Because it is
  // already relative, it can carry a fixed threshold where the onset detector
  // could not.
  let dist = 0;
  for (let b = 0; b < SCOPE_NOV_BANDS; b++) {
    dist += Math.abs(short[b] / sumShort - long[b] / sumLong);
  }
  return dist;
}

/** Re-roll one facet of the figure. Called more than once per change, so a
 *  change reads as the figure deciding on something new rather than as a
 *  single parameter nudging. */
function rollScopeShape(state: DrawState): void {
  const roll = Math.random();
  if (roll < 0.34) {
    state.scopeSymmetry = 2 + Math.floor(Math.random() * 7); // 2..8
  } else if (roll < 0.5) {
    // Direction and rate together. Flipping direction alone always looked
    // the same, because the rate never changed — the figure wheeled at one
    // speed forever and only ever reversed. Re-rolling the multiplier is
    // what makes the motion read as phrased rather than as a metronome. 0 is
    // in the set not to stop the figure — measured, it is never still,
    // because the onset kick keeps feeding it — but to drop the steady rate
    // away so that between hits it drifts and on each hit it lurches.
    if (Math.random() < 0.55) state.scopeSpin = -state.scopeSpin;
    const RATES = [0, 0.3, 0.7, 1, 1.6, 2.6, 4];
    state.scopeSpinTarget = RATES[Math.floor(Math.random() * RATES.length)];
  } else if (roll < 0.74) {
    // Small rational ratios give closed, knot-like figures; anything far
    // from one just smears. A wider set than before, since this is the main
    // source of shape variety.
    const RATIOS = [0.5, 2 / 3, 0.75, 1, 1.25, 1.5, 5 / 3, 2, 2.5, 3, 4];
    state.scopeRatio = RATIOS[Math.floor(Math.random() * RATIOS.length)];
  } else {
    // Weighted hard toward the coarse grid. The even-ish split this replaces
    // spent more than half its time at lattice 0 — the ungridded free curve
    // — and only about a sixth on the coarse grid, which is the look
    // actually worth showing. 2 and 3 stay in as occasional variety and 0 as
    // contrast, but none of them are the default any more.
    const r = Math.random();
    state.scopeLattice = r < 0.7 ? 1 : r < 0.82 ? 2 : r < 0.9 ? 3 : 0;
    // Change the grid's geometry only some of the time, so a given cell
    // shape gets to be explored at several coarsenesses before it is
    // swapped out.
    if (Math.random() < 0.45) {
      state.scopeGridKind = Math.floor(Math.random() * SCOPE_GRID_COUNT);
    }
  }
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

/* ============================================================
   Full-stage fields — shared by Expanse and Nova
   ============================================================

   Scope and Bloom both centre a figure of radius min(w,h)*0.46 and leave
   whatever falls outside that inscribed circle to the ambience wash. In the
   banner strip that is the whole stage. Fullscreen it is not: on a 1512x850
   stage the figure's rim sits 391 px from centre while the corners sit 867 px
   out, so over half the picture carries no geometry at all and the style
   reads as a small object in a large dark room.

   Expanse and Nova are copies of those two that keep the figure and add a
   LAYOUT around it — the same trace stamped across the whole rectangle,
   tiled, radiating, mirrored or orbiting. The layout is treated as one more
   facet of the figure and re-rolled by the same novelty-arms-it,
   onset-lands-it machinery that re-rolls symmetry and ratio, so the way the
   stage is filled changes when the music changes rather than on a timer.

   Nothing here touches Scope or Bloom. They are deliberately unchanged. */

/** Wallpaper tiling: the figure repeated on a grid, mirrored cell to cell so
 *  the pattern is continuous across every seam. */
const FIELD_TILE = 0;
/** Concentric copies on a geometric scale ladder, the outer ones running off
 *  the edges. The screen is filled by what is passing through it. */
const FIELD_RADIATE = 1;
/** One copy per quadrant, stretched anisotropically so each reaches its own
 *  corner. The most literal reading of "fill the stage". */
const FIELD_MIRROR = 2;
/** A centre copy plus satellites on an ellipse sized to the stage, which is
 *  what puts geometry in the wide empty columns a 16:9 stage has either side
 *  of a circular figure. */
const FIELD_ORBIT = 3;
/** Nova only: outward-travelling shells spawned on bass onsets. Not a static
 *  layout — the stamps come from state.novaShells and expire. */
const FIELD_SHELLS = 4;

/** Which layouts each style draws from. Mirror belongs to Expanse because it
 *  stretches the figure, and a lattice trace survives that where a
 *  superformula outline reads as a squashed flower. Shells belong to Nova
 *  because a closed curve is what makes an expanding ring legible. */
const EXPANSE_MODES: readonly number[] = [FIELD_TILE, FIELD_RADIATE, FIELD_MIRROR, FIELD_ORBIT];
const NOVA_MODES: readonly number[] = [FIELD_SHELLS, FIELD_RADIATE, FIELD_ORBIT, FIELD_TILE];

/** One stamped copy: where it goes, and what the transform did to the stroke
 *  weight so it can be undone. */
interface Stamp {
  /** Placement, relative to stage centre. */
  m: DOMMatrix;
  /** sqrt(|det|) — the transform's isotropic scale. Line widths are divided
   *  by it so a copy at a tenth the size still draws a hairline rather than
   *  a tenth of one, which is otherwise invisible. */
  k: number;
  /** Position along the hue arc, 0..1. */
  hue: number;
  alpha: number;
}

/** Nova's travelling shells. */
interface Shell {
  /** Scale factor, multiplied up every frame until it leaves the stage. */
  k: number;
  born: number;
  strength: number;
}

/** Per-frame growth of a shell's scale, at 60 Hz. 1.021^60 is about 3.5x a
 *  second — fast enough that a shell crosses the stage within a bar at any
 *  tempo, slow enough to read as expansion rather than a flash. */
const SHELL_GROWTH = 1.021;
/** Scale a shell is born at, and the multiple of the corner distance past
 *  which it retires. Past 1 because a shell should leave through the edges,
 *  not vanish at them. */
const SHELL_BIRTH = 0.26;
const SHELL_RETIRE = 1.3;
/** Hard cap. A noisy onset detector on a busy mix can otherwise grow this
 *  without bound, and every shell is a full-width stroke. */
const SHELL_MAX = 13;
/** Longest a stretch of material may go without emitting. Sustained and
 *  ambient music contains no bass transients at all, and an empty stage is
 *  the failure this style exists to fix. */
const SHELL_IDLE_TICKS = 42;

/* ── What a field costs ───────────────────────────────────────────────────
 *
 * Ink on screen is (points per figure) x (figures), so a twelve-tile
 * wallpaper drawn at Scope's own per-figure detail is twelve times Scope.
 *
 * It does not need to be. Each tile is a twelfth the size, so a 680-point
 * trace in it resolves to nothing the eye can use. Trading detail for
 * coverage as the stamp count rises is what makes a full-stage field
 * affordable at all.
 *
 * Measured, 100 frames each at 1512x850 CSS on a 2x backing store:
 *
 *   Scope           0.56 ms     Expanse tile x4    1.05 ms
 *   Bloom           1.03 ms     Expanse tile x3    1.02 ms
 *   bars (shipped) 35.08 ms     Expanse radiate    1.36 ms
 *                               Expanse mirror     2.42 ms
 *                               Expanse orbit      1.14 ms
 *                               Nova tile x4       0.88 ms
 *                               Nova shells        0.71 ms
 *
 * A full-stage field is about twice the single centred figure, and a
 * thirtieth of a style that already ships. It got CHEAPER when the stagger
 * went in, despite every tile gaining detail, because the stagger made the
 * echo buffer redundant and that buffer was the dominant cost — twenty
 * strokes a frame, each carrying every stamp and every symmetry copy.
 *
 * Mirror is the dear one now, because it is the layout that does not
 * stagger: it keeps the echoes, and its four copies each cover the whole
 * stage rather than a cell of it.
 *
 * (Harness figures from an offscreen window that may not be GPU-accelerated,
 * and they move between runs — `bars` measured 57 ms on an earlier run and 35
 * here. Read them against each other within a run, not as absolute times.)
 * ─────────────────────────────────────────────────────────────────────── */
interface FieldDetail {
  /** Extra decimation on top of the density slider's own stride. */
  strideMul: number;
  /** Ceiling on rotational copies per stamp. */
  symCap: number;
  /** Beam-dwell intensity levels, which is one stroke each. */
  levels: number;
  /** Points kept per captured echo. */
  echoPoints: number;
}

function fieldDetail(stamps: number): FieldDetail {
  if (stamps <= 1) return { strideMul: 1, symCap: 8, levels: 5, echoPoints: 160 };
  if (stamps <= 4) return { strideMul: 1.2, symCap: 7, levels: 5, echoPoints: 110 };
  if (stamps <= 8) return { strideMul: 1.7, symCap: 6, levels: 4, echoPoints: 72 };
  return { strideMul: 2.4, symCap: 5, levels: 3, echoPoints: 48 };
}

/** Echo history for the field styles is shorter and sparser than Scope's,
 *  because the layout already supplies the mass that the phosphor trail
 *  supplies there. Six traces over 0.6 s, each carrying every stamp. */
const FIELD_ECHO_LIFE = 36;
const FIELD_ECHO_EVERY = 6;
const FIELD_ECHO_ALPHA = 0.13;

/**
 * Where the copies go.
 *
 * Returned in stage-centre coordinates: the caller translates to the middle
 * of the canvas and applies each matrix on top of that. `r0` is the radius
 * the figure's points were scaled to, so a stamp of scale 1 draws it at its
 * natural size.
 */
function fieldStamps(
  mode: number,
  count: number,
  w: number,
  h: number,
  r0: number,
  angle: number,
): Stamp[] {
  const out: Stamp[] = [];
  // Distance from centre to a corner. Every layout that wants to reach past
  // the edges measures against this, not against min(w,h) — that is the
  // whole difference between filling a circle and filling the stage.
  const coverR = Math.hypot(w, h) * 0.5;

  if (mode === FIELD_MIRROR) {
    // Each copy sits on the stage centre and is stretched to touch its own
    // corner, so four reflections superimpose into one figure that covers
    // the rectangle exactly. The aspect cap stops a 21:9 stage smearing the
    // trace into horizontal streaks; past it the copy simply overflows
    // vertically instead, which is the better failure.
    // 1.34, not 1.0. Scaling r0 onto the edge midpoint puts the figure's own
    // rim — which auto-ranges to 0.92*r0 — at the middle of each edge, and
    // the corners sit a further sqrt(2) out, so they stay black. Overscaling
    // means the copy is clipped halfway along each edge instead, which reads
    // as the pattern continuing past the screen rather than stopping short
    // of it. The aspect cap keeps a 21:9 stage from smearing the trace into
    // horizontal streaks; past it the copy overflows vertically instead,
    // which is the better failure.
    const ky = (h * 0.5 * 1.34) / r0;
    const kx = Math.min((w * 0.5 * 1.34) / r0, ky * 2.4);
    const k = Math.sqrt(kx * ky);
    const signs: readonly (readonly [number, number])[] = [[1, 1], [-1, 1], [1, -1], [-1, -1]];
    for (let i = 0; i < 4; i++) {
      const [sx, sy] = signs[i];
      out.push({
        m: new DOMMatrix([kx * sx, 0, 0, ky * sy, 0, 0]),
        k,
        hue: i / 4,
        // Four overlapping full-stage copies saturate to white at full
        // alpha; this is the level at which they read as four.
        alpha: 0.5,
      });
    }
    return out;
  }

  if (mode === FIELD_RADIATE) {
    // A geometric ladder outward until a copy has cleared the corners. The
    // ratio comes from `count` so a re-roll changes how densely the shells
    // are packed, not just how many there are.
    const step = count <= 2 ? 2.25 : count === 3 ? 1.85 : 1.6;
    let k = 0.34;
    // Pushed before the bound is tested, not after. Testing first stops one
    // rung short — the ladder's last copy is then the largest one that still
    // FITS, which is exactly the one that does not reach the corners, and
    // the layout quietly degenerates into the centred figure it replaces.
    for (let i = 0; i < 8; i++) {
      // Alternate copies counter-rotate against the figure's own spin. With
      // every shell turning the same way the whole thing reads as one rigid
      // object rotating; opposed, it reads as depth.
      const a = i % 2 === 0 ? angle * 0.35 : -angle * 0.55;
      const cos = Math.cos(a) * k;
      const sin = Math.sin(a) * k;
      out.push({
        m: new DOMMatrix([cos, sin, -sin, cos, 0, 0]),
        k,
        hue: i / 6,
        // Outer shells are larger and would otherwise dominate purely by
        // covering more pixels.
        alpha: 1 / (1 + i * 0.5),
      });
      if (k * r0 >= coverR * 1.15) break;
      k *= step;
    }
    return out;
  }

  if (mode === FIELD_ORBIT) {
    const n = 3 + count; // 5..7
    // The ellipse is sized off w and h separately, which is the point: on a
    // 16:9 stage that pushes satellites out into the columns either side of
    // the centre figure, where a circular orbit would leave them bunched.
    const rx = w * 0.4;
    const ry = h * 0.4;
    const kc = 0.62;
    out.push({ m: new DOMMatrix([kc, 0, 0, kc, 0, 0]), k: kc, hue: 0, alpha: 1 });
    // Sized off the gap between neighbours on the ellipse rather than off the
    // ellipse itself: satellites scaled to a fraction of the orbit radius
    // leave black between them on a wide stage, where the ring is long and
    // the copies are few. `arc` is that gap (the ellipse's perimeter is close
    // enough to pi*(rx+ry) for this), and 0.62 of it as a RADIUS means
    // neighbours overlap by about a seventh — the ring closes into a chain
    // instead of reading as separate objects. The second term is the backstop
    // for a stage so flat that the gap exceeds the orbit itself.
    const arc = (Math.PI * (rx + ry)) / n;
    const ks = Math.min(arc * 0.62, Math.min(rx, ry) * 0.9) / r0;
    for (let i = 0; i < n; i++) {
      // Half the figure's own rate, so the ring and the figure in it are
      // visibly turning at different speeds rather than locked together.
      const a = angle * 0.5 + (i / n) * Math.PI * 2;
      const cos = Math.cos(a) * ks;
      const sin = Math.sin(a) * ks;
      out.push({
        m: new DOMMatrix([cos, sin, -sin, cos, Math.cos(a) * rx, Math.sin(a) * ry]),
        k: ks,
        hue: (i + 1) / (n + 1),
        alpha: 0.78,
      });
    }
    return out;
  }

  // FIELD_TILE. Rows follow from columns and the aspect ratio so cells stay
  // roughly square whatever shape the stage is.
  const cols = Math.max(1, count);
  const rows = Math.max(1, Math.round((cols * h) / w));
  const cw = w / cols;
  const ch = h / rows;
  // 1.12 so adjacent cells overlap slightly. Exact packing leaves a visible
  // dark grid between tiles, which reads as a seam rather than a pattern.
  const k = (Math.min(cw, ch) * 0.5 * 1.12) / r0;
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      // Mirror every other cell in x. Reflected neighbours meet along their
      // shared edge instead of repeating, which is what turns a grid of
      // separate figures into one continuous wallpaper.
      const sx = (i + j) % 2 === 0 ? 1 : -1;
      out.push({
        m: new DOMMatrix([
          k * sx, 0, 0, k,
          (i + 0.5) * cw - w * 0.5,
          (j + 0.5) * ch - h * 0.5,
        ]),
        k,
        hue: (i + j) / Math.max(1, cols + rows - 2),
        alpha: 1,
      });
    }
  }
  return out;
}

/** Stamps for Nova's travelling shells, plus the live figure at the centre. */
function shellStamps(shells: Shell[], r0: number, coverR: number, angle: number): Stamp[] {
  const out: Stamp[] = [{ m: new DOMMatrix([0.5, 0, 0, 0.5, 0, 0]), k: 0.5, hue: 0, alpha: 1 }];
  const retire = (coverR * SHELL_RETIRE) / r0;
  for (let i = 0; i < shells.length; i++) {
    const sh = shells[i];
    const k = sh.k;
    // Fades out over the last third of its travel so a shell dissolves on
    // its way off the stage rather than being clipped away at the edge.
    const t = k / retire;
    const fade = t > 0.8 ? Math.max(0, 1 - (t - 0.8) / 0.2) : 1;
    const a = angle * (0.3 + (i % 3) * 0.2);
    const cos = Math.cos(a) * k;
    const sin = Math.sin(a) * k;
    out.push({
      m: new DOMMatrix([cos, sin, -sin, cos, 0, 0]),
      k,
      hue: (i % 5) / 5,
      alpha: fade * (0.3 + sh.strength * 0.6),
    });
  }
  return out;
}

/** Re-roll the layout. Called from the same place the figure's other facets
 *  are re-rolled, and only some of the time: a layout change moves everything
 *  on the stage at once, so it should be the rarest of the facets rather than
 *  one more thing turning over. Never picks the mode it is already on —
 *  a re-roll the viewer cannot see is worse than none. */
function rollField(state: DrawState, modes: readonly number[]): void {
  if (Math.random() < 0.45) {
    state.fieldCount = 2 + Math.floor(Math.random() * 3); // 2..4
    return;
  }
  let pick = modes[Math.floor(Math.random() * modes.length)];
  if (pick === state.fieldMode) {
    pick = modes[(modes.indexOf(pick) + 1 + Math.floor(Math.random() * (modes.length - 1))) % modes.length];
  }
  state.fieldMode = pick;
  state.fieldCount = 2 + Math.floor(Math.random() * 3);
}

/** Collapse the rotational copies into one path, so a stamped field costs one
 *  stroke per stamp instead of one per copy per stamp.
 *
 *  Scope strokes its copies separately because each carries its own hue, and
 *  that fan is most of what makes the figure legible. A field fans hue across
 *  its STAMPS instead — which is the stronger reading when there are twelve
 *  of them — and can therefore afford to bake the copies flat. */
function bakeCopies(src: Path2D, copies: number, angle: number): Path2D {
  const out = new Path2D();
  for (let c = 0; c < copies; c++) {
    const a = angle + (c * Math.PI * 2) / copies;
    const cos = Math.cos(a);
    const sin = Math.sin(a);
    out.addPath(src, new DOMMatrix([cos, sin, -sin, cos, 0, 0]));
  }
  return out;
}


/* ── Time-staggered stamps ────────────────────────────────────────────────
 *
 * A wallpaper of N identical figures is, to the eye, one figure. The
 * repetition is what gets read and the thing being repeated stops being
 * looked at — which is the complaint this layout earned the first time it
 * shipped, and it is a fair one.
 *
 * The answer is not fewer tiles. It is that a tile should not be a COPY of
 * the figure but a MOMENT of it. Every frame's finished paths go into a ring
 * buffer, and stamp i draws the frame from i * TILE_STAGGER ticks ago. Every
 * cell then shows a different instant of the same music, the pattern
 * propagates across the grid like a wave, and on a re-roll the old shape
 * visibly walks out of the field while the new one walks in — which is the
 * clearest that shape change has ever read.
 *
 * It costs nothing to draw. The paths were already being built once a frame
 * and stroked once a stamp; the only new cost is holding on to the last few
 * dozen of them.
 *
 * Mirror is deliberately excluded. Its four copies are reflections of ONE
 * instant, and the reflection is the entire content of that layout —
 * staggering them in time leaves four unrelated figures in four corners.
 * ─────────────────────────────────────────────────────────────────────── */

/** One frame's finished geometry: the dwell-shaded levels and the single
 *  whole-trace pass, rotational copies and that frame's rotation already
 *  baked in. Frozen by construction, because nothing redraws it. */
interface TileFrame {
  whole: Path2D;
  levels: Path2D[];
}

/** Ticks between one stamp and the next. At 6 the eighth cell of a 4x2 grid
 *  is 0.7 s behind the first — far enough apart that the cells are visibly
 *  different material, close enough that the grid still reads as one piece
 *  of music rather than eight. */
const TILE_STAGGER = 6;
/** Ceiling on the ring buffer. Twelve stamps at a stagger of 6 needs 67; the
 *  cap is what stops a future layout with more stamps quietly holding on to
 *  several hundred paths. */
const TILE_FRAMES_MAX = 80;

/** Push this frame's geometry and drop whatever has fallen off the end.
 *  `need` is sized to the live stamp count, so a four-tile layout does not
 *  carry the buffer a twelve-tile one would. */
function shedTileFrame(frames: TileFrame[], frame: TileFrame, need: number): void {
  frames.unshift(frame);
  const keep = Math.min(TILE_FRAMES_MAX, Math.max(1, need));
  if (frames.length > keep) frames.length = keep;
}

/** The frame stamp `i` should draw: its own age back through the buffer,
 *  clamped to whatever history exists so the grid is populated from the very
 *  first frame rather than filling in over the first second. The caller has
 *  always shed this frame already, so index 0 is this instant. */
function tileFrameFor(frames: TileFrame[], i: number, staggered: boolean): TileFrame {
  const back = staggered ? i * TILE_STAGGER : 0;
  return frames[Math.min(back, frames.length - 1)];
}

/* ── Perimeter spectrum ───────────────────────────────────────────────────
 *
 * The corner ambience lights the rim but draws nothing, so the outermost few
 * percent of the stage still has no detail in it at any amplitude. This is a
 * spectrum analyser wrapped around the edge of the frame: lows at the bottom
 * centre, climbing both ways around to air at the top centre, mirrored about
 * the vertical centreline so it reads as a frame rather than as a spiral.
 *
 * Every bar goes into one Path2D and the whole band is a single fill. That is
 * not a micro-optimisation: the canvas charges shadowBlur per draw call, and
 * a hundred separate filled bars is what took the bar styles from 120 fps to
 * 17 before they were batched.
 * ─────────────────────────────────────────────────────────────────────── */

/** Bands in the half-band, which is then mirrored. */
const RIM_BANDS = 48;
const RIM_LO_HZ = 30;
const RIM_HI_HZ = 16000;
/** Bar length at full scale, as a fraction of the shorter stage edge. Short
 *  on purpose — this is a frame around the figure, not a second visualizer
 *  competing with it. */
const RIM_DEPTH = 0.085;
/** Always-present baseline, so the frame is drawn in silence instead of
 *  appearing out of nothing on the first beat. */
const RIM_FLOOR = 0.09;
const RIM_RELEASE = 0.82;
const RIM_PEAK_DECAY = 0.9995;

function drawRimSpectrum(
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
  const rel = Math.pow(RIM_RELEASE, dt60);
  const decay = Math.pow(RIM_PEAK_DECAY, dt60);
  const env = state.rimEnv;
  const peak = state.rimPeak;
  const ratio = RIM_HI_HZ / RIM_LO_HZ;

  for (let b = 0; b < RIM_BANDS; b++) {
    const f0 = RIM_LO_HZ * Math.pow(ratio, b / RIM_BANDS);
    const f1 = RIM_LO_HZ * Math.pow(ratio, (b + 1) / RIM_BANDS);
    const i0 = Math.max(1, Math.floor((f0 / nyq) * freq.length));
    const i1 = Math.min(freq.length, Math.max(i0 + 1, Math.ceil((f1 / nyq) * freq.length)));
    let sum = 0;
    for (let i = i0; i < i1; i++) sum += freq[i];
    const raw = sum / (i1 - i0) / 255;
    // Per-band headroom, same as the corner ambience: the air bands never
    // approach the level the bass bands sit at, so a shared scale would
    // leave the top of the frame permanently flat.
    peak[b] = Math.max(raw, peak[b] * decay);
    const lit = Math.min(1, raw / Math.max(0.02, peak[b]));
    env[b] = lit > env[b] ? lit : env[b] * rel + lit * (1 - rel);
  }

  const depth = Math.min(w, h) * RIM_DEPTH;
  // Half the perimeter: half the bottom edge, a full side, then half the top
  // edge back to the centre — w*0.5 + h + w*0.5. Not w*0.5 + h, which is the
  // whole top edge missing and everything above 3 kHz crammed onto the sides.
  const halfLen = w + h;

  /** Inner edge of the band at a given distance around the perimeter from the
   *  bottom centre, interpolated between adjacent bands.
   *
   *  Interpolated, and a contour rather than bars, because 48 discrete bars
   *  around a frame read as a chart stuck to the picture however they are
   *  styled — square-ended they are a bar chart, round-ended a string of
   *  beads. A continuous membrane reads as light coming off the edge, which
   *  is what this layer is for. */
  const lenAt = (d: number): number => {
    const f = (d / halfLen) * RIM_BANDS - 0.5;
    const i0 = Math.max(0, Math.min(RIM_BANDS - 1, Math.floor(f)));
    const i1 = Math.max(0, Math.min(RIM_BANDS - 1, i0 + 1));
    const t = Math.max(0, Math.min(1, f - i0));
    const e = env[i0] * (1 - t) + env[i1] * t;
    return depth * (RIM_FLOOR + e * e * (1 - RIM_FLOOR));
  };

  // Two samples per band is enough: the bands are already the coarse
  // structure and anything finer is below the depth the band is drawn at.
  const STEPS = RIM_BANDS * 2;
  const bottom = new Path2D();
  bottom.moveTo(0, h);
  for (let i = 0; i <= STEPS; i++) {
    const x = (i / STEPS) * w;
    bottom.lineTo(x, h - lenAt(Math.abs(x - w * 0.5)));
  }
  bottom.lineTo(w, h);
  bottom.closePath();

  const top = new Path2D();
  top.moveTo(0, 0);
  for (let i = 0; i <= STEPS; i++) {
    const x = (i / STEPS) * w;
    top.lineTo(x, lenAt(w * 0.5 + h + Math.min(x, w - x)));
  }
  top.lineTo(w, 0);
  top.closePath();

  const right = new Path2D();
  const left = new Path2D();
  right.moveTo(w, 0);
  left.moveTo(0, 0);
  for (let i = 0; i <= STEPS; i++) {
    const y = (i / STEPS) * h;
    const len = lenAt(w * 0.5 + (h - y));
    right.lineTo(w - len, y);
    left.lineTo(len, y);
  }
  right.lineTo(w, h);
  right.closePath();
  left.lineTo(0, h);
  left.closePath();

  ctx.save();
  // Additive for the same reason the corner wash is: a peripheral layer may
  // brighten the stage, never darken what is drawn over it.
  ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = Math.min(1, 0.5 * amount);
  // Palette position walks around the frame with the spectrum — the bottom
  // carries the first stop, the top the last — and creeps forward so the
  // whole band drifts rather than sitting still. Same idea as the corner
  // wash, one dimension simpler.
  const drift = ((state.tick * 0.0004) % 1 + 1) % 1;
  const edges: readonly (readonly [Path2D, number, number, number, number, number])[] = [
    [bottom, 0.0, w * 0.5, h, w * 0.5, h - depth],
    [right, 0.45, w, h * 0.5, w - depth, h * 0.5],
    [left, 0.45, 0, h * 0.5, depth, h * 0.5],
    [top, 0.9, w * 0.5, 0, w * 0.5, depth],
  ];
  for (const [path, pos, x0, y0, x1, y1] of edges) {
    const [r, g, bl] = sampleRgbAt(palette, (pos + drift) % 1);
    const grad = ctx.createLinearGradient(x0, y0, x1, y1);
    grad.addColorStop(0, `rgba(${r},${g},${bl},1)`);
    grad.addColorStop(0.35, `rgba(${r},${g},${bl},0.3)`);
    grad.addColorStop(1, `rgba(${r},${g},${bl},0)`);
    ctx.fillStyle = grad;
    ctx.fill(path);
  }
  ctx.restore();
  ctx.globalAlpha = 1;
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

/* ── Expanse (Scope, stamped across the stage) ────────────────────────── */

/**
 * Scope's trace, laid out across the whole rectangle.
 *
 * A copy of drawLissajous — same goniometer, same spatial smoothing, same
 * lattice snapping, same beam-dwell shading — with one thing added: the
 * finished figure is stamped into a LAYOUT instead of being drawn once in the
 * middle. See the field machinery above for why, and for what each layout is.
 *
 * Two deliberate departures from the original, both forced by having many
 * copies instead of one:
 *
 * The hue arc fans across STAMPS, not across symmetry copies. Scope strokes
 * its copies one at a time so each can carry its own gradient; at twelve
 * stamps that is twelve times the stroke count, which the stage cannot
 * afford. Baking the copies into one path and colouring per stamp costs the
 * same and reads better anyway — on a wallpaper, neighbouring tiles differing
 * is the pattern.
 *
 * And detail falls as coverage rises (fieldDetail). A twelfth-size tile
 * cannot resolve a 680-point trace, so spending one there is pure cost.
 *
 * Returns the updated peak tracker.
 */
function drawExpanse(
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
  lattice: number,
  gridKind: number,
  echoes: { path: Path2D; born: number }[],
  frames: TileFrame[],
  mode: number,
  fieldCount: number,
  /** Layouts are immersive-only. Twelve tiles across a 110px strip is a
   *  texture, not a visualizer, and the strip has no empty space to fill in
   *  the first place — that is the entire problem this style exists for. */
  large: boolean,
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

  const stamps = large
    ? fieldStamps(mode, fieldCount, w, h, radius, angle)
    : [{ m: new DOMMatrix([1, 0, 0, 1, 0, 0]), k: 1, hue: 0, alpha: 1 }];
  const detail = fieldDetail(stamps.length);

  // Spatial smoothing along the trace, not temporal across frames — see the
  // long note in drawLissajous; averaging index i against the previous
  // frame's index i collapses the figure, because the analyser buffer is not
  // phase-locked.
  const win = 1 + Math.round(Math.min(0.95, smoothing) * 7);
  const stride = Math.max(
    1,
    Math.round(detail.strideMul / Math.max(0.05, Math.min(1, density))),
  );
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
    py[j] = -r * Math.cos(ratio * Math.PI * (j / count)) - r * 0.35;
    const m = Math.abs(l) > Math.abs(r) ? Math.abs(l) : Math.abs(r);
    if (m > peak) peak = m;
  }

  const nextPeak = peak > prevPeak ? peak : prevPeak * 0.985 + peak * 0.015;
  const scale = (radius * SCOPE_FILL) / Math.max(0.05, nextPeak);
  for (let i = 0; i < count; i++) {
    px[i] *= scale;
    py[i] *= scale;
  }

  // Lattice snapping, in the figure's own space so every stamp snaps to the
  // same grid and the tiles line up node for node across their seams.
  if (lattice > 0) {
    const steps = 3 + lattice * 3;
    const cell = (radius * SCOPE_FILL) / steps;
    if (gridKind === SCOPE_GRID_SQUARE) {
      for (let i = 0; i < count; i++) {
        px[i] = Math.round(px[i] / cell) * cell;
        py[i] = Math.round(py[i] / cell) * cell;
      }
    } else if (gridKind === SCOPE_GRID_DIAMOND) {
      const c = Math.SQRT1_2;
      for (let i = 0; i < count; i++) {
        const u = Math.round(((px[i] + py[i]) * c) / cell) * cell;
        const v = Math.round(((py[i] - px[i]) * c) / cell) * cell;
        px[i] = (u - v) * c;
        py[i] = (u + v) * c;
      }
    } else if (gridKind === SCOPE_GRID_TRIANGLE) {
      const hh = Math.sqrt(3) / 2;
      for (let i = 0; i < count; i++) {
        const b = Math.round(py[i] / (cell * hh));
        const a = Math.round((px[i] - b * cell * 0.5) / cell);
        px[i] = a * cell + b * cell * 0.5;
        py[i] = b * cell * hh;
      }
    } else {
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

  // Beam dwell: a CRT burns brighter where the beam lingers.
  const LEVELS = detail.levels;
  let total = 0;
  for (let i = 1; i < count; i++) {
    total += Math.abs(px[i] - px[i - 1]) + Math.abs(py[i] - py[i - 1]);
  }
  const meanLen = Math.max(1e-3, total / Math.max(1, count - 1));

  const sym = Math.max(1, Math.min(detail.symCap, symmetry));

  const levelPaths: Path2D[] = [];
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
    levelPaths.push(bakeCopies(path, sym, angle));
  }

  const single = new Path2D();
  single.moveTo(px[0], py[0]);
  for (let i = 1; i < count; i++) single.lineTo(px[i], py[i]);
  const whole = bakeCopies(single, sym, angle);

  // Mirror's copies are reflections of one instant; everything else stamps
  // the figure at a place, and a place can just as well be a time.
  const staggered = large && mode !== FIELD_MIRROR && stamps.length > 1;
  shedTileFrame(frames, { whole, levels: levelPaths },
    staggered ? (stamps.length - 1) * TILE_STAGGER + 1 : 1);

  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  const baseW = Math.max(0.7, Math.min(2.4, baseR * 0.006));
  // Carries the whole glow, because the canvas shadow is off for this style.
  const bloomW = Math.max(2, baseR * 0.05 * (0.4 + glow));

  const grads: CanvasGradient[] = [];
  for (let i = 0; i < stamps.length; i++) {
    grads.push(scopeGradient(ctx, radius, palette, stamps[i].hue * SCOPE_HUE_ARC, i > 0));
  }

  // ── Capture this frame's field, retire the expired ones ──
  // Stamps and symmetry copies are both baked in, so redrawing a whole
  // remembered field costs one stroke.
  // The stagger IS the history when it is on, and a second one drawn from
  // the CURRENT trace across every stamp would smear the tiles back toward
  // each other — undoing the only thing that stops them being copies. So the
  // echo buffer runs for Mirror and for a single-stamp stage, and nowhere
  // else.
  if (staggered) echoes.length = 0;
  if (!staggered && (echoes.length === 0 || tick - echoes[echoes.length - 1].born >= FIELD_ECHO_EVERY)) {
    const step = Math.max(1, Math.floor(count / detail.echoPoints));
    const thin = new Path2D();
    thin.moveTo(px[0], py[0]);
    for (let i = step; i < count; i += step) thin.lineTo(px[i], py[i]);
    const baked = new Path2D();
    for (let si = 0; si < stamps.length; si++) {
      for (let c = 0; c < sym; c++) {
        const a = angle + (c * Math.PI * 2) / sym;
        const cos = Math.cos(a);
        const sin = Math.sin(a);
        baked.addPath(thin, stamps[si].m.multiply(new DOMMatrix([cos, sin, -sin, cos, 0, 0])));
      }
    }
    echoes.push({ path: baked, born: tick });
  }
  while (echoes.length > 0 && tick - echoes[0].born > FIELD_ECHO_LIFE) echoes.shift();

  ctx.save();
  ctx.translate(cx, cy);

  // History first, so the live field lands on top. One stroke per remembered
  // frame, at a width set from the geometric mean of the stamp scales —
  // layouts that mix a small centre with large outer shells will draw the
  // outer ones heavier, which is the right way round for depth.
  let logK = 0;
  for (const st of stamps) logK += Math.log(Math.max(1e-3, st.k));
  const meanK = Math.exp(logK / stamps.length);
  ctx.strokeStyle = grads[0];
  ctx.lineWidth = (baseW * 0.85) / meanK;
  for (let e = 0; e < echoes.length; e++) {
    const age = (tick - echoes[e].born) / FIELD_ECHO_LIFE;
    if (age >= 1) continue;
    const k = 1 - age;
    ctx.globalAlpha = k * k * FIELD_ECHO_ALPHA;
    ctx.stroke(echoes[e].path);
  }
  ctx.globalAlpha = 1;
  ctx.restore();

  for (let si = 0; si < stamps.length; si++) {
    const st = stamps[si];
    ctx.save();
    ctx.translate(cx, cy);
    ctx.transform(st.m.a, st.m.b, st.m.c, st.m.d, st.m.e, st.m.f);
    ctx.strokeStyle = grads[si];
    // Widths are divided by the stamp's scale because the transform has
    // already multiplied them by it. Without this a tile at a tenth the size
    // draws a tenth of a hairline, which is nothing at all.
    const kw = Math.max(1e-3, st.k);

    const fr = tileFrameFor(frames, si, staggered);

    ctx.globalAlpha = (0.05 + glow * 0.07) * st.alpha * 2;
    ctx.lineWidth = bloomW / kw;
    ctx.stroke(fr.whole);

    for (let lvl = 0; lvl < fr.levels.length; lvl++) {
      const n = fr.levels.length;
      const t = n > 1 ? lvl / (n - 1) : 1;
      ctx.globalAlpha = (0.1 + t * 0.75) * st.alpha * 0.46;
      ctx.lineWidth = (baseW * (0.75 + t * 0.6)) / kw;
      ctx.stroke(fr.levels[lvl]);
    }
    ctx.restore();
  }
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

/** Curated [m1, m2, n1, n2, n3] parameter sets.
 *
 *  Most of the superformula's parameter space is ugly, and the few regions
 *  that aren't are what people mean by "geometric". Randomizing the
 *  exponents lands in the ugly part most of the time. A fixed table cannot.
 *  Interpolating between two entries stays near the good region, so morphing
 *  between them is safe where a random walk was not.
 *
 *  These are all chosen from the curved side of that space: n1 below 1 with
 *  low n2/n3 gives smooth lobes, where the large exponents that produce
 *  hard-edged polygons and cusped stars belong to Scope.
 *
 *  m1 and m2 are the fold counts of the cosine and sine terms. Equal for
 *  every rotationally symmetric entry; the three at the end differ, which is
 *  the only way to get a form with no rotational symmetry at all out of this
 *  formula. That family mostly degenerates — of twelve pairs rendered and
 *  inspected, most collapsed to a line or left the curve open, and these are
 *  the three that survived. Do not add to it without looking at the result.
 */
const CRYSTAL_SHAPES: readonly [number, number, number, number, number][] = [
  // ── smooth lobes and petals ──
  [3, 3, 0.5, 1.5, 1.5],     // trefoil — three smooth lobes
  [4, 4, 0.5, 1.5, 1.5],     // quatrefoil
  [5, 5, 0.4, 1.6, 1.6],     // five-petal rose
  [6, 6, 0.6, 1.4, 1.4],     // six-petal bloom
  [8, 8, 0.5, 1.3, 1.3],     // eight-lobe rosette
  [5, 5, 0.3, 1.7, 1.7],     // sharper five-petal
  [7, 7, 0.45, 1.5, 1.5],    // seven-point soft star
  [9, 9, 0.4, 1.4, 1.4],     // nine-point star
  [10, 10, 0.55, 1.35, 1.35],// ten-point star
  [11, 11, 0.5, 1.3, 1.3],   // eleven-point, finely spiked
  // ── rounded polygons ──
  [3, 3, 1, 1, 1],           // rounded triangle
  [5, 5, 1, 1, 1],           // concave pentagon
  [6, 6, 1, 1, 1],           // rounded hexagon
  [12, 12, 1, 1, 1],         // rippled disc
  [16, 16, 1.2, 1, 1],       // fine ripple ring
  // ── soft-armed stars ──
  [2, 2, 1, 4, 8],           // teardrop
  [3, 3, 2, 13, 3],          // three-lobe teardrop
  [4, 4, 1.8, 9, 9],         // four-arm cross
  [5, 5, 2, 13, 3],          // soft-armed starfish
  [5, 5, 1.7, 8, 8],         // thin five-arm starfish
  [6, 6, 2, 7, 7],           // six-arm starfish
  [8, 8, 2.2, 6, 6],         // eight-arm starfish
  // ── ruffled ──
  [7, 7, 3, 4, 17],          // ruffled flower
  [6, 6, 3, 14, 4],          // six-arm ruffle
  // ── asymmetric folds, m1 != m2 ──
  [2, 6, 1, 1, 1],           // dart
  [8, 4, 0.5, 1.3, 1.3],     // lopsided cross
  [4, 6, 1, 1, 1],           // arrowhead
];

/** Gielis superformula radius at `theta`, with a = b = 1.
 *
 *  m1 and m2 are separate so the two terms can carry different fold counts;
 *  with them equal this is the ordinary symmetric form. */
function superRadius(
  theta: number,
  m1: number,
  m2: number,
  n1: number,
  n2: number,
  n3: number,
): number {
  const a = Math.pow(Math.abs(Math.cos((m1 * theta) / 4)), n2);
  const b = Math.pow(Math.abs(Math.sin((m2 * theta) / 4)), n3);
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
  m1: number,
  m2: number,
  nParams: Float32Array,
  density: number,
  echoes: { path: Path2D; born: number }[],
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
      superRadius(th, m1, m2, n1, n2, n3) * (1 + mid * CRYSTAL_MID_DEPTH) +
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

  const foldBasis = Math.max(1, Math.min(m1, m2));

  // ── Footprint ──
  // A decimated copy of the outline with every layer's rotation and shrink
  // baked in, kept for a second and redrawn each frame at an age-derived
  // alpha. One Path2D covers all the layers, so the history costs one stroke
  // per captured frame rather than one per layer.
  if (echoes.length === 0 || tick - echoes[echoes.length - 1].born >= SCOPE_ECHO_EVERY) {
    const step = Math.max(1, Math.floor(count / SCOPE_ECHO_POINTS));
    const single = new Path2D();
    single.moveTo(px[0], py[0]);
    for (let i = step; i < count; i += step) single.lineTo(px[i], py[i]);
    single.closePath();
    const baked = new Path2D();
    for (let c = 0; c < lay; c++) {
      const a = angle + (c * Math.PI * 2) / (foldBasis * lay);
      const shrink = 1 - c * 0.24;
      const cos = Math.cos(a) * shrink;
      const sin = Math.sin(a) * shrink;
      baked.addPath(single, new DOMMatrix([cos, sin, -sin, cos, 0, 0]));
    }
    echoes.push({ path: baked, born: tick });
  }
  while (echoes.length > 0 && tick - echoes[0].born > SCOPE_ECHO_LIFE) echoes.shift();

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

  // History first, so the live outline lands on top. Stroked with the palette
  // gradient rather than a flat grey: the radial colour ramp is most of what
  // gives the figure its colour, and a grey trail would wash it out.
  ctx.strokeStyle = grads[0];
  ctx.lineWidth = baseW * 0.85;
  for (let e = 0; e < echoes.length; e++) {
    const age = (tick - echoes[e].born) / SCOPE_ECHO_LIFE;
    if (age >= 1) continue;
    // Squared falloff: linear keeps old outlines legible too long and the
    // stage fills up again.
    const k = 1 - age;
    ctx.globalAlpha = k * k * SCOPE_ECHO_ALPHA;
    ctx.stroke(echoes[e].path);
  }

  for (let c = 0; c < lay; c++) {
    ctx.save();
    // Layers are offset by a fraction of the shape's OWN fold angle. Rotating
    // by an arbitrary 2π/copies instead — what Scope does, correctly, for an
    // unstructured trace — would beat the outline's fold periodicity against
    // an unrelated one, and that interference is precisely what reads as
    // clutter. Aligning to the fold count means the layers interlock.
    //
    // The coarser of the two terms is the one to align to. For the asymmetric
    // entries the form has no rotational symmetry to speak of, so there is no
    // exactly right answer; the smaller fold count gives the widest offset,
    // which keeps the layers from piling up on each other.
    ctx.rotate(angle + (c * Math.PI * 2) / (foldBasis * lay));
    const shrink = 1 - c * 0.24;
    ctx.scale(shrink, shrink);
    const copyAlpha = c === 0 ? 1 : 0.5;
    ctx.strokeStyle = grads[c];

    // Recalibrated for clear-and-redraw. These were tuned when the canvas
    // accumulated across roughly a dozen frames, where a per-frame stroke
    // this bright would have saturated instantly; now one frame's stroke is
    // the whole of what is seen, so they carry the image outright. The factor
    // is not the accumulation count — alpha compositing saturates, so it
    // stacks as 1-(1-a)^n rather than n*a — and was chosen by looking at
    // rendered candidates, because there was no previous number to match to:
    // the old behaviour never settled. Measured, its coverage ratcheted from
    // 10% of the stage to 56% between wipes and its ink swung 0.36 to 7.55,
    // so any single sample of it was a point on a sawtooth. What these were
    // checked for instead is that they hold still: 2-6% drift over 15 s.
    ctx.globalAlpha = (0.05 + glow * 0.07) * copyAlpha * 1.3;
    ctx.lineWidth = bloomW;
    ctx.stroke(whole);

    for (let lvl = 0; lvl < LEVELS; lvl++) {
      ctx.globalAlpha = (0.1 + (lvl / (LEVELS - 1)) * 0.75) * copyAlpha * 1.05;
      ctx.lineWidth = baseW * (0.75 + (lvl / (LEVELS - 1)) * 0.6);
      ctx.stroke(paths[lvl]);
    }
    ctx.restore();
  }
  ctx.restore();
  ctx.globalAlpha = 1;

  return nextPeak;
}

/* ── Nova (Bloom, stamped across the stage) ───────────────────────────── */

/**
 * Bloom's superformula outline, laid out across the whole rectangle.
 *
 * A copy of drawCrystal — same Gielis outline from the same curated table,
 * same mid/side displacement, same morph between presets — stamped into a
 * layout rather than drawn once in the middle.
 *
 * Its own layout is the shells: a closed curve is the one figure where an
 * expanding copy reads as a ring leaving the stage, so Nova gets that where
 * Expanse gets the quadrant mirror. A shell is born on a bass onset at a
 * quarter size and multiplies outward until it has cleared the corners,
 * which means the geometry sweeps continuously through every part of the
 * stage instead of sitting in the middle of it.
 *
 * Returns the updated peak tracker.
 */
function drawNova(
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
  m1: number,
  m2: number,
  nParams: Float32Array,
  density: number,
  echoes: { path: Path2D; born: number }[],
  frames: TileFrame[],
  mode: number,
  fieldCount: number,
  shells: Shell[],
  large: boolean,
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
  const coverR = Math.hypot(w, h) * 0.5;

  const stamps = !large
    ? [{ m: new DOMMatrix([1, 0, 0, 1, 0, 0]), k: 1, hue: 0, alpha: 1 }]
    : mode === FIELD_SHELLS
      // baseR, not `radius` — advanceShells retires against the same
      // un-breathed radius, and the two have to agree or a shell fades at a
      // different point than it expires.
      ? shellStamps(shells, baseR, coverR, angle)
      : fieldStamps(mode, fieldCount, w, h, radius, angle);
  const detail = fieldDetail(stamps.length);

  // Resolution, not line count — the figure is one closed curve either way.
  // Divided by the field's detail budget for the same reason Expanse strides
  // its trace: a shell crossing the far corner at four times size does not
  // need the point count a single centred figure does.
  const dens = Math.min(1, Math.max(0.05, density));
  const count = Math.min(
    px.length,
    Math.max(48, Math.round((120 + dens * 600) / detail.strideMul)),
  );

  const win = 1 + Math.round(Math.min(0.95, smoothing) * 10);

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
    // Mirrored rather than wrapped, so r(2π) === r(0) and the curve closes
    // without a radial seam — see drawCrystal.
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
      superRadius(th, m1, m2, n1, n2, n3) * (1 + mid * CRYSTAL_MID_DEPTH) +
      side * CRYSTAL_SIDE_DEPTH;
    const clamped = rr > 0 ? rr : 0;
    px[j] = Math.cos(th) * clamped;
    py[j] = Math.sin(th) * clamped;
    if (clamped > peak) peak = clamped;
  }

  const nextPeak = prevPeak * 0.9 + peak * 0.1;
  const scale = (radius * SCOPE_FILL * sizeMul) / Math.max(0.05, nextPeak);
  for (let i = 0; i < count; i++) {
    px[i] *= scale;
    py[i] *= scale;
  }

  const LEVELS = detail.levels;
  let total = 0;
  for (let i = 1; i <= count; i++) {
    const a = i % count;
    total += Math.abs(px[a] - px[i - 1]) + Math.abs(py[a] - py[i - 1]);
  }
  const meanLen = Math.max(1e-3, total / count);

  // Layers nest inside one stamp; stamps place that nest around the stage.
  // Capped hard once the field is busy — a three-deep nest in each of twelve
  // tiles is thirty-six outlines, and none of them are legible.
  const foldBasis = Math.max(1, Math.min(m1, m2));
  const lay = Math.max(1, Math.min(stamps.length > 4 ? 1 : stamps.length > 1 ? 2 : 3, layers));

  /** Bake the nested layers flat. Offsets are a fraction of the shape's OWN
   *  fold angle, not an arbitrary 2π/n: beating the outline's fold
   *  periodicity against an unrelated one is exactly what reads as clutter. */
  const nest = (src: Path2D): Path2D => {
    const out = new Path2D();
    for (let c = 0; c < lay; c++) {
      const a = angle + (c * Math.PI * 2) / (foldBasis * lay);
      const shrink = 1 - c * 0.24;
      const cos = Math.cos(a) * shrink;
      const sin = Math.sin(a) * shrink;
      out.addPath(src, new DOMMatrix([cos, sin, -sin, cos, 0, 0]));
    }
    return out;
  };

  const levelPaths: Path2D[] = [];
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
    levelPaths.push(nest(path));
  }

  const single = new Path2D();
  single.moveTo(px[0], py[0]);
  for (let i = 1; i < count; i++) single.lineTo(px[i], py[i]);
  single.closePath();
  const whole = nest(single);

  const staggered = large && mode !== FIELD_MIRROR && stamps.length > 1;
  shedTileFrame(frames, { whole, levels: levelPaths },
    staggered ? (stamps.length - 1) * TILE_STAGGER + 1 : 1);

  const grads: CanvasGradient[] = [];
  for (let i = 0; i < stamps.length; i++) {
    grads.push(scopeGradient(ctx, radius, palette, stamps[i].hue * SCOPE_HUE_ARC, i > 0));
  }

  // The stagger IS the history when it is on, and a second one drawn from
  // the CURRENT trace across every stamp would smear the tiles back toward
  // each other — undoing the only thing that stops them being copies. So the
  // echo buffer runs for Mirror and for a single-stamp stage, and nowhere
  // else.
  if (staggered) echoes.length = 0;
  if (!staggered && (echoes.length === 0 || tick - echoes[echoes.length - 1].born >= FIELD_ECHO_EVERY)) {
    const step = Math.max(1, Math.floor(count / detail.echoPoints));
    const thin = new Path2D();
    thin.moveTo(px[0], py[0]);
    for (let i = step; i < count; i += step) thin.lineTo(px[i], py[i]);
    thin.closePath();
    const nested = nest(thin);
    const baked = new Path2D();
    for (let si = 0; si < stamps.length; si++) {
      baked.addPath(nested, stamps[si].m);
    }
    echoes.push({ path: baked, born: tick });
  }
  while (echoes.length > 0 && tick - echoes[0].born > FIELD_ECHO_LIFE) echoes.shift();

  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  const baseW = Math.max(0.7, Math.min(2.4, baseR * 0.006));
  const bloomW = Math.max(3, baseR * 0.045 * (0.4 + glow));

  ctx.save();
  ctx.translate(cx, cy);
  let logK = 0;
  for (const st of stamps) logK += Math.log(Math.max(1e-3, st.k));
  const meanK = Math.exp(logK / stamps.length);
  ctx.strokeStyle = grads[0];
  ctx.lineWidth = (baseW * 0.85) / meanK;
  for (let e = 0; e < echoes.length; e++) {
    const age = (tick - echoes[e].born) / FIELD_ECHO_LIFE;
    if (age >= 1) continue;
    const k = 1 - age;
    ctx.globalAlpha = k * k * FIELD_ECHO_ALPHA;
    ctx.stroke(echoes[e].path);
  }
  ctx.globalAlpha = 1;
  ctx.restore();

  for (let si = 0; si < stamps.length; si++) {
    const st = stamps[si];
    ctx.save();
    ctx.translate(cx, cy);
    ctx.transform(st.m.a, st.m.b, st.m.c, st.m.d, st.m.e, st.m.f);
    ctx.strokeStyle = grads[si];
    const kw = Math.max(1e-3, st.k);

    const fr = tileFrameFor(frames, si, staggered);

    ctx.globalAlpha = (0.05 + glow * 0.07) * st.alpha * 1.3;
    ctx.lineWidth = bloomW / kw;
    ctx.stroke(fr.whole);

    for (let lvl = 0; lvl < fr.levels.length; lvl++) {
      const n = fr.levels.length;
      const t = n > 1 ? lvl / (n - 1) : 1;
      ctx.globalAlpha = (0.1 + t * 0.75) * st.alpha * 1.05;
      ctx.lineWidth = (baseW * (0.75 + t * 0.6)) / kw;
      ctx.stroke(fr.levels[lvl]);
    }
    ctx.restore();
  }
  ctx.globalAlpha = 1;

  return nextPeak;
}

/** Advance Nova's shells and retire the ones that have left the stage.
 *  Separate from the draw so the dispatcher can spawn on the same bass delta
 *  it already measured for the re-roll logic. */
function advanceShells(
  shells: Shell[],
  r0: number,
  coverR: number,
  dt60: number,
): void {
  const retire = (coverR * SHELL_RETIRE) / r0;
  const grow = Math.pow(SHELL_GROWTH, dt60);
  let write = 0;
  for (let i = 0; i < shells.length; i++) {
    const sh = shells[i];
    sh.k *= grow;
    if (sh.k < retire) shells[write++] = sh;
  }
  shells.length = write;
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

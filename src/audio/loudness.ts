/**
 * ITU-R BS.1770-4 programme loudness (LUFS).
 *
 * The enhancer already had a loudness number and it was wrong: it read digital
 * RMS off 8-bit time-domain data whose own noise floor sat inside the window
 * being measured. That is bug #5 of the six that made AI Enhance sound worse
 * than flat, and it is the reason this file exists.
 *
 * It matters twice over. Equal-loudness compensation is keyed to how loud the
 * programme actually is, and RMS is not that. More importantly, preference
 * learning compares two versions of a curve and asks which sounds better — if
 * the two are not level-matched to a perceptual standard, the comparison only
 * ever learns "louder wins" and every pair collected is wasted.
 *
 * No imports, on purpose: `scripts/check-enhancer.mjs` compiles this file
 * standalone and runs it under plain node, with no bundler and no
 * AudioContext. Keep it that way or it drops out of the only gate this repo
 * has.
 */

// ── K-weighting ──────────────────────────────────────────────────────────

/**
 * BS.1770 specifies its two filter stages as coefficient tables at 48 kHz and
 * says nothing about other rates, but the tables are just a high shelf and a
 * high-pass. These are the analog prototype parameters that reproduce the
 * published 48 kHz tables through the standard bilinear design, so the same
 * weighting can be built at whatever rate the device is actually running —
 * a hardcoded 48 kHz table silently mis-weights a 44.1 kHz stream.
 */
const SHELF_F0_HZ = 1681.9744509555319;
const SHELF_GAIN_DB = 3.999843853973347;
const SHELF_Q = 0.7071752369554193;
const HIGHPASS_F0_HZ = 38.13547087602444;
const HIGHPASS_Q = 0.5003270373238773;

/** Direct form I coefficients, already normalised by a0. */
interface Biquad {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

/**
 * Both stages use the bilinear (tan) form rather than the RBJ cookbook form.
 * They agree on the denominator, but RBJ normalises the numerator and
 * BS.1770 does not: the cookbook high-pass yields b0 = 0.99503 where the
 * standard's table says 1.0, a constant -0.043 dB on every reading. These
 * reproduce the published 48 kHz tables to 14 decimal places, which is what
 * check-enhancer asserts.
 */
function highShelf(f0Hz: number, gainDb: number, q: number, sampleRate: number): Biquad {
  const K = Math.tan((Math.PI * f0Hz) / sampleRate);
  const vh = Math.pow(10, gainDb / 20);
  // Curve-fit exponent from libebur128's derivation of the same table.
  const vb = Math.pow(vh, 0.4996667741545416);
  const a0 = 1 + K / q + K * K;
  return {
    b0: (vh + (vb * K) / q + K * K) / a0,
    b1: (2 * (K * K - vh)) / a0,
    b2: (vh - (vb * K) / q + K * K) / a0,
    a1: (2 * (K * K - 1)) / a0,
    a2: (1 - K / q + K * K) / a0,
  };
}

function highPass(f0Hz: number, q: number, sampleRate: number): Biquad {
  const K = Math.tan((Math.PI * f0Hz) / sampleRate);
  const a0 = 1 + K / q + K * K;
  // Numerator left unnormalised, exactly as the standard tabulates it.
  return {
    b0: 1,
    b1: -2,
    b2: 1,
    a1: (2 * (K * K - 1)) / a0,
    a2: (1 - K / q + K * K) / a0,
  };
}

/** The two K-weighting stages, in the order the signal passes through them. */
export function kWeightingStages(sampleRate: number): [Biquad, Biquad] {
  return [
    highShelf(SHELF_F0_HZ, SHELF_GAIN_DB, SHELF_Q, sampleRate),
    highPass(HIGHPASS_F0_HZ, HIGHPASS_Q, sampleRate),
  ];
}

/** Direct form I state for one biquad on one channel. */
interface BiquadState {
  x1: number;
  x2: number;
  y1: number;
  y2: number;
}

function newState(): BiquadState {
  return { x1: 0, x2: 0, y1: 0, y2: 0 };
}

function step(c: Biquad, s: BiquadState, x: number): number {
  const y = c.b0 * x + c.b1 * s.x1 + c.b2 * s.x2 - c.a1 * s.y1 - c.a2 * s.y2;
  s.x2 = s.x1;
  s.x1 = x;
  s.y2 = s.y1;
  s.y1 = y;
  return y;
}

// ── Gating ───────────────────────────────────────────────────────────────

/** BS.1770 gating block, and its 75% overlap expressed as the step between
 *  blocks. Everything is accumulated in 100 ms quarters so a block is just
 *  the last four of them. */
const BLOCK_DURATION_MS = 400;
const QUARTER_DURATION_MS = 100;
const QUARTERS_PER_BLOCK = BLOCK_DURATION_MS / QUARTER_DURATION_MS;

/** Short-term window from EBU R128. */
const SHORT_TERM_DURATION_MS = 3000;
const QUARTERS_PER_SHORT_TERM = SHORT_TERM_DURATION_MS / QUARTER_DURATION_MS;

/** The dB offset that puts a 0 dBFS 1 kHz sine at 0 LUFS. */
const LOUDNESS_OFFSET_DB = -0.691;

/** Absolute gate. Blocks quieter than this are silence, not programme. */
const ABSOLUTE_GATE_LUFS = -70;

/** Relative gate, in LU below the absolute-gated mean. Stops a track's quiet
 *  passages from dragging the integrated figure down. */
const RELATIVE_GATE_LU = -10;

/**
 * Per-channel weights G_i from BS.1770. Surround channels count for more;
 * the first three are unity, so stereo and mono are unaffected. Present for
 * spec fidelity rather than because this app feeds it surround.
 */
const CHANNEL_WEIGHTS = [1.0, 1.0, 1.0, 1.41, 1.41];

/** Exported so the worklet tap can hand the same weights to the audio
 *  thread rather than keeping a second copy of the table. */
export function channelWeight(index: number): number {
  return CHANNEL_WEIGHTS[index] ?? 1.0;
}

/** Mean square, weighted and summed across channels, to LUFS. */
function toLufs(weightedMeanSquare: number): number {
  if (weightedMeanSquare <= 0) return -Infinity;
  return LOUDNESS_OFFSET_DB + 10 * Math.log10(weightedMeanSquare);
}

// ── Meter ────────────────────────────────────────────────────────────────

export interface LoudnessMeter {
  /** Feed one block of samples, one Float32Array per channel, all equal
   *  length. Safe to call with whatever block size the graph produces. */
  push(channels: Float32Array[]): void;
  /** EBU R128 short-term loudness: the last 3 seconds, ungated. -Infinity
   *  until that much audio has arrived. */
  shortTermLufs(): number;
  /** BS.1770 integrated loudness over everything pushed since the last
   *  reset, with both gates applied. -Infinity if nothing passed the gates. */
  integratedLufs(): number;
  /** Drop all history and filter state. Call between the two sides of an A/B
   *  or the second measurement inherits the first one's tail. */
  reset(): void;
}

/**
 * The gating half of the meter, fed one completed 100 ms quarter at a time.
 *
 * Split out because the K-weighting has to happen on the audio thread — an
 * AnalyserNode hands back 1024 samples every 100 ms, which is a ~21% duty
 * cycle with discontinuous filter state, and you cannot build contiguous
 * 400 ms gating blocks out of disjoint snippets. So the worklet filters and
 * squares, posts one number per quarter, and everything below stays here:
 * the gating needs every block before it can apply the relative threshold,
 * which is a main-thread concern anyway.
 *
 * `createLoudnessMeter` is this plus the filtering, so there is exactly one
 * implementation of the gating.
 */
export interface QuarterMeter {
  /** One completed quarter: the K-weighted sum of squares, already summed
   *  across channels with G_i applied, and how many frames produced it. */
  pushQuarter(weightedSumSquares: number, frames: number): void;
  shortTermLufs(): number;
  integratedLufs(): number;
  reset(): void;
}

export function createQuarterMeter(): QuarterMeter {
  /** Weighted sum of squares per completed quarter, and the frame count that
   *  produced each — kept in step so a short final quarter can't skew a mean. */
  let quarters: number[] = [];
  let quarterFrames: number[] = [];
  /** Weighted mean square per 400 ms block, one per 100 ms step. Kept rather
   *  than reduced on the fly because the relative gate can't be applied until
   *  every block is in — it's a threshold derived from their mean. */
  let blocks: number[] = [];

  function windowMeanSquare(count: number): number {
    let sum = 0;
    let frames = 0;
    for (let i = quarters.length - count; i < quarters.length; i++) {
      sum += quarters[i];
      frames += quarterFrames[i];
    }
    return frames === 0 ? 0 : sum / frames;
  }

  return {
    pushQuarter(weightedSumSquares: number, frames: number): void {
      quarters.push(weightedSumSquares);
      quarterFrames.push(frames);
      if (quarters.length < QUARTERS_PER_BLOCK) return;
      blocks.push(windowMeanSquare(QUARTERS_PER_BLOCK));
    },

    shortTermLufs(): number {
      if (quarters.length < QUARTERS_PER_SHORT_TERM) return -Infinity;
      return toLufs(windowMeanSquare(QUARTERS_PER_SHORT_TERM));
    },

    integratedLufs(): number {
      if (blocks.length === 0) return -Infinity;

      // Pass one: drop silence, then take the mean of what's left.
      let absSum = 0;
      let absCount = 0;
      for (const z of blocks) {
        if (toLufs(z) > ABSOLUTE_GATE_LUFS) {
          absSum += z;
          absCount++;
        }
      }
      if (absCount === 0) return -Infinity;

      // Pass two: the relative threshold is 10 LU below that mean.
      const relativeGate = toLufs(absSum / absCount) + RELATIVE_GATE_LU;
      let sum = 0;
      let count = 0;
      for (const z of blocks) {
        const l = toLufs(z);
        if (l > ABSOLUTE_GATE_LUFS && l > relativeGate) {
          sum += z;
          count++;
        }
      }
      if (count === 0) return -Infinity;
      return toLufs(sum / count);
    },

    reset(): void {
      quarters = [];
      quarterFrames = [];
      blocks = [];
    },
  };
}

export function createLoudnessMeter(sampleRate: number, channelCount: number): LoudnessMeter {
  const stages = kWeightingStages(sampleRate);
  const quarterSamples = Math.round((sampleRate * QUARTER_DURATION_MS) / 1000);
  const gate = createQuarterMeter();

  let shelfState: BiquadState[] = [];
  let hpState: BiquadState[] = [];
  let quarterAccum = 0;
  let quarterFill = 0;

  function reset(): void {
    shelfState = [];
    hpState = [];
    for (let c = 0; c < channelCount; c++) {
      shelfState.push(newState());
      hpState.push(newState());
    }
    gate.reset();
    quarterAccum = 0;
    quarterFill = 0;
  }

  reset();

  return {
    push(channels: Float32Array[]): void {
      const frames = channels[0]?.length ?? 0;
      for (let n = 0; n < frames; n++) {
        let weighted = 0;
        for (let c = 0; c < channels.length; c++) {
          const y = step(stages[1], hpState[c], step(stages[0], shelfState[c], channels[c][n]));
          weighted += channelWeight(c) * y * y;
        }
        quarterAccum += weighted;
        if (++quarterFill === quarterSamples) {
          gate.pushQuarter(quarterAccum, quarterSamples);
          quarterAccum = 0;
          quarterFill = 0;
        }
      }
    },

    shortTermLufs: () => gate.shortTermLufs(),
    integratedLufs: () => gate.integratedLufs(),
    reset,
  };
}

/**
 * Integrated loudness of audio you already have in full. The offline path for
 * A/B level matching, where both sides are rendered before either is heard.
 */
export function measureIntegratedLufs(channels: Float32Array[], sampleRate: number): number {
  const meter = createLoudnessMeter(sampleRate, channels.length);
  meter.push(channels);
  return meter.integratedLufs();
}

/**
 * Gain to apply to `measuredLufs` to land it on `targetLufs`. The whole point
 * of measuring: an A/B is only honest if both sides go out at the same
 * loudness, so the listener is judging tone and not level.
 */
export function matchGainDb(measuredLufs: number, targetLufs: number): number {
  if (!Number.isFinite(measuredLufs)) return 0;
  return targetLufs - measuredLufs;
}

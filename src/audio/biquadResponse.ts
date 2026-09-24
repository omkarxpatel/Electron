/**
 * Analytical magnitude response for the biquad filters that make up our
 * graphic EQ. Formulas come directly from Robert Bristow-Johnson's
 * "Audio EQ Cookbook" — the same math the Web Audio BiquadFilterNode uses
 * internally. We compute this in pure JS so the EQ response curve can be
 * drawn even when no audio device is connected.
 */

const DEFAULT_SAMPLE_RATE = 48000;
const SHELF_SLOPE = 1; // matches Web Audio's default low/high-shelf slope

interface BiquadCoefs {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

function peakingCoefs(fc: number, Q: number, gainDb: number, sampleRate: number): BiquadCoefs {
  const A = Math.pow(10, gainDb / 40);
  const w0 = (2 * Math.PI * fc) / sampleRate;
  const cosw = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * Q);

  const a0 = 1 + alpha / A;
  return {
    b0: (1 + alpha * A) / a0,
    b1: (-2 * cosw) / a0,
    b2: (1 - alpha * A) / a0,
    a1: (-2 * cosw) / a0,
    a2: (1 - alpha / A) / a0,
  };
}

function lowShelfCoefs(fc: number, gainDb: number, sampleRate: number): BiquadCoefs {
  const A = Math.pow(10, gainDb / 40);
  const w0 = (2 * Math.PI * fc) / sampleRate;
  const cosw = Math.cos(w0);
  const sinw = Math.sin(w0);
  const S = SHELF_SLOPE;
  const alpha = (sinw / 2) * Math.sqrt((A + 1 / A) * (1 / S - 1) + 2);
  const twoSqrtAalpha = 2 * Math.sqrt(A) * alpha;

  const a0 = (A + 1) + (A - 1) * cosw + twoSqrtAalpha;
  return {
    b0: (A * ((A + 1) - (A - 1) * cosw + twoSqrtAalpha)) / a0,
    b1: (2 * A * ((A - 1) - (A + 1) * cosw)) / a0,
    b2: (A * ((A + 1) - (A - 1) * cosw - twoSqrtAalpha)) / a0,
    a1: (-2 * ((A - 1) + (A + 1) * cosw)) / a0,
    a2: ((A + 1) + (A - 1) * cosw - twoSqrtAalpha) / a0,
  };
}

function highShelfCoefs(fc: number, gainDb: number, sampleRate: number): BiquadCoefs {
  const A = Math.pow(10, gainDb / 40);
  const w0 = (2 * Math.PI * fc) / sampleRate;
  const cosw = Math.cos(w0);
  const sinw = Math.sin(w0);
  const S = SHELF_SLOPE;
  const alpha = (sinw / 2) * Math.sqrt((A + 1 / A) * (1 / S - 1) + 2);
  const twoSqrtAalpha = 2 * Math.sqrt(A) * alpha;

  const a0 = (A + 1) - (A - 1) * cosw + twoSqrtAalpha;
  return {
    b0: (A * ((A + 1) + (A - 1) * cosw + twoSqrtAalpha)) / a0,
    b1: (-2 * A * ((A - 1) + (A + 1) * cosw)) / a0,
    b2: (A * ((A + 1) + (A - 1) * cosw - twoSqrtAalpha)) / a0,
    a1: (2 * ((A - 1) - (A + 1) * cosw)) / a0,
    a2: ((A + 1) - (A - 1) * cosw - twoSqrtAalpha) / a0,
  };
}

function magnitudeDb(coefs: BiquadCoefs, f: number, sampleRate: number): number {
  const w = (2 * Math.PI * f) / sampleRate;
  const cosw = Math.cos(w);
  const cos2w = Math.cos(2 * w);
  const { b0, b1, b2, a1, a2 } = coefs;

  const num =
    b0 * b0 + b1 * b1 + b2 * b2 +
    2 * (b0 * b1 + b1 * b2) * cosw +
    2 * b0 * b2 * cos2w;
  const den =
    1 + a1 * a1 + a2 * a2 +
    2 * (a1 + a1 * a2) * cosw +
    2 * a2 * cos2w;

  if (den <= 0) return -Infinity;
  return 10 * Math.log10(num / den);
}

/**
 * Combined dB response of the EQ chain at one frequency.
 * First band = low shelf, last band = high shelf, the rest are peaking.
 *
 * Note: this is the per-call variant. The EQ response curve renders 320
 * sample frequencies × up to 31 bands and was rebuilding biquad coefficients
 * on every sample (~10k peakingCoefs calls per draw). The faster path is
 * `buildBandCoefs` + `responseCurveDb` below — build the coefficient array
 * once per parameter change, then evaluate `magnitudeDb` per sample frequency.
 */
export function combinedResponseDb(
  freq: number,
  bands: number[],
  bandFreqs: number[],
  Q: number,
  preampDb: number,
  enhancerBassDb = 0,
  enhancerTrebleDb = 0,
  sampleRate: number = DEFAULT_SAMPLE_RATE,
): number {
  let total = preampDb;
  for (let i = 0; i < bands.length; i++) {
    const fc = bandFreqs[i];
    const gainDb = bands[i];
    if (gainDb === 0 && i !== 0 && i !== bands.length - 1) continue;
    let coefs: BiquadCoefs;
    if (i === 0) coefs = lowShelfCoefs(fc, gainDb, sampleRate);
    else if (i === bands.length - 1) coefs = highShelfCoefs(fc, gainDb, sampleRate);
    else coefs = peakingCoefs(fc, Q, gainDb, sampleRate);
    total += magnitudeDb(coefs, freq, sampleRate);
  }
  // Enhancer shelves (separate from the EQ — they always have their fixed center freqs)
  if (enhancerBassDb !== 0) {
    total += magnitudeDb(lowShelfCoefs(80, enhancerBassDb, sampleRate), freq, sampleRate);
  }
  if (enhancerTrebleDb !== 0) {
    total += magnitudeDb(highShelfCoefs(10000, enhancerTrebleDb, sampleRate), freq, sampleRate);
  }
  return total;
}

/** Precomputed biquad coefficients for an EQ-state snapshot. The flag
 *  `nonZero` lets the per-sample loop skip pass-through bands entirely
 *  without re-checking the gain each call. */
interface BandCoefEntry {
  coefs: BiquadCoefs;
  nonZero: boolean;
}

export interface BandCoefSet {
  bandCoefs: BandCoefEntry[];
  bassEnhCoefs: BandCoefEntry | null;
  trebleEnhCoefs: BandCoefEntry | null;
  midEnhCoefs: BandCoefEntry | null;
  preampDb: number;
}

/**
 * Build the coefficient set for an entire EQ-state snapshot. Call this once
 * per `(bands, bandFreqs, Q, preamp, enhancer{Bass,Treble})` change; reuse
 * the result for every sample frequency in the curve.
 */
export function buildBandCoefs(
  bands: number[],
  bandFreqs: number[],
  Q: number,
  preampDb: number,
  enhancerBassDb = 0,
  enhancerTrebleDb = 0,
  /** Enhancer mid knob — peaking, 1 kHz, Q 1. Defaults to 0 so the existing
   *  curve-display caller is unaffected; the audio-engine auto-trim passes
   *  it so all three enhancer knobs are accounted for. */
  enhancerMidDb = 0,
  sampleRate: number = DEFAULT_SAMPLE_RATE,
): BandCoefSet {
  const bandCoefs: BandCoefEntry[] = new Array(bands.length);
  for (let i = 0; i < bands.length; i++) {
    const fc = bandFreqs[i];
    const gainDb = bands[i];
    const isShelf = i === 0 || i === bands.length - 1;
    // Peaking bands at 0 dB are mathematical pass-throughs; we still build
    // a coef for shelves at 0 dB because the math has tiny but real behavior
    // at the band edges (and old combinedResponseDb did too).
    const nonZero = gainDb !== 0 || isShelf;
    let coefs: BiquadCoefs;
    if (i === 0) coefs = lowShelfCoefs(fc, gainDb, sampleRate);
    else if (i === bands.length - 1) coefs = highShelfCoefs(fc, gainDb, sampleRate);
    else coefs = peakingCoefs(fc, Q, gainDb, sampleRate);
    bandCoefs[i] = { coefs, nonZero };
  }
  const bassEnhCoefs =
    enhancerBassDb !== 0
      ? { coefs: lowShelfCoefs(80, enhancerBassDb, sampleRate), nonZero: true }
      : null;
  const trebleEnhCoefs =
    enhancerTrebleDb !== 0
      ? { coefs: highShelfCoefs(10000, enhancerTrebleDb, sampleRate), nonZero: true }
      : null;
  const midEnhCoefs =
    enhancerMidDb !== 0
      ? { coefs: peakingCoefs(1000, 1, enhancerMidDb, sampleRate), nonZero: true }
      : null;
  return { bandCoefs, bassEnhCoefs, trebleEnhCoefs, midEnhCoefs, preampDb };
}

/** Evaluate the response curve at one sample frequency using a precomputed
 *  coefficient set. ~3-4× faster than `combinedResponseDb` per sample on a
 *  31-band layout because we skip the per-call coefficient construction. */
export function responseCurveDb(
  freq: number,
  set: BandCoefSet,
  sampleRate: number = DEFAULT_SAMPLE_RATE,
): number {
  let total = set.preampDb;
  for (let i = 0; i < set.bandCoefs.length; i++) {
    const entry = set.bandCoefs[i];
    if (!entry.nonZero) continue;
    total += magnitudeDb(entry.coefs, freq, sampleRate);
  }
  if (set.bassEnhCoefs) total += magnitudeDb(set.bassEnhCoefs.coefs, freq, sampleRate);
  if (set.trebleEnhCoefs) total += magnitudeDb(set.trebleEnhCoefs.coefs, freq, sampleRate);
  if (set.midEnhCoefs) total += magnitudeDb(set.midEnhCoefs.coefs, freq, sampleRate);
  return total;
}

/* ── Band interaction ─────────────────────────────────────────────────────
 *
 * Overlapping biquads sum. At 10 bands, Q 1.41 is exactly 1-octave bandwidth
 * on 1-octave spacing, so each band's neighbours contribute about half its
 * gain at its own centre frequency — a broad +4 dB request is delivered as
 * roughly +7 dB.
 *
 * `toneSectionPeakDb` already measures this to trim headroom, but trimming
 * only fixes the LEVEL consequence. The SHAPE is still wrong: whatever curve
 * you ask for arrives exaggerated. That's fine for a slider (the user drags
 * until it sounds right, and the delivered response is what they were
 * judging) but not for the AI enhancer, which computes a specific target
 * curve and has no way to notice it overshot.
 *
 * Fix: build the interaction matrix M, where M[i][j] is the dB contributed at
 * band i's centre by a unit-gain filter on band j, then pre-invert it. Solving
 * `g = M⁻¹ · desired` yields the filter gains whose SUM is the desired curve.
 * This is the weighted-least-squares interaction-matrix approach from Välimäki
 * & Reiss, "All About Audio Equalization: Solutions and Frontiers", reduced to
 * a single non-iterative solve because our band count is small and fixed.
 *
 * Applied to the AI path only. The manual sliders are deliberately left
 * uncompensated — every preset and saved user curve was dialled in against the
 * current (interacting) behaviour, so compensating them would silently change
 * how all of them sound.
 */

/** Gain used to probe each band's contribution. The RBJ peaking filter's
 *  bandwidth varies slightly with gain, so the matrix is only exactly right
 *  at the probe gain; 3 dB sits in the middle of the range the enhancer
 *  actually uses, which is where the linearization should be tightest. */
const INTERACTION_PROBE_DB = 3;

/** Frequencies the fit is evaluated at. Denser than the band count on
 *  purpose — see CURVE_SOLVER_RIDGE. */
const SOLVER_PROBE_FREQS = logSpacedFrequencies(96);

/**
 * Ridge term, relative to the mean diagonal of AᵀA.
 *
 * Fitting the response at band CENTRES only is underdetermined in a way that
 * bites at the two ends: band 0 and band N-1 are shelves, and a shelf's
 * response at its own corner frequency is only half its gain. Asked for
 * +3.5 dB at 32 Hz, a centres-only solve happily prescribes a +7 dB low
 * shelf — which does deliver +3.5 dB at 32 Hz, and +7 dB everywhere below
 * it. The curve is right at the one frequency being checked and wrong
 * either side of it, and the headroom trim then has to give back the whole
 * +7 dB, so the correction costs twice the level it should.
 *
 * Fitting over a dense frequency grid instead penalises that overshoot,
 * because the error at 20 Hz now counts. The ridge term keeps the solution
 * from trading huge opposing gains between neighbouring bands to chase the
 * last tenth of a dB.
 *
 * 0.02 from a sweep over realistic target curves: between ridge 0 and 0.02
 * the worst-case curve error moves 1.74 → 1.78 dB (10 bands) while the worst
 * solved gain drops 12.5 → 10.9 dB (31 bands). That matters because the
 * enhancer clamps its delta at ±12 dB — an unregularised solve can ask for
 * more than the clamp allows, and a clamped band is a curve we didn't intend.
 * Past ~0.05 the accuracy cost starts showing without buying much more.
 */
const CURVE_SOLVER_RIDGE = 0.02;

/**
 * Build the matrix that converts a desired response curve into the filter
 * gains that actually deliver it.
 *
 * Returns a row-major `bandFreqs.length × sourceFreqs.length` matrix: feed it
 * a curve sampled at `sourceFreqs` and it yields one gain per band. Both the
 * interpolation from `sourceFreqs` onto the probe grid and the least-squares
 * solve are linear, so they collapse into this single matrix — the per-tick
 * cost is one small matvec and no interpolation at all.
 *
 * Depends only on `(bandFreqs, q, sourceFreqs, sampleRate)`, so build once per
 * band layout. Returns null if the normal equations are singular, which lets
 * the caller fall back to writing the curve straight to the filters rather
 * than emitting NaN into the audio graph.
 */
export function buildCurveSolver(
  bandFreqs: number[],
  q: number,
  sourceFreqs: readonly number[],
  sampleRate: number = DEFAULT_SAMPLE_RATE,
): Float64Array | null {
  const n = bandFreqs.length;
  const s = sourceFreqs.length;
  const probes = SOLVER_PROBE_FREQS;
  const p = probes.length;

  // A[p][j] — dB at probe p from a unit-gain filter on band j.
  const a = new Float64Array(p * n);
  const probeGains = new Array<number>(n).fill(0);
  for (let j = 0; j < n; j++) {
    probeGains[j] = INTERACTION_PROBE_DB;
    const set = buildBandCoefs(probeGains, bandFreqs, q, 0, 0, 0, 0, sampleRate);
    for (let i = 0; i < p; i++) {
      a[i * n + j] = responseCurveDb(probes[i], set, sampleRate) / INTERACTION_PROBE_DB;
    }
    probeGains[j] = 0;
  }

  // T[p][k] — log-frequency interpolation from sourceFreqs onto the probe
  // grid, held flat past either end. The flat extension is what tells the
  // solve "we want this much at 20 Hz too", which is what stops the shelves
  // from overshooting below the lowest band centre.
  const t = new Float64Array(p * s);
  const logSrc = Array.from(sourceFreqs, Math.log);
  for (let i = 0; i < p; i++) {
    const lf = Math.log(probes[i]);
    if (lf <= logSrc[0]) {
      t[i * s] = 1;
      continue;
    }
    if (lf >= logSrc[s - 1]) {
      t[i * s + (s - 1)] = 1;
      continue;
    }
    let k = 0;
    while (k < s - 2 && logSrc[k + 1] < lf) k++;
    const frac = (lf - logSrc[k]) / (logSrc[k + 1] - logSrc[k]);
    t[i * s + k] = 1 - frac;
    t[i * s + k + 1] = frac;
  }

  // Normal equations: g = (AᵀA + λI)⁻¹ Aᵀ T c
  const ata = new Float64Array(n * n);
  for (let r = 0; r < n; r++) {
    for (let c = r; c < n; c++) {
      let sum = 0;
      for (let i = 0; i < p; i++) sum += a[i * n + r] * a[i * n + c];
      ata[r * n + c] = sum;
      ata[c * n + r] = sum;
    }
  }
  let diag = 0;
  for (let r = 0; r < n; r++) diag += ata[r * n + r];
  const lambda = (diag / n) * CURVE_SOLVER_RIDGE;
  for (let r = 0; r < n; r++) ata[r * n + r] += lambda;

  const inv = invertInPlace(ata, n);
  if (!inv) return null;

  // AᵀT (n×s), then premultiply by the inverse to get the final n×s map.
  const att = new Float64Array(n * s);
  for (let j = 0; j < n; j++) {
    for (let k = 0; k < s; k++) {
      let sum = 0;
      for (let i = 0; i < p; i++) sum += a[i * n + j] * t[i * s + k];
      att[j * s + k] = sum;
    }
  }
  const out = new Float64Array(n * s);
  for (let r = 0; r < n; r++) {
    for (let k = 0; k < s; k++) {
      let sum = 0;
      for (let j = 0; j < n; j++) sum += inv[r * n + j] * att[j * s + k];
      out[r * s + k] = sum;
    }
  }
  return out;
}

/** Gauss-Jordan with partial pivoting. n <= 31, so an O(n³) inverse built
 *  once per band-layout change costs nothing worth optimizing. */
function invertInPlace(m: Float64Array, n: number): Float64Array | null {
  const inv = new Float64Array(n * n);
  for (let i = 0; i < n; i++) inv[i * n + i] = 1;
  for (let col = 0; col < n; col++) {
    let pivot = col;
    let best = Math.abs(m[col * n + col]);
    for (let r = col + 1; r < n; r++) {
      const v = Math.abs(m[r * n + col]);
      if (v > best) {
        best = v;
        pivot = r;
      }
    }
    if (best < 1e-9) return null;
    if (pivot !== col) {
      for (let c = 0; c < n; c++) {
        const t1 = m[col * n + c];
        m[col * n + c] = m[pivot * n + c];
        m[pivot * n + c] = t1;
        const t2 = inv[col * n + c];
        inv[col * n + c] = inv[pivot * n + c];
        inv[pivot * n + c] = t2;
      }
    }
    const d = m[col * n + col];
    for (let c = 0; c < n; c++) {
      m[col * n + c] /= d;
      inv[col * n + c] /= d;
    }
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = m[r * n + col];
      if (f === 0) continue;
      for (let c = 0; c < n; c++) {
        m[r * n + c] -= f * m[col * n + c];
        inv[r * n + c] -= f * inv[col * n + c];
      }
    }
  }
  return inv;
}

/**
 * `out = solver · curve` — turn a desired response curve into filter gains.
 * `solver` is the row-major rows×cols matrix from `buildCurveSolver`,
 * `curve` has `cols` entries and `out` has `rows`. `out` may not alias `curve`.
 */
export function solveBandGains(
  solver: Float64Array,
  curve: ArrayLike<number>,
  out: Float64Array,
  rows: number,
  cols: number,
): void {
  for (let i = 0; i < rows; i++) {
    let sum = 0;
    for (let j = 0; j < cols; j++) sum += solver[i * cols + j] * curve[j];
    out[i] = sum;
  }
}

export function logSpacedFrequencies(count: number, minHz = 20, maxHz = 20000): number[] {
  const out = new Array<number>(count);
  const logMin = Math.log(minHz);
  const logMax = Math.log(maxHz);
  for (let i = 0; i < count; i++) {
    out[i] = Math.exp(logMin + ((logMax - logMin) * i) / (count - 1));
  }
  return out;
}

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
  return { bandCoefs, bassEnhCoefs, trebleEnhCoefs, preampDb };
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
  return total;
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

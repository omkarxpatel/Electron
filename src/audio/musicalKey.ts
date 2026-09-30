/**
 * Musical key from a spectrum, and the Camelot code DJs actually mix with.
 *
 * Spotify used to hand this over in `audio-features`; it withdrew that in
 * November 2024. We hear the audio, so we can work it out — the same way
 * every key-detection tool does: fold the spectrum into twelve pitch
 * classes, average that over the track, and ask which key's profile it
 * matches.
 *
 * Key is a long-term property, which makes it much easier than it sounds.
 * A single frame's chroma is mostly noise; a whole track's is stable enough
 * that a correlation against fixed profiles gets it right most of the time.
 *
 * No imports, on purpose: `scripts/check-enhancer.mjs` compiles this file
 * standalone and runs it under plain node. Keep it that way or it drops out
 * of the only gate this repo has.
 */

export const PITCH_CLASSES = 12;

/** Sharp spelling throughout — DJs read Camelot, and this is only a label. */
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/**
 * Chroma is only meaningful where the FFT can actually resolve a semitone.
 *
 * A semitone at 130 Hz is about 7.7 Hz wide. At 48 kHz an 8192-point FFT
 * gives 5.9 Hz bins, which just covers it; the 1024-point analysers the
 * enhancer uses give 47 Hz bins and cannot resolve a semitone below roughly
 * 800 Hz, which is most of where the harmony lives. Hence the dedicated
 * analyser — see `useAudioEngine`.
 *
 * The top bound is because high harmonics of unrelated partials pile up and
 * blur the profile without adding tonal information.
 */
export const CHROMA_MIN_HZ = 130;
export const CHROMA_MAX_HZ = 3000;

/**
 * Krumhansl-Kessler key profiles: how strongly each scale degree is
 * expected in a major and a minor key, from the probe-tone experiments in
 * Krumhansl, "Cognitive Foundations of Musical Pitch" (1990). Still the
 * standard reference profiles for this, and the minor one is why relative
 * keys don't collapse into each other — the two differ by more than a
 * rotation.
 *
 * These describe what a LISTENER hears as belonging to a key. They are not
 * what a spectrum looks like, which is the distinction HARMONIC_KERNEL below
 * exists to close.
 */
const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

/**
 * How much energy a played note leaves in the pitch classes ABOVE its own,
 * purely from its own overtones. Index is semitones above the fundamental.
 *
 * This is the correction for the one error that matters. A probe tone is a
 * single pitch; a played note is a harmonic series, and its third harmonic
 * lands an octave and a FIFTH up (and the sixth harmonic again). So a chroma
 * measured from real instruments has the fifth inflated by about a fifth of
 * the tonic's own weight — and correlating that against an overtone-free
 * profile picks the key whose tonic IS that inflated fifth. That is one step
 * clockwise on the Camelot wheel, which is exactly the error the handoff
 * warned to watch for and exactly the error that was there: across 189
 * passages of real recorded audio with published key metadata, 34% of all
 * answers were one step clockwise, against 45% correct.
 *
 * Convolving the perceptual profiles with this kernel compares like with
 * like — an overtone-laden measurement against an overtone-laden expectation
 * — and takes that same corpus to 62% correct with the +1 error down to 19%.
 *
 * Derived rather than tabulated so the model is visible: harmonic h lands
 * round(12·log2(h)) semitones up, with amplitude 1/h. 1/h is the amplitude
 * spectrum of a sawtooth, the textbook harmonic source; eight harmonics is
 * roughly what fits inside CHROMA_MIN_HZ..CHROMA_MAX_HZ for a note in the
 * middle of that band. Neither number is critical — accuracy is flat between
 * 6 and 24 harmonics and rolloffs of 0.6 to 1.2, which is why these are the
 * honest physical values rather than the corpus's argmax.
 */
const HARMONIC_COUNT = 8;
const HARMONIC_ROLLOFF = 1;

function harmonicKernel(): number[] {
  const k = new Array<number>(PITCH_CLASSES).fill(0);
  for (let h = 1; h <= HARMONIC_COUNT; h++) {
    const semitones = ((Math.round(12 * Math.log2(h)) % PITCH_CLASSES) + PITCH_CLASSES) % PITCH_CLASSES;
    k[semitones] += Math.pow(h, -HARMONIC_ROLLOFF);
  }
  let total = 0;
  for (const v of k) total += v;
  return k.map((v) => v / total);
}

/** Circular convolution: what a chroma built from harmonic instruments
 *  playing in this key should actually look like. */
function smearByHarmonics(profile: number[], kernel: number[]): number[] {
  const out = new Array<number>(PITCH_CLASSES).fill(0);
  for (let c = 0; c < PITCH_CLASSES; c++) {
    let acc = 0;
    for (let s = 0; s < PITCH_CLASSES; s++) {
      acc += profile[(c - s + PITCH_CLASSES) % PITCH_CLASSES] * kernel[s];
    }
    out[c] = acc;
  }
  return out;
}

const HARMONIC_KERNEL = harmonicKernel();
/** What `estimateKey` actually correlates against. */
const MAJOR_CHROMA = smearByHarmonics(MAJOR_PROFILE, HARMONIC_KERNEL);
const MINOR_CHROMA = smearByHarmonics(MINOR_PROFILE, HARMONIC_KERNEL);

export type KeyMode = 'major' | 'minor';

export interface MusicalKey {
  /** 0 = C, 1 = C#, … 11 = B. */
  tonic: number;
  mode: KeyMode;
  /** "8A", "11B" — the Camelot wheel position. */
  camelot: string;
  /** "F#m", "Ab" — for anyone who reads notes rather than numbers. */
  label: string;
  /**
   * How sure we are of the tonal AREA — the Camelot number — 0..1.
   *
   * Deliberately not "how sure of the key". The runner-up to any tonal
   * answer is essentially always its relative (C major vs A minor share all
   * seven notes), so a single best-vs-second margin sits near zero for all
   * real music and would report every track as a guess. Those two are the
   * same number on the wheel and mix interchangeably, so for the purpose
   * this exists for they are not a disagreement at all.
   */
  confidence: number;
  /**
   * How sure we are of major vs minor, 0..1 — the part the number doesn't
   * capture. Genuinely the harder call, and low here is normal rather than
   * a failure.
   */
  modeConfidence: number;
}

/**
 * Add one spectrum frame into a running chroma total.
 *
 * `magnitudes` is linear magnitude per FFT bin — not dB. Summing decibels
 * would weight a quiet partial the same as a loud one, which is exactly the
 * information the profile match depends on.
 */
export function accumulateChroma(
  magnitudes: Float32Array | number[],
  sampleRate: number,
  fftSize: number,
  out: Float64Array,
): void {
  const binHz = sampleRate / fftSize;
  const first = Math.max(1, Math.ceil(CHROMA_MIN_HZ / binHz));
  const last = Math.min(magnitudes.length - 1, Math.floor(CHROMA_MAX_HZ / binHz));
  for (let k = first; k <= last; k++) {
    const hz = k * binHz;
    // MIDI number, then its pitch class. 69 = A4 = 440 Hz.
    const midi = 69 + 12 * Math.log2(hz / 440);
    const pc = ((Math.round(midi) % PITCH_CLASSES) + PITCH_CLASSES) % PITCH_CLASSES;
    out[pc] += magnitudes[k];
  }
}

/** Pearson correlation. Both arrays are length 12. */
function correlate(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < PITCH_CLASSES; i++) {
    ma += a[i];
    mb += b[i];
  }
  ma /= PITCH_CLASSES;
  mb /= PITCH_CLASSES;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < PITCH_CLASSES; i++) {
    const x = a[i] - ma;
    const y = b[i] - mb;
    num += x * y;
    da += x * x;
    db += y * y;
  }
  const den = Math.sqrt(da * db);
  return den < 1e-12 ? 0 : num / den;
}

/**
 * Camelot number for a major key, by pitch class. The wheel is ordered by
 * fifths, not by semitone: 8B is C, and each step clockwise is a fifth up.
 *
 * Minor keys share their relative major's number — A minor is 8A to C
 * major's 8B — which is derived below rather than tabulated twice, because
 * two tables that must agree are two tables that can disagree.
 */
const MAJOR_CAMELOT = [8, 3, 10, 5, 12, 7, 2, 9, 4, 11, 6, 1];

export function camelotFor(tonic: number, mode: KeyMode): string {
  const pc = ((tonic % PITCH_CLASSES) + PITCH_CLASSES) % PITCH_CLASSES;
  // A minor key sits at its relative major's number; the relative major is
  // three semitones up.
  const number = mode === 'major' ? MAJOR_CAMELOT[pc] : MAJOR_CAMELOT[(pc + 3) % PITCH_CLASSES];
  return `${number}${mode === 'major' ? 'B' : 'A'}`;
}

export function keyLabel(tonic: number, mode: KeyMode): string {
  const pc = ((tonic % PITCH_CLASSES) + PITCH_CLASSES) % PITCH_CLASSES;
  return mode === 'major' ? NOTE_NAMES[pc] : `${NOTE_NAMES[pc]}m`;
}

/**
 * Best-matching key for an accumulated chroma vector, or null when there is
 * nothing to judge.
 *
 * Returning null rather than a guess matters: a track with no tonal content
 * still produces a chroma vector, and the correlation will still have a
 * maximum. Silence would otherwise be reported as C major.
 */
export function estimateKey(chroma: ArrayLike<number>): MusicalKey | null {
  let total = 0;
  for (let i = 0; i < PITCH_CLASSES; i++) {
    if (!Number.isFinite(chroma[i]) || chroma[i] < 0) return null;
    total += chroma[i];
  }
  if (total <= 0) return null;

  // Score all 24 candidates up front. The two confidences below are both
  // margins over a particular subset, so they need the whole field.
  const rotated = new Float64Array(PITCH_CLASSES);
  const scores: number[] = new Array(PITCH_CLASSES * 2);
  const indexOf = (tonic: number, mode: KeyMode): number =>
    tonic + (mode === 'major' ? 0 : PITCH_CLASSES);

  let best = -Infinity;
  let bestTonic = 0;
  let bestMode: KeyMode = 'major';

  for (const mode of ['major', 'minor'] as const) {
    const profile = mode === 'major' ? MAJOR_CHROMA : MINOR_CHROMA;
    for (let tonic = 0; tonic < PITCH_CLASSES; tonic++) {
      // Rotate the chroma so the candidate tonic sits at index 0, then
      // compare against the profile in its own frame.
      for (let i = 0; i < PITCH_CLASSES; i++) {
        rotated[i] = chroma[(tonic + i) % PITCH_CLASSES];
      }
      const r = correlate(rotated, profile);
      scores[indexOf(tonic, mode)] = r;
      if (r > best) {
        best = r;
        bestTonic = tonic;
        bestMode = mode;
      }
    }
  }

  if (!Number.isFinite(best)) return null;

  const camelot = camelotFor(bestTonic, bestMode);
  const number = camelot.slice(0, -1);

  // Best rival from a DIFFERENT position on the wheel. Same-number rivals
  // are excluded because they mix interchangeably — see `confidence`.
  let bestElsewhere = -Infinity;
  for (const mode of ['major', 'minor'] as const) {
    for (let tonic = 0; tonic < PITCH_CLASSES; tonic++) {
      if (camelotFor(tonic, mode).slice(0, -1) === number) continue;
      const r = scores[indexOf(tonic, mode)];
      if (r > bestElsewhere) bestElsewhere = r;
    }
  }

  // The relative key: same number, other mode. Three semitones apart.
  const relativeTonic =
    bestMode === 'major' ? (bestTonic + 9) % PITCH_CLASSES : (bestTonic + 3) % PITCH_CLASSES;
  const relativeMode: KeyMode = bestMode === 'major' ? 'minor' : 'major';
  const relativeScore = scores[indexOf(relativeTonic, relativeMode)];

  // Both margins are normalised by the spread of the whole field rather
  // than by a fixed number of correlation points.
  //
  // An absolute threshold cannot work here: how far apart the candidates
  // land depends entirely on how peaked the chroma is, which depends on the
  // material. A smeared chroma compresses all 24 scores together, and a
  // fixed scale then reports every track as a guess — which is exactly what
  // a hardcoded 0.15 did. Relative to the spread, "clear winner" means the
  // same thing on both.
  let lo = Infinity;
  let hi = -Infinity;
  for (const r of scores) {
    if (r < lo) lo = r;
    if (r > hi) hi = r;
  }
  const spread = hi - lo;
  const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
  const normalise = (margin: number): number =>
    spread <= 1e-9 ? 0 : clamp01(margin / (spread * 0.25));

  const confidence = normalise(best - (Number.isFinite(bestElsewhere) ? bestElsewhere : lo));
  const modeConfidence = normalise(best - (Number.isFinite(relativeScore) ? relativeScore : lo));

  return {
    tonic: bestTonic,
    mode: bestMode,
    camelot,
    label: keyLabel(bestTonic, bestMode),
    confidence,
    modeConfidence,
  };
}

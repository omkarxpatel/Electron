/**
 * Tempo from an onset envelope.
 *
 * The other half of what Spotify withdrew in November 2024. Key is a
 * long-term average and so is forgiving; tempo is the opposite — it is
 * entirely about *when* things happen, so it needs an evenly-sampled
 * envelope with honest timing.
 *
 * That is why the envelope comes off the audio thread rather than from a
 * `setInterval` reading an AnalyserNode. At 120 BPM a beat is 500 ms; a tick
 * that wanders by 20 ms under load smears the autocorrelation peak across
 * several BPM, and the renderer is already running a visualiser at 120 fps.
 * The worklet emits one envelope sample per fixed block of samples, so the
 * spacing is exact by construction. See `loudnessTap`.
 *
 * No imports, on purpose: `scripts/check-enhancer.mjs` compiles this file
 * standalone and runs it under plain node. Keep it that way or it drops out
 * of the only gate this repo has.
 */

/**
 * Range a REPORTED tempo is folded into, in BPM.
 *
 * Deliberately a 2:1 span. Tempo is only defined up to a factor of two —
 * a 140 BPM track is also, truthfully, a 70 BPM track — so the estimator
 * has to *choose* a register rather than discover one, and reporting every
 * track inside one octave makes two tracks directly comparable.
 */
export const MIN_BPM = 70;
export const MAX_BPM = 140;

/**
 * Range the GRID is searched over, which is wider than the reported range.
 *
 * These were the same number once, and that was a bug. Searching only
 * 70..140 meant the prior was the only thing separating candidates inside
 * it, and the prior's job is to pick an octave — tilting toward the middle
 * of the range is a side effect. On a 70 BPM hip hop track it handed the
 * dotted-eighth lag at 93 BPM a 1.35x head start over the actual beat.
 *
 * So the grid is found over everything music is actually played at, with no
 * prior at all, and the register is chosen afterwards. One job each.
 */
const SEARCH_MIN_BPM = 55;
const SEARCH_MAX_BPM = 220;

/**
 * How many beats of the bar the comb spans.
 *
 * The change that fixed the dominant tempo error. Autocorrelation at a
 * single lag cannot tell a beat from a recurring dotted figure, because both
 * repeat — and hip hop is full of dotted eighths, so the misses clustered
 * hard at 4/3 and 2/3 of the truth. What separates them is whether the lag's
 * MULTIPLES line up too: a beat divides the bar, a dotted eighth does not.
 * Four is one bar in 4/4, which is the structure being relied on.
 *
 * Later multiples are averaged over less overlap and suffer more from any
 * drift, so they are weighted down by m^-0.5 rather than counted equally.
 */
const COMB_BEATS = 4;
const COMB_FALLOFF = 0.5;

/**
 * Step between candidate lags, in envelope samples.
 *
 * Candidates are fractional, which matters more than it sounds. At 174 BPM a
 * beat is 32.3 samples; testing only whole lags means the fourth tooth of the
 * comb sits at 128 while the beat is at 129.3, so the comb MISSES its own
 * peak and the estimator prefers a lag three times too long, where the
 * rounding happens to line up. That read a 174 BPM track as 116 rather than
 * 87. A tenth of a sample keeps every tooth inside the peak it is aiming at
 * and costs about eight hundred candidates, evaluated twice a second.
 */
const LAG_STEP = 0.1;

/**
 * How close to the best score a SHORTER lag has to come to win instead.
 *
 * The comb cannot prefer a beat to three beats on its own, and this is not a
 * tuning detail — it is structural. If a signal repeats every L, it repeats
 * exactly as well every 2L and 3L, and a comb over four teeth scores all of
 * them identically. Whichever wins is then decided by noise. A 174 BPM
 * pattern came out as 58, doubled to 116, on exactly this.
 *
 * So among lags that explain the signal about equally well, take the
 * shortest — the fundamental, not one of its multiples. This is the same
 * rule YIN uses to stop a pitch detector reporting octaves down, for the
 * same reason. Ninety per cent is loose enough that a slightly noisy
 * fundamental still beats its cleaner multiple, and tight enough that a lag
 * which genuinely explains less does not win on brevity alone.
 */
const FUNDAMENTAL_MARGIN = 0.9;

/**
 * Lag ratios that are the same beat in a different register, or an ordinary
 * subdivision of it. Excluded when looking for a RIVAL reading, because
 * counting half-time as a disagreement would report every clear track as a
 * guess — they are the same answer folded differently.
 */
const METRICAL_RATIOS = [0.25, 1 / 3, 0.5, 2 / 3, 1, 1.5, 2, 3, 4];
const METRICAL_TOLERANCE_OCTAVES = 0.08;

/**
 * Centre of the tempo prior, and how wide it is in octaves.
 *
 * Now used for one thing only: choosing which octave to report a tempo in.
 * Autocorrelation peaks just as hard at half and double the true tempo, and
 * nothing in the signal resolves that — the preference is a listener's, not
 * the audio's, so it belongs in an explicit prior rather than hidden in a
 * peak-picking heuristic.
 */
export const PRIOR_CENTRE_BPM = 115;
const PRIOR_WIDTH_OCTAVES = 0.9;

export interface TempoEstimate {
  bpm: number;
  /**
   * How much the winning period stands out from the rest of the
   * autocorrelation, 0..1. Comparative, not calibrated — like the key
   * confidence, it ranks readings against each other rather than stating a
   * probability.
   */
  confidence: number;
}

/**
 * Estimate tempo from an evenly-sampled onset envelope.
 *
 * `envelopeHz` is how many samples per second `onsets` holds. Returns null
 * when there is not enough signal, or not enough of it, to say anything —
 * a silent or arrhythmic passage should produce no answer rather than a
 * confident wrong one.
 */
export function estimateTempo(
  onsets: ArrayLike<number>,
  envelopeHz: number,
): TempoEstimate | null {
  const n = onsets.length;
  if (n < 8 || envelopeHz <= 0) return null;

  const minLag = Math.max(2, Math.floor((envelopeHz * 60) / SEARCH_MAX_BPM));
  const maxLag = Math.ceil((envelopeHz * 60) / SEARCH_MIN_BPM);
  // Autocorrelation at lag L is only meaningful with several periods to
  // average over; one or two would be fitting noise.
  if (maxLag < 2 || n < maxLag * 2) return null;

  // Remove the mean so the autocorrelation measures periodicity rather than
  // overall level — a loud passage would otherwise correlate strongly with
  // itself at every lag.
  let mean = 0;
  for (let i = 0; i < n; i++) mean += onsets[i];
  mean /= n;

  const centred = new Float64Array(n);
  let energy = 0;
  for (let i = 0; i < n; i++) {
    const v = onsets[i] - mean;
    centred[i] = v;
    energy += v * v;
  }
  if (energy <= 1e-12) return null;

  // The comb reaches COMB_BEATS times the longest candidate lag, so the
  // autocorrelation has to be computed that far out.
  const acfLength = Math.min(maxLag * COMB_BEATS, n - 1);
  const acf = new Float64Array(acfLength + 1);
  for (let lag = 0; lag <= acfLength; lag++) {
    const overlap = n - lag;
    if (overlap <= 0) break;
    let acc = 0;
    for (let i = 0; i < overlap; i++) acc += centred[i] * centred[i + lag];
    // Normalise by overlap, or long lags are penalised purely for having
    // fewer terms and the estimate drifts fast.
    acf[lag] = acc / overlap;
  }

  // The autocorrelation is a sampled function; read between its samples
  // rather than rounding to them.
  const acfAt = (at: number): number => {
    if (at <= 0 || at >= acfLength) return 0;
    const i = Math.floor(at);
    const frac = at - i;
    return acf[i] * (1 - frac) + acf[i + 1] * frac;
  };

  const combAt = (lag: number): number => {
    let acc = 0;
    let weight = 0;
    for (let m = 1; m <= COMB_BEATS; m++) {
      const at = m * lag;
      if (at > acfLength) break;
      const w = Math.pow(m, -COMB_FALLOFF);
      acc += w * acfAt(at);
      weight += w;
    }
    return weight > 0 ? acc / weight : 0;
  };

  const steps = Math.floor((maxLag - minLag) / LAG_STEP);
  const scores = new Float64Array(steps + 1);
  let best = -Infinity;
  let bestIndex = -1;

  for (let i = 0; i <= steps; i++) {
    const score = combAt(minLag + i * LAG_STEP);
    scores[i] = score;
    if (score > best) {
      best = score;
      bestIndex = i;
    }
  }

  if (bestIndex < 0 || best <= 0) return null;

  // Prefer the fundamental: the first peak that comes close enough to the
  // best score, scanning from the shortest lag up. Requiring a local maximum
  // keeps this from stopping on the shoulder of the peak it is looking for.
  const floorScore = best * FUNDAMENTAL_MARGIN;
  for (let i = 1; i < steps; i++) {
    if (scores[i] < floorScore) continue;
    if (scores[i] < scores[i - 1] || scores[i] < scores[i + 1]) continue;
    bestIndex = i;
    break;
  }

  const refined = minLag + bestIndex * LAG_STEP;
  const gridBpm = (envelopeHz * 60) / refined;

  // Register. The grid above says how fast the music moves; this says which
  // octave to call it, and it is the only thing the prior decides.
  let bpm = foldTempo(gridBpm);
  let bestPrior = -1;
  for (const factor of [0.25, 0.5, 1, 2, 4]) {
    const candidate = gridBpm * factor;
    if (candidate < MIN_BPM || candidate > MAX_BPM) continue;
    const p = tempoPrior(candidate);
    if (p > bestPrior) {
      bestPrior = p;
      bpm = candidate;
    }
  }

  // Confidence is the margin over the best UNRELATED reading, not over the
  // average of the field. Peak-versus-mean was measured to carry no
  // information at all on real audio — right and wrong answers both averaged
  // 0.44 — because a peaky autocorrelation says the signal is rhythmic, not
  // that the right period won. Against an unrelated rival it separates:
  // readings above 0.5 were right 86% of the time, above 0.7 all of them.
  let rival = -Infinity;
  for (let i = 0; i <= steps; i++) {
    if (isMetricalRelative((minLag + i * LAG_STEP) / refined)) continue;
    if (scores[i] > rival) rival = scores[i];
  }
  const confidence =
    rival > 0 ? clamp01(1 - rival / best) : Number.isFinite(rival) ? 1 : 0;

  return { bpm, confidence };
}

/** Is this lag ratio the same beat counted differently — half time, double
 *  time, a triplet — rather than a genuinely different reading? */
function isMetricalRelative(ratio: number): boolean {
  if (!(ratio > 0)) return false;
  for (const r of METRICAL_RATIOS) {
    if (Math.abs(Math.log2(ratio / r)) < METRICAL_TOLERANCE_OCTAVES) return true;
  }
  return false;
}

/**
 * Weight for a candidate tempo: a log-normal bump around PRIOR_CENTRE_BPM.
 *
 * Log-normal rather than normal because tempo is perceived multiplicatively
 * — 60→120 and 120→240 are the same musical distance — so the prior has to
 * be symmetric in octaves, not in BPM.
 */
export function tempoPrior(bpm: number): number {
  if (bpm <= 0) return 0;
  const octaves = Math.log2(bpm / PRIOR_CENTRE_BPM) / PRIOR_WIDTH_OCTAVES;
  return Math.exp(-0.5 * octaves * octaves);
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * Fold a tempo into the search range by halving or doubling.
 *
 * Useful when comparing a stored tempo against a newly measured one, or two
 * tracks against each other: 75 and 150 are the same tempo for mixing
 * purposes, and comparing them numerically would say they are 75 apart.
 */
export function foldTempo(bpm: number): number {
  if (!Number.isFinite(bpm) || bpm <= 0) return bpm;
  let out = bpm;
  while (out < MIN_BPM) out *= 2;
  while (out > MAX_BPM) out /= 2;
  return out;
}

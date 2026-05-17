import { useEffect, useRef } from 'react';
import { frequenciesFor, type BandCount } from '../state/eq';

/**
 * AI Enhancer — real-time adaptive graphic EQ.
 *
 * Design follows the spec produced by the architect agent. Per-tick (10 Hz) flow:
 *
 *   1. Pull L + R FFT, average to mono (magM) — mono is what we balance against.
 *   2. Aggregate FFT bins into 10 ISO log-spaced band magnitudes in dBFS.
 *   3. Time-smooth (EMA, τ=1.5s) → bandDbEma.
 *   4. Spectral-balance correction: compare bandDbEma (mean-normalized) to a
 *      pink-noise target curve (-3 dB/oct from 1 kHz). Apply 35 % of the
 *      deviation, clamped to ±3 dB per band.
 *   5. Compute features (centroid, bassRatio, onset density via spectral flux,
 *      crest, flatness). Pick a character mode via decision tree with 2 s dwell.
 *   6. Vocal detection: mid-band stereo correlation + vocal-band energy ratio
 *      + formant-region gate. Hysteretic.
 *   7. Loudness compensation (Fletcher–Munson): engaged below -25 dBFS RMS,
 *      full at -50 dBFS via smoothstep. U-shape curve favouring extremes.
 *   8. Sum components → clamp ±6 dB → user-override gate → slew-limit
 *      (3 dB/s for bass, 6 dB/s elsewhere) → write delta to ref.
 *
 * The hook DOESN'T touch BiquadFilter directly — it writes per-band delta dB
 * values into a ref. The audio engine reads that ref each frame and adds it
 * to the user's baseline before pushing to the filter. This keeps user EQ
 * and auto-corrections separable.
 */

const ISO_10 = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000] as const;

/** Pink-noise (-3 dB/oct from 1 kHz) target. Sub clamped to +14.3 to avoid
 *  chasing subsonic that's not musically intended. */
const PINK_TARGET_10 = [14.3, 12.0, 9.0, 6.0, 3.0, 0.0, -3.0, -6.0, -9.0, -12.0];

type Mode = 'bass' | 'rhythmic' | 'vocal' | 'instrumental' | 'dense';

/** Per-mode 10-band dB profiles applied at full mode-confidence. */
const MODE_PROFILES: Record<Mode, number[]> = {
  bass:         [+0.5, +1.0, +0.5, -1.5, -1.0,  0.0, +0.5, +1.0, +1.5, +1.0],
  rhythmic:     [-1.0, -0.5, -1.5, -0.5,  0.0,  0.0, +0.5, +1.5, +2.5, +2.0],
  vocal:        [-0.5,  0.0,  0.0, -1.0, +0.5, +1.5, +2.5, +1.5, +0.5,  0.0],
  instrumental: [+1.5, +1.5, +1.0,  0.0, -0.5, -0.5,  0.0, +0.5, +1.5, +2.0],
  dense:        [+0.5, +0.5,  0.0, -0.5, -0.5,  0.0, +0.5, +0.5, +1.0, +0.5],
};

/** Vocal presence boost (multiplied by 0..1 vocal score). */
const VOCAL_PROFILE = [0, 0, 0, -0.5, +0.8, +1.5, +2.5, +1.5, +0.5, 0];

/** Loudness compensation at full engagement (low SPL listening). U-shaped. */
const LOUDNESS_PROFILE = [+6.0, +4.5, +3.0, +1.5, +0.5, 0.0, -0.5, 0.0, +1.5, +3.5];

const TICK_HZ = 10;
const DT = 1 / TICK_HZ;
const EMA_TAU_S = 1.5;
const EMA_ALPHA = 1 - Math.exp(-DT / EMA_TAU_S);
const CORRECTION_STRENGTH = 0.55;
const CORRECTION_CEILING = 4.0;
/** Max per-band delta. Set to the slider's full range so the AI can fully
 *  recover from any baseline position (12 dB span at 6 dB/s slew = 2 s to
 *  fully reach target from an extreme). The slew rate and override gate
 *  still keep motion smooth and non-violent. */
const TOTAL_CEILING = 12.0;
const SLEW_BASS = 3.0;   // dB/s for the first 3 bands (≤125 Hz)
const SLEW_OTHER = 6.0;
const MODE_DWELL_S = 2.0;
const USER_OVERRIDE_HOLD_S = 4.0;
const USER_OVERRIDE_FADE_OUT_S = 0.15;
const USER_OVERRIDE_FADE_IN_S = 3.0;
const VOCAL_ENTER_R = 0.55;
const VOCAL_RELEASE_R = 0.40;
const VOCAL_RATIO_ENTER = 0.30;
const VOCAL_RATIO_RELEASE = 0.22;
const VOCAL_FORMANT_GATE = 0.25;
const VOCAL_ENTER_DWELL_S = 0.8;
const VOCAL_EXIT_DWELL_S = 0.3;
const LOUDNESS_LOW_DB = -50;
const LOUDNESS_HIGH_DB = -25;
const SET_TARGET_TAU = 0.080;

interface Params {
  analyserL: AnalyserNode | null;
  analyserR: AnalyserNode | null;
  enabled: boolean;
  bandCount: BandCount;
  locked: boolean[];
  /** External ref the engine writes its per-band delta into. App.tsx owns
   *  this ref so it can pass the same instance into useAudioEngine. Length
   *  must equal bandCount; this hook resizes it when bandCount changes. */
  deltaRef: { current: number[] };
  /** User's manual baseline values (length === bandCount). The AI targets
   *  an absolute effective position; delta = target − baseline. Passed as a
   *  ref-y object so it can update at any frequency without re-triggering
   *  the engine effect. */
  baselineRef: { current: number[] };
  /** ISO center frequencies for the user's active band layout. Used to
   *  interpolate between the AI's 10-band internal vector and bandCount. */
  bandFreqs: number[];
  /** Called every tick with the current delta array AND a "just nudged"
   *  flag per band. Lets the parent mirror the delta into React state
   *  (for slider visualization) and flash bands recently moved by > 0.05 dB. */
  onTick?: (deltas: number[], flashed: boolean[]) => void;
}

export interface AiEnhancerHandle {
  /** Time-constant to pass to setTargetAtTime when the engine applies the
   *  delta to a biquad. */
  setTargetTau: number;
  /** Call from the EqPanel slider's onChange so the AI pauses on that band. */
  noteUserTouch: (bandIndex: number) => void;
}

export function useAiEnhancer({
  analyserL,
  analyserR,
  enabled,
  bandCount,
  locked,
  deltaRef,
  baselineRef,
  bandFreqs,
  onTick,
}: Params): AiEnhancerHandle {
  const lastUserTouchRef = useRef<number[]>(new Array(bandCount).fill(0));
  // Mirror dynamic inputs into refs so the tick effect doesn't tear down
  // on every render. (Without this, an inline `onTick` arrow or a fresh
  // `locked` array kills the engine before it can produce useful state.)
  const lockedRef = useRef<boolean[]>(locked);
  lockedRef.current = locked;
  const onTickRef = useRef<typeof onTick>(onTick);
  onTickRef.current = onTick;

  /* Resize the delta buffer whenever band count changes. We mutate in place
   * rather than reassign so the audio engine (which captured the ref by
   * reference) keeps reading the right array. */
  useEffect(() => {
    const arr = deltaRef.current;
    if (arr.length < bandCount) while (arr.length < bandCount) arr.push(0);
    else if (arr.length > bandCount) arr.length = bandCount;
    for (let i = 0; i < arr.length; i++) arr[i] = 0;
    if (lastUserTouchRef.current.length !== bandCount) {
      lastUserTouchRef.current = new Array(bandCount).fill(0);
    }
  }, [bandCount, deltaRef]);

  const noteUserTouch = (bandIndex: number): void => {
    lastUserTouchRef.current[bandIndex] = performance.now();
  };

  useEffect(() => {
    if (!enabled || !analyserL || !analyserR) {
      // Engine off → zero out deltas in place AND notify the parent so its
      // React state mirror clears. Without the notify, the EqPanel would
      // keep displaying `baseline + stale_delta` (the slider wouldn't move
      // back to baseline) until the engine starts again.
      const arr = deltaRef.current;
      for (let i = 0; i < arr.length; i++) arr[i] = 0;
      onTickRef.current?.(arr.slice(), new Array(arr.length).fill(false));
      return;
    }

    const binsL = new Uint8Array(analyserL.frequencyBinCount);
    const binsR = new Uint8Array(analyserR.frequencyBinCount);
    const binsM = new Float32Array(analyserL.frequencyBinCount);
    const time = new Uint8Array(analyserL.fftSize);
    const sampleRate = analyserL.context.sampleRate;
    const fftSize = analyserL.fftSize;

    // Persistent state across ticks.
    const bandDbEma = new Array(10).fill(-60);
    const prevSpectrum = new Float32Array(binsM.length);
    const onsetTimes: number[] = [];
    let currentMode: Mode = 'dense';
    let candidateMode: Mode = 'dense';
    let modeCandidateAcc = 0;
    let vocalScoreSm = 0;
    let vocalAbove = 0;       // accumulated time above enter threshold
    let vocalBelow = 0;       // accumulated time in release
    let vocalActive = false;
    const targetFreqs = bandFreqs.length === bandCount ? bandFreqs : frequenciesFor(bandCount);
    const iso10List = ISO_10 as readonly number[] as number[];

    // ─── Preallocated scratch buffers — created once per engine lifetime
    // and reused on every tick. At 10 Hz this eliminates ~7 array allocations
    // per second (×4–31 elements each), removing a meaningful GC contributor.
    const bandDbInst = new Float64Array(10);
    const correction10 = new Float64Array(10);
    const idealShape10 = new Float64Array(10);
    const desiredDelta10 = new Float64Array(10);
    const baseline10Buf = new Float64Array(10);
    const flashedBuf: boolean[] = new Array(bandCount).fill(false);
    const deltaSnapshotBuf: number[] = new Array(bandCount).fill(0);
    // Precompute per-band classifications (isBass) and ISO/target log lookup —
    // these are stable for the engine lifetime.
    const isBassFlags = new Uint8Array(bandCount);
    for (let i = 0; i < bandCount; i++) isBassFlags[i] = isBassBand(targetFreqs[i]) ? 1 : 0;
    // Cache the kLo/kHi FFT-bin range per ISO band (10 entries × 2 ints) —
    // these depend only on sampleRate + bin count, both stable.
    const isoBinRanges = new Int32Array(20);
    for (let i = 0; i < 10; i++) {
      const center = ISO_10[i];
      const lo = center * Math.pow(2, -0.5);
      const hi = center * Math.pow(2, 0.5);
      const kLo = Math.max(1, Math.floor((lo / (sampleRate / 2)) * binsM.length));
      const kHi = Math.max(kLo + 1, Math.min(binsM.length, Math.ceil((hi / (sampleRate / 2)) * binsM.length)));
      isoBinRanges[i * 2] = kLo;
      isoBinRanges[i * 2 + 1] = kHi;
    }

    let ticking = true;

    const tick = (): void => {
      if (!ticking) return;

      analyserL.getByteFrequencyData(binsL);
      analyserR.getByteFrequencyData(binsR);
      analyserL.getByteTimeDomainData(time);
      for (let k = 0; k < binsM.length; k++) {
        binsM[k] = (binsL[k] + binsR[k]) * 0.5;
      }

      // ─── 1. Per-ISO-band dB energies (10-band reference) ───
      for (let i = 0; i < 10; i++) {
        bandDbInst[i] = -100;
      }
      for (let i = 0; i < 10; i++) {
        const kLo = isoBinRanges[i * 2];
        const kHi = isoBinRanges[i * 2 + 1];
        let sumLin = 0;
        let count = 0;
        for (let k = kLo; k < kHi; k++) {
          const db = (binsM[k] / 255) * 100 - 100;
          sumLin += Math.pow(10, db / 20);
          count++;
        }
        const mean = sumLin / Math.max(1, count);
        bandDbInst[i] = 20 * Math.log10(Math.max(1e-9, mean));
        bandDbEma[i] += EMA_ALPHA * (bandDbInst[i] - bandDbEma[i]);
      }

      // ─── 2. Spectral balance correction (pink target, mean-normalized) ───
      let meanDb = 0;
      for (let i = 0; i < 10; i++) meanDb += bandDbEma[i];
      meanDb /= 10;
      for (let i = 0; i < 10; i++) {
        const observed = bandDbEma[i] - meanDb;
        const deviation = PINK_TARGET_10[i] - observed;
        correction10[i] = clamp(CORRECTION_STRENGTH * deviation, -CORRECTION_CEILING, CORRECTION_CEILING);
      }

      // ─── 3. Features ───
      const centroid = spectralCentroid(binsM, sampleRate, fftSize);
      const bassRatio = bandEnergyRatio(binsM, 20, 200, sampleRate);
      const flux = spectralFlux(binsM, prevSpectrum);
      const flat = spectralFlatness(binsM);
      const { rmsDb, crestDb } = timeDomainStats(time);

      // Onset peak: flux > 1.4× running mean → register onset (per-tick window).
      const fluxMean = (prevSpectrum[binsM.length - 1] || 0.001); // hack-stash: last cell tracks running mean
      const runningMean = fluxMean * 0.9 + flux * 0.1;
      prevSpectrum[binsM.length - 1] = runningMean;
      if (flux > 1.4 * runningMean && flux > 0.02) {
        onsetTimes.push(performance.now());
      }
      const now = performance.now();
      while (onsetTimes.length && now - onsetTimes[0] > 1000) onsetTimes.shift();
      const onsetDensity = onsetTimes.length;

      // ─── 4. Vocal detection ───
      const vocalR = bandStereoCorrelation(binsL, binsR, 250, 3000, sampleRate);
      const vocalRatio = bandEnergyRatio(binsM, 250, 3000, sampleRate);
      const vocalEnergyMid = bandEnergyRatio(binsM, 250, 3000, sampleRate) || 0.0001;
      const vocalFormantBand = bandEnergyRatio(binsM, 250, 700, sampleRate);
      const formantInVocal = vocalFormantBand / vocalEnergyMid;
      const vocalRaw =
        vocalR >= (vocalActive ? VOCAL_RELEASE_R : VOCAL_ENTER_R) &&
        vocalRatio >= (vocalActive ? VOCAL_RATIO_RELEASE : VOCAL_RATIO_ENTER) &&
        formantInVocal >= VOCAL_FORMANT_GATE;
      if (vocalRaw) {
        vocalAbove += DT;
        vocalBelow = 0;
        if (vocalAbove >= VOCAL_ENTER_DWELL_S) vocalActive = true;
      } else {
        vocalBelow += DT;
        vocalAbove = 0;
        if (vocalBelow >= VOCAL_EXIT_DWELL_S) vocalActive = false;
      }
      const vocalScoreTarget = vocalActive ? 1 : 0;
      vocalScoreSm += 0.45 * (vocalScoreTarget - vocalScoreSm); // ~120ms attack/release

      // ─── 5. Character classifier (priority-ordered) ───
      let nextMode: Mode;
      if (bassRatio > 0.32 && centroid < 1500) nextMode = 'bass';
      else if (onsetDensity > 4.5 && crestDb > 14) nextMode = 'rhythmic';
      else if (vocalScoreSm > 0.6 && bassRatio < 0.25 && onsetDensity < 4) nextMode = 'vocal';
      else if (onsetDensity < 1.2 && flat > 0.25) nextMode = 'instrumental';
      else nextMode = 'dense';

      if (nextMode === currentMode) {
        candidateMode = currentMode;
        modeCandidateAcc = 0;
      } else if (nextMode === candidateMode) {
        modeCandidateAcc += DT;
        if (modeCandidateAcc >= MODE_DWELL_S) {
          currentMode = nextMode;
          modeCandidateAcc = 0;
        }
      } else {
        candidateMode = nextMode;
        modeCandidateAcc = DT;
      }

      // Soft mode confidence (margin against thresholds, clamped 0..1).
      const modeConfidence = modeMargin(currentMode, { centroid, bassRatio, onsetDensity, crestDb, flat, vocalScore: vocalScoreSm });

      // ─── 6. Loudness compensation (Fletcher–Munson) ───
      // smoothstep(low,high,x) where low engages, high disengages
      const t = clamp01((rmsDb - LOUDNESS_LOW_DB) / (LOUDNESS_HIGH_DB - LOUDNESS_LOW_DB));
      const loudEng = 1 - smoothstep01(t);

      // ─── 7. Absolute-targeting model ───
      // The AI has an ideal effective EQ shape it wants — mean-zero around
      // 0 dB. Target = idealShape directly. Delta = target − baseline, so
      // wherever the user has dragged a slider, the AI actively moves toward
      // its own preferred position. The user-override gate (below) preserves
      // fresh manual adjustments for 4 s + 3 s ramp; the lock buttons preserve
      // a band indefinitely. Without those, the AI takes back over.
      const modeDelta = MODE_PROFILES[currentMode];
      for (let i = 0; i < 10; i++) {
        idealShape10[i] =
          correction10[i] +
          modeDelta[i] * modeConfidence +
          VOCAL_PROFILE[i] * vocalScoreSm +
          LOUDNESS_PROFILE[i] * loudEng;
      }
      const baselineNow = baselineRef.current;
      let baseline10: ArrayLike<number>;
      if (bandCount === 10) {
        // Mirror baselineNow into the preallocated buffer instead of slicing.
        for (let i = 0; i < 10; i++) baseline10Buf[i] = baselineNow[i] ?? 0;
        baseline10 = baseline10Buf;
      } else {
        // interpolateLog still allocates — leave it for a separate, scoped change.
        baseline10 = interpolateLog(baselineNow, targetFreqs, iso10List);
      }
      for (let i = 0; i < 10; i++) {
        const d = idealShape10[i] - baseline10[i];
        desiredDelta10[i] = clamp(d, -TOTAL_CEILING, TOTAL_CEILING);
      }

      // ─── 8. Interpolate to actual bandCount (10/15/31) ───
      let targetDelta: ArrayLike<number>;
      if (bandCount === 10) {
        targetDelta = desiredDelta10;
      } else {
        // For 15/31 bands we still call interpolateLog; the allocation is small
        // and bounded by bandCount.
        const arr = Array.from(desiredDelta10);
        targetDelta = interpolateLog(arr, iso10List, targetFreqs);
      }

      // ─── 9. User-override gate + slew limit ───
      const cur = deltaRef.current;
      if (cur.length !== bandCount) {
        // Shouldn't happen — useEffect above keeps it in sync — but guard anyway.
        return;
      }
      // Reuse flashedBuf — clear it instead of reallocating.
      for (let i = 0; i < bandCount; i++) flashedBuf[i] = false;
      const lockedNow = lockedRef.current;
      for (let i = 0; i < bandCount; i++) {
        // Locked band → drain its delta to zero gently and skip.
        if (lockedNow[i]) {
          const r = isBassFlags[i] ? SLEW_BASS : SLEW_OTHER;
          const maxStep = r * DT;
          cur[i] = approach(cur[i], 0, maxStep);
          continue;
        }
        // User-override gain
        const since = (now - lastUserTouchRef.current[i]) / 1000;
        let userGain = 1;
        if (since < USER_OVERRIDE_FADE_OUT_S) {
          userGain = 0; // freshly touched → immediate pause
        } else if (since < USER_OVERRIDE_HOLD_S) {
          userGain = 0;
        } else if (since < USER_OVERRIDE_HOLD_S + USER_OVERRIDE_FADE_IN_S) {
          userGain = (since - USER_OVERRIDE_HOLD_S) / USER_OVERRIDE_FADE_IN_S;
        }
        const raw = targetDelta[i] * userGain;
        const rate = isBassFlags[i] ? SLEW_BASS : SLEW_OTHER;
        const prev = cur[i];
        const next = approach(prev, clamp(raw, -TOTAL_CEILING, TOTAL_CEILING), rate * DT);
        if (Math.abs(next - prev) > 0.05) flashedBuf[i] = true;
        cur[i] = next;
      }
      // Snapshot into the reusable buffer (no per-tick allocation). The
      // consumer (App.tsx) does its own threshold-diff and only commits to
      // React state when band values have actually moved — so it's safe to
      // hand it the same buffer each tick.
      if (deltaSnapshotBuf.length !== bandCount) {
        deltaSnapshotBuf.length = bandCount;
      }
      for (let i = 0; i < bandCount; i++) deltaSnapshotBuf[i] = cur[i];
      onTickRef.current?.(deltaSnapshotBuf, flashedBuf);
    };

    const id = window.setInterval(tick, 1000 / TICK_HZ);
    return () => {
      ticking = false;
      window.clearInterval(id);
    };
  }, [analyserL, analyserR, enabled, bandCount, deltaRef]);

  return {
    setTargetTau: SET_TARGET_TAU,
    noteUserTouch,
  };
}

/* ────────────────────────────────────────────────────────────── */
/* Helpers                                                        */
/* ────────────────────────────────────────────────────────────── */

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function smoothstep01(t: number): number {
  return t * t * (3 - 2 * t);
}

function approach(prev: number, target: number, maxStep: number): number {
  const diff = target - prev;
  if (diff > maxStep) return prev + maxStep;
  if (diff < -maxStep) return prev - maxStep;
  return target;
}

function isBassBand(centerHz: number): boolean {
  return centerHz <= 200;
}

function spectralCentroid(mag: Float32Array, sampleRate: number, fftSize: number): number {
  let num = 0, den = 0;
  const binHz = sampleRate / fftSize;
  for (let k = 1; k < mag.length; k++) {
    num += k * binHz * mag[k];
    den += mag[k];
  }
  return den < 1 ? 0 : num / den;
}

function bandEnergyRatio(mag: Float32Array, lo: number, hi: number, sampleRate: number): number {
  const nyq = sampleRate / 2;
  const kLo = Math.max(1, Math.floor((lo / nyq) * mag.length));
  const kHi = Math.max(kLo + 1, Math.min(mag.length, Math.ceil((hi / nyq) * mag.length)));
  let band = 0, total = 0;
  for (let k = 1; k < mag.length; k++) {
    const v = mag[k];
    total += v;
    if (k >= kLo && k < kHi) band += v;
  }
  return total < 1 ? 0 : band / total;
}

function spectralFlux(mag: Float32Array, prev: Float32Array): number {
  let flux = 0;
  // Skip last cell — it's used as a "running mean of flux" stash by the engine.
  const n = mag.length - 1;
  for (let k = 0; k < n; k++) {
    const d = mag[k] / 255 - prev[k] / 255;
    if (d > 0) flux += d;
    prev[k] = mag[k];
  }
  return flux / Math.max(1, n);
}

function spectralFlatness(mag: Float32Array): number {
  let logSum = 0, arithSum = 0;
  const n = mag.length;
  for (let k = 1; k < n; k++) {
    const v = (mag[k] / 255) + 1e-6;
    logSum += Math.log(v);
    arithSum += v;
  }
  const geo = Math.exp(logSum / (n - 1));
  const arith = arithSum / (n - 1);
  return arith < 1e-6 ? 0 : geo / arith;
}

function timeDomainStats(time: Uint8Array): { rmsDb: number; crestDb: number } {
  let sumSq = 0, peak = 0;
  for (let i = 0; i < time.length; i++) {
    const v = (time[i] - 128) / 128;
    const a = v < 0 ? -v : v;
    if (a > peak) peak = a;
    sumSq += v * v;
  }
  const rms = Math.sqrt(sumSq / time.length);
  const rmsDb = rms < 1e-6 ? -100 : 20 * Math.log10(rms);
  const crestDb = rms < 1e-6 || peak < 1e-6 ? 0 : 20 * Math.log10(peak / rms);
  return { rmsDb, crestDb };
}

function bandStereoCorrelation(
  binsL: Uint8Array,
  binsR: Uint8Array,
  lo: number,
  hi: number,
  sampleRate: number,
): number {
  const nyq = sampleRate / 2;
  const kLo = Math.max(1, Math.floor((lo / nyq) * binsL.length));
  const kHi = Math.max(kLo + 1, Math.min(binsL.length, Math.ceil((hi / nyq) * binsL.length)));
  let sumL = 0, sumR = 0;
  const n = kHi - kLo;
  for (let k = kLo; k < kHi; k++) {
    sumL += binsL[k];
    sumR += binsR[k];
  }
  const mL = sumL / n, mR = sumR / n;
  let num = 0, dL = 0, dR = 0;
  for (let k = kLo; k < kHi; k++) {
    const a = binsL[k] - mL, b = binsR[k] - mR;
    num += a * b;
    dL += a * a;
    dR += b * b;
  }
  const denom = Math.sqrt(dL * dR);
  return denom < 1e-6 ? 0 : num / denom;
}

interface ClassifierFeatures {
  centroid: number;
  bassRatio: number;
  onsetDensity: number;
  crestDb: number;
  flat: number;
  vocalScore: number;
}

function modeMargin(mode: Mode, f: ClassifierFeatures): number {
  // Soft margin against the dominant threshold for the chosen mode.
  // Smaller margin → lower confidence → smaller mode-profile contribution.
  let margin = 0;
  switch (mode) {
    case 'bass':
      margin = Math.min((f.bassRatio - 0.32) / 0.32, (1500 - f.centroid) / 1500);
      break;
    case 'rhythmic':
      margin = Math.min((f.onsetDensity - 4.5) / 4.5, (f.crestDb - 14) / 14);
      break;
    case 'vocal':
      margin = Math.min(f.vocalScore - 0.6, (0.25 - f.bassRatio) / 0.25, (4 - f.onsetDensity) / 4);
      break;
    case 'instrumental':
      margin = Math.min((1.2 - f.onsetDensity) / 1.2, (f.flat - 0.25) / 0.25);
      break;
    case 'dense':
      margin = 0.25; // fallback always at moderate confidence
      break;
  }
  return clamp01(margin / 0.5);
}

/** Log-frequency interpolation from a 10-band value array onto an arbitrary
 *  target frequency vector. Endpoints clamped. */
function interpolateLog(values10: number[], freqs10: number[], target: number[]): number[] {
  const logF10 = freqs10.map(Math.log);
  return target.map((f) => {
    const lf = Math.log(f);
    if (lf <= logF10[0]) return values10[0];
    if (lf >= logF10[logF10.length - 1]) return values10[values10.length - 1];
    for (let i = 0; i < logF10.length - 1; i++) {
      if (logF10[i] <= lf && lf <= logF10[i + 1]) {
        const t = (lf - logF10[i]) / (logF10[i + 1] - logF10[i]);
        return values10[i] + t * (values10[i + 1] - values10[i]);
      }
    }
    return 0;
  });
}

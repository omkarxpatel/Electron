import { useEffect, useRef } from 'react';
import { frequenciesFor, qFor, type BandCount } from '../state/eq';
import {
  ISO_10,
  effectTargetsFor,
  resolveTarget,
  type EffectTargets,
  type EnhanceProfileId,
  type MaterialClass,
} from './enhanceProfiles';
import { buildCurveSolver, solveBandGains } from './biquadResponse';

/**
 * AI Enhancer — adaptive graphic EQ that matches the playing music toward a
 * target spectrum.
 *
 * Per-tick (10 Hz) flow:
 *
 *   1. Pull L + R FFT twice: float for band energies (exact dBFS) and byte
 *      for the classifier features.
 *   2. Aggregate float bins into 10 ISO band levels in real dBFS, average them
 *      over the adapt window (20 s Steady / 1.5 s Live, bias-corrected while
 *      warming up), and derive a per-band "is anything here" gate.
 *   3. Features (centroid, bassRatio, onset density, crest, flatness) + vocal
 *      detection → material class, with dwell and a smoothed confidence.
 *   4. `enhanceProfiles.resolveTarget` turns (user selection, material class,
 *      confidence) into ONE target spectrum. Correct a fraction of the
 *      measured deviation from it, capped and gated by band activity.
 *   5. Optional quiet-listening compensation, if the user asked for it.
 *   6. Invert band interaction so the response DELIVERED matches the curve
 *      computed above, then subtract the user's baseline to get a delta.
 *   7. User-override gate → per-band locks → slew limit → write to ref.
 *
 * The hook DOESN'T touch BiquadFilter directly — it writes per-band delta dB
 * values into a ref. The audio engine reads that ref each frame and adds it
 * to the user's baseline before pushing to the filter. This keeps user EQ
 * and auto-corrections separable.
 */

/** Per-band max delta. Set to the slider's full range so the AI can fully
 *  recover from any baseline position (12 dB span at 6 dB/s slew = 2 s to
 *  fully reach target from an extreme). The slew rate and override gate
 *  still keep motion smooth and non-violent. */
const TOTAL_CEILING = 12.0;

const TICK_HZ = 10;
const DT = 1 / TICK_HZ;

/**
 * How long the band-level estimate averages over.
 *
 * The target curves in `enhanceProfiles` are long-term average spectra —
 * Pestana et al. compute theirs over whole tracks. Estimating one from a
 * 1.5 s window and correcting toward it 10×/sec is a category error: the
 * result tracks the arrangement, not the mastering, so the curve breathes
 * with every chorus. The ear is far more sensitive to timbral CHANGE than to
 * timbral offset, so a curve that moves is heard as swimmy even when its
 * average position is better than flat. That's a large part of why AI Enhance
 * lost A/Bs against a static preset.
 *
 * 'steady' averages over 20 s, which is long enough to actually estimate a
 * track's spectrum. The correction converges and then effectively stops,
 * which is what a mastering engineer or a DJ does — set it and leave it.
 *
 * 'live' keeps the original 1.5 s window. It reads the arrangement rather
 * than the master, which is the wrong objective for tone but is the thing
 * that makes the sliders dance, so it stays as a deliberate choice.
 */
export type AiAdaptMode = 'live' | 'steady';
const EMA_ALPHA_LIVE = 1 - Math.exp(-DT / 1.5);
const EMA_ALPHA_STEADY = 1 - Math.exp(-DT / 20);
/** Ticks of signal before the running mean has seen a full window and the
 *  reported curve stops being a warm-up estimate. */
const LIVE_SETTLE_TICKS = Math.round(1.5 * TICK_HZ);
const STEADY_SETTLE_TICKS = Math.round(20 * TICK_HZ);
const SLEW_BASS = 3.0;   // dB/s for the first 3 bands (≤125 Hz)
const SLEW_OTHER = 6.0;
/** How long a new material class must hold before `auto` switches profile.
 *  Scaled with the adapt mode for the same reason as the EMA: in Steady the
 *  band levels settle but a profile flip is a discrete jump of a few dB, so
 *  leaving the dwell at 2 s would leave the curve moving anyway and the
 *  "Steady" label would be a lie. */
const MODE_DWELL_LIVE_S = 2.0;
const MODE_DWELL_STEADY_S = 12.0;
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
const SET_TARGET_TAU = 0.080;

/**
 * Band-activity gate, in absolute dBFS. Below FLOOR a band is treated as
 * empty and left alone; above ACTIVE it's corrected normally.
 *
 * Why this exists: Spotify's Ogg Vorbis / AAC streams are low-passed around
 * 15-16 kHz, so the 16 kHz band measures near-silent on every track. Without
 * a gate the matcher reads that as "27 dB short of target" and boosts codec
 * noise into the top octave. Same failure on any quiet passage or gap between
 * tracks — it would boost the noise floor toward the target curve.
 *
 * This is only checkable now that band levels are measured in real dBFS;
 * with the old byte decode the numbers weren't on an absolute scale at all.
 */
const BAND_FLOOR_DBFS = -72;
const BAND_ACTIVE_DBFS = -58;

/** Summed band activity (0..10) below which we treat the input as silent and
 *  freeze the curve. A quarter of one band fully active is still nothing. */
const SIGNAL_PRESENT_ACTIVITY = 0.25;

/**
 * Quiet-listening compensation at full engagement. U-shaped, per the
 * equal-loudness contours (ISO 226:2023).
 *
 * This is opt-in and flat-rate rather than automatic. It used to engage
 * itself by measuring program RMS between -50 and -25 dBFS, which is wrong
 * twice over: the measurement came from 8-bit time-domain data whose
 * quantization floor (~-48 dBFS) sits inside that very window, and more
 * fundamentally digital level is not listening level. A quietly-mastered
 * record got +6 dB of 31 Hz regardless of where the volume knob was.
 *
 * Fletcher-Munson compensation is only meaningful against calibrated SPL at
 * the listener, which we can't measure. So the user asserts the condition
 * instead — they know when they're listening quietly.
 *
 * Mean-zero, like the match target: it's a SHAPE, not a level. The same curve
 * written as all-boost (+6 at 31 Hz down to 0 at 1 kHz) is identical to the
 * ear but costs 6 dB of headroom, which the auto-trim then takes straight
 * back off the whole signal. Boosting to immediately attenuate is how you end
 * up with "the correction made it quieter".
 */
const LOUDNESS_PROFILE = [+4.0, +2.5, +1.0, -0.5, -1.5, -2.0, -2.5, -2.0, -0.5, +1.5];

/** Effect slew limits, per second. Slower than the EQ's: a moving stereo
 *  image or a breathing distortion amount is far more noticeable than a
 *  moving band. The target values themselves live in enhanceProfiles. */
const AI_SLEW_WIDTH = 12;
const AI_SLEW_EXCITER = 8;
const AI_SLEW_EXCITER_FREQ = 25;

/** Effect values the AI is driving. `active` is false when AI effects
 *  control is off, in which case the user's own values stand. */
export interface AiEffectTargets extends EffectTargets {
  active: boolean;
}

interface Params {
  analyserL: AnalyserNode | null;
  analyserR: AnalyserNode | null;
  enabled: boolean;
  bandCount: BandCount;
  locked: boolean[];
  /** Which target spectrum to match. 'auto' classifies the material live. */
  profileId: EnhanceProfileId;
  /** How long the band-level estimate averages over. See AiAdaptMode. */
  adapt: AiAdaptMode;
  /** Apply the equal-loudness U-curve for quiet listening. */
  loudnessComp: boolean;
  /** Let the AI drive stereo width and the bass exciter. */
  driveEffects: boolean;
  /** Ref the AI writes its effect targets into, read by the audio engine.
   *  Same arrangement as deltaRef: a ref rather than state so the 10 Hz loop
   *  doesn't re-render anything. */
  effectsRef: { current: AiEffectTargets };
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
  /** Called only when the reported status actually changes, so the parent can
   *  drop it straight into React state without throttling it itself. */
  onStatus?: (status: AiEnhancerStatus) => void;
}

/** What the enhancer is currently doing, for display. Without this the user
 *  has no way to tell which target `auto` settled on, or whether the estimate
 *  has finished warming up — and therefore no way to judge the feature. */
export interface AiEnhancerStatus {
  /** The target actually dominating the blend right now. */
  dominant: Exclude<EnhanceProfileId, 'auto'>;
  /** False while the averaging window is still filling. */
  settled: boolean;
  /** No signal above the noise floor — the curve is frozen. */
  idle: boolean;
  /** What the AI is doing to the effects rack, or null when it isn't. */
  effects: AiEffectTargets | null;
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
  profileId,
  adapt,
  loudnessComp,
  driveEffects,
  effectsRef,
  deltaRef,
  baselineRef,
  bandFreqs,
  onTick,
  onStatus,
}: Params): AiEnhancerHandle {
  const lastUserTouchRef = useRef<number[]>(new Array(bandCount).fill(0));
  // Mirror dynamic inputs into refs so the tick effect doesn't tear down
  // on every render. (Without this, an inline `onTick` arrow or a fresh
  // `locked` array kills the engine before it can produce useful state.)
  // profileId and loudnessComp go through refs for a second reason: a
  // teardown would reset the band EMAs, so switching profile would jump the
  // curve instead of gliding to the new target under the slew limiter.
  const lockedRef = useRef<boolean[]>(locked);
  lockedRef.current = locked;
  const onTickRef = useRef<typeof onTick>(onTick);
  onTickRef.current = onTick;
  const onStatusRef = useRef<typeof onStatus>(onStatus);
  onStatusRef.current = onStatus;
  const profileIdRef = useRef<EnhanceProfileId>(profileId);
  profileIdRef.current = profileId;
  const adaptRef = useRef<AiAdaptMode>(adapt);
  adaptRef.current = adapt;
  const loudnessCompRef = useRef<boolean>(loudnessComp);
  loudnessCompRef.current = loudnessComp;
  const driveEffectsRef = useRef<boolean>(driveEffects);
  driveEffectsRef.current = driveEffects;

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
    const targetFreqs = bandFreqs.length === bandCount ? bandFreqs : frequenciesFor(bandCount);
    // A null curveSolver (singular normal equations) means we can't work out
    // which filter gains deliver a given curve, so there's nothing honest to
    // write. Treated the same as switched-off rather than guessed at. Doesn't
    // happen for the three shipped layouts; it's the guard, not a code path.
    const curveSolver =
      analyserL && enabled
        ? buildCurveSolver(targetFreqs, qFor(bandCount), ISO_10, analyserL.context.sampleRate)
        : null;
    if (!enabled || !analyserL || !analyserR || !curveSolver) {
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
    // Float FFT — real dBFS per bin, which the byte path can't give us. The
    // byte data is quantized to a fixed dB window (minDecibels..maxDecibels,
    // -100..-30 by default) and saturates at the top of it; on mastered music
    // the bass and midrange sit above -30 dBFS most of the time and all read
    // 255. The old code also decoded bytes as if the window were 100 dB wide
    // rather than 70, inflating every measured deviation by 1.43×.
    const fltL = new Float32Array(analyserL.frequencyBinCount);
    const fltR = new Float32Array(analyserR.frequencyBinCount);
    const time = new Uint8Array(analyserL.fftSize);
    const sampleRate = analyserL.context.sampleRate;
    const fftSize = analyserL.fftSize;

    // Persistent state across ticks.
    const bandDbEma = new Array(10).fill(-100);
    /** Ticks of real signal folded into bandDbEma so far. Used to bias-correct
     *  the EMA while it warms up — see the alpha calculation in the tick. */
    let emaTicks = 0;
    const prevSpectrum = new Float32Array(binsM.length);
    const onsetTimes: number[] = [];
    let currentMode: MaterialClass = 'dense';
    let candidateMode: MaterialClass = 'dense';
    let modeCandidateAcc = 0;
    let confidenceSm = 0;
    // Current (slewed) effect values, persisted across ticks.
    let fxWidth = 100;
    let fxExciter = 0;
    let fxExciterFreq = 90;
    /** Last status handed to onStatus. Compared field-by-field so the parent
     *  only re-renders when something a human would notice has changed. */
    let lastStatus: AiEnhancerStatus | null = null;
    let vocalScoreSm = 0;
    let vocalAbove = 0;       // accumulated time above enter threshold
    let vocalBelow = 0;       // accumulated time in release
    let vocalActive = false;

    // ─── Preallocated scratch buffers — created once per engine lifetime
    // and reused on every tick. At 10 Hz this eliminates ~7 array allocations
    // per second (×4–31 elements each), removing a meaningful GC contributor.
    const bandDbInst = new Float64Array(10);
    const activity10 = new Float64Array(10);
    const target10 = new Float64Array(10);
    const idealShape10 = new Float64Array(10);
    const filterGainsN = new Float64Array(bandCount);
    const flashedBuf: boolean[] = new Array(bandCount).fill(false);
    const deltaSnapshotBuf: number[] = new Array(bandCount).fill(0);
    const isBassFlags = new Uint8Array(bandCount);
    for (let i = 0; i < bandCount; i++) isBassFlags[i] = targetFreqs[i] <= 200 ? 1 : 0;
    // Cache the kLo/kHi FFT-bin range per ISO band (10 entries × 2 ints) —
    // these depend only on sampleRate + bin count, both stable.
    //
    // Known limit: at fftSize 1024 / 48 kHz a bin is 46.9 Hz, so the 31 Hz and
    // 62 Hz bands both resolve to the single bin at 46.9 Hz and always read the
    // same level. The sub/bass split therefore comes from the target curve's own
    // shape rather than from anything measured. Bumping the pre-EQ analysers to
    // 4096 would fix it, but every classifier threshold below is normalised by
    // bin count, so that change has to come with re-derived thresholds.
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
      analyserL.getFloatFrequencyData(fltL);
      analyserR.getFloatFrequencyData(fltR);
      analyserL.getByteTimeDomainData(time);
      for (let k = 0; k < binsM.length; k++) {
        binsM[k] = (binsL[k] + binsR[k]) * 0.5;
      }

      // ─── 1. Per-ISO-band levels in real dBFS, + activity gate ───
      let loudestInst = -200;
      for (let i = 0; i < 10; i++) {
        const kLo = isoBinRanges[i * 2];
        const kHi = isoBinRanges[i * 2 + 1];
        let sumLin = 0;
        let count = 0;
        for (let k = kLo; k < kHi; k++) {
          // Mono-sum in linear amplitude, not in dB — averaging decibels
          // biases toward the quieter channel.
          sumLin += (Math.pow(10, fltL[k] / 20) + Math.pow(10, fltR[k] / 20)) * 0.5;
          count++;
        }
        const mean = sumLin / Math.max(1, count);
        // Floored well below the activity gate: true silence reads about
        // -180 dB, which is a long way for an average to climb back from.
        bandDbInst[i] = Math.max(-120, 20 * Math.log10(Math.max(1e-9, mean)));
        if (bandDbInst[i] > loudestInst) loudestInst = bandDbInst[i];
      }
      const isLive = adaptRef.current === 'live';
      // Fold into the running estimate only while something is actually
      // playing. A 20 s window that averages in the gap between tracks would
      // have a few seconds of near-silence — which is spectrally flat at the
      // floor — pulling the estimated shape toward flat.
      const signalPresent = loudestInst > BAND_FLOOR_DBFS;
      // Bias-corrected EMA: 1/n early on makes this an exact running mean
      // until the window fills, then it settles to the fixed time constant.
      // Without it a 20 s window would take most of a minute to become
      // meaningful, and the enhancer would sit idle through the start of
      // every listening session.
      const emaAlpha = Math.max(isLive ? EMA_ALPHA_LIVE : EMA_ALPHA_STEADY, 1 / (emaTicks + 1));
      if (signalPresent) {
        emaTicks++;
        for (let i = 0; i < 10; i++) {
          bandDbEma[i] += emaAlpha * (bandDbInst[i] - bandDbEma[i]);
        }
      }
      for (let i = 0; i < 10; i++) {
        activity10[i] = smoothstep01(
          clamp01((bandDbEma[i] - BAND_FLOOR_DBFS) / (BAND_ACTIVE_DBFS - BAND_FLOOR_DBFS)),
        );
      }

      // ─── 2. Features ───
      const centroid = spectralCentroid(binsM, sampleRate, fftSize);
      const bassRatio = bandEnergyRatio(binsM, 20, 200, sampleRate);
      const flux = spectralFlux(binsM, prevSpectrum);
      const flat = spectralFlatness(binsM);
      const { crestDb } = timeDomainStats(time);

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

      // ─── 3. Vocal detection ───
      const vocalR = bandStereoCorrelation(binsL, binsR, 250, 3000, sampleRate);
      const vocalRatio = bandEnergyRatio(binsM, 250, 3000, sampleRate);
      const vocalEnergyMid = vocalRatio || 0.0001;  // same as vocalRatio; was being recomputed
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

      // ─── 4. Material classifier (priority-ordered) ───
      let nextMode: MaterialClass;
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
        if (modeCandidateAcc >= (isLive ? MODE_DWELL_LIVE_S : MODE_DWELL_STEADY_S)) {
          currentMode = nextMode;
          modeCandidateAcc = 0;
        }
      } else {
        candidateMode = nextMode;
        modeCandidateAcc = DT;
      }

      // Soft mode confidence (margin against thresholds, clamped 0..1), on
      // the same time constant as the band levels. It comes from
      // instantaneous features, and `auto` blends reference→profile by it, so
      // an unsmoothed confidence would keep the target drifting every tick
      // even once the spectrum estimate and the material class had both settled.
      if (signalPresent) {
        const rawConfidence = modeMargin(currentMode, { centroid, bassRatio, onsetDensity, crestDb, flat, vocalScore: vocalScoreSm });
        confidenceSm += emaAlpha * (rawConfidence - confidenceSm);
      }

      // ─── 5. Resolve the target spectrum and match toward it ───
      const { strength, ceilingDb, dominant } = resolveTarget(
        profileIdRef.current,
        currentMode,
        confidenceSm,
        target10,
      );
      // Mean over ACTIVE bands only. An empty band (codec-lowpassed top
      // octave, a gap between tracks) sitting at -100 dBFS would otherwise
      // drag the mean down and skew every other band's deviation with it.
      let wSum = 0;
      let mSum = 0;
      for (let i = 0; i < 10; i++) {
        mSum += activity10[i] * bandDbEma[i];
        wSum += activity10[i];
      }
      const meanDb = wSum > 1e-3 ? mSum / wSum : 0;
      // Nothing playing → hold everything where it is rather than moving it.
      // The AI targets an absolute shape, so with every band gated off its
      // target is neutral, and it would spend a pause slewing the user's whole
      // manual curve to flat and then slewing it back when the music returns.
      // Silence isn't a tonal balance worth correcting toward. Smoothed rather
      // than instantaneous so it can't chatter on a quiet passage.
      const hold = wSum < SIGNAL_PRESENT_ACTIVITY;
      const applyLoudness = loudnessCompRef.current;
      for (let i = 0; i < 10; i++) {
        const observed = bandDbEma[i] - meanDb;
        const deviation = target10[i] - observed;
        const match = clamp(strength * deviation, -ceilingDb, ceilingDb) * activity10[i];
        idealShape10[i] = match + (applyLoudness ? LOUDNESS_PROFILE[i] : 0);
      }

      // ─── 5b. Effects rack targets ───
      // Reuses measurements already taken above. See the AI_WIDTH_* /
      // AI_EXCITER_* constants for why width and exciter are driven and
      // reverb isn't.
      if (driveEffectsRef.current && !hold) {
        // Correlation over the range where widening does anything. Below
        // ~300 Hz most masters are near-mono by design and widening the low
        // end is how you lose the centre; above 8 kHz there's little there.
        const corr = bandStereoCorrelation(binsL, binsR, 300, 8000, sampleRate);
        const want = effectTargetsFor(
          corr,
          (bandDbEma[0] + bandDbEma[1]) * 0.5 - meanDb,
          bandDbEma[1] - bandDbEma[0],
          // Gate on the bottom two bands actually containing something —
          // without it we'd generate harmonics from the noise floor of a
          // bass-light record.
          Math.min(activity10[0], activity10[1]),
        );
        fxWidth = approach(fxWidth, want.width, AI_SLEW_WIDTH * DT);
        fxExciter = approach(fxExciter, want.exciter, AI_SLEW_EXCITER * DT);
        fxExciterFreq = approach(fxExciterFreq, want.exciterFreq, AI_SLEW_EXCITER_FREQ * DT);
      }
      const fx = effectsRef.current;
      fx.active = driveEffectsRef.current;
      fx.width = fxWidth;
      fx.exciter = fxExciter;
      fx.exciterFreq = fxExciterFreq;

      // ─── 6. Curve → filter gains ───
      // idealShape10 is the response we want to HEAR. Overlapping biquads sum
      // and shelves only deliver half their gain at their corner frequency, so
      // writing the curve straight to the filter gains delivers something else
      // entirely. The solver maps curve → gains in one matvec, resampling to
      // the user's band layout on the way.
      solveBandGains(curveSolver, idealShape10, filterGainsN, bandCount, 10);

      // ─── 7. User-override gate + slew limit ───
      const cur = deltaRef.current;
      if (cur.length !== bandCount) {
        // Shouldn't happen — useEffect above keeps it in sync — but guard anyway.
        return;
      }
      const baselineNow = baselineRef.current;
      // Reuse flashedBuf — clear it instead of reallocating.
      for (let i = 0; i < bandCount; i++) flashedBuf[i] = false;
      const lockedNow = lockedRef.current;
      for (let i = 0; !hold && i < bandCount; i++) {
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
        const desired = (filterGainsN[i] - (baselineNow[i] ?? 0)) * userGain;
        const rate = isBassFlags[i] ? SLEW_BASS : SLEW_OTHER;
        const prev = cur[i];
        const next = approach(prev, clamp(desired, -TOTAL_CEILING, TOTAL_CEILING), rate * DT);
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

      const settled = emaTicks >= (isLive ? LIVE_SETTLE_TICKS : STEADY_SETTLE_TICKS);
      const fxSnapshot: AiEffectTargets | null = fx.active
        ? { active: true, width: fxWidth, exciter: fxExciter, exciterFreq: fxExciterFreq }
        : null;
      if (
        lastStatus === null ||
        lastStatus.dominant !== dominant ||
        lastStatus.settled !== settled ||
        lastStatus.idle !== hold ||
        effectsDiffer(lastStatus.effects, fxSnapshot)
      ) {
        lastStatus = { dominant, settled, idle: hold, effects: fxSnapshot };
        onStatusRef.current?.(lastStatus);
      }
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

/** Threshold comparison so slewing effect values don't re-render the panel
 *  ten times a second for changes no knob could show. */
function effectsDiffer(a: AiEffectTargets | null, b: AiEffectTargets | null): boolean {
  if ((a === null) !== (b === null)) return true;
  if (a === null || b === null) return false;
  return (
    Math.abs(a.width - b.width) > 0.5 ||
    Math.abs(a.exciter - b.exciter) > 0.5 ||
    Math.abs(a.exciterFreq - b.exciterFreq) > 1
  );
}

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

/* The feature helpers below read the BYTE spectrum, which is quantized into
 * the analyser's minDecibels..maxDecibels window and saturates at the top of
 * it. That distorts them on loud material. They're left on the byte path
 * deliberately: every classifier threshold above was tuned against this exact
 * behaviour, so moving them to float dB would need all of those thresholds
 * re-derived against measurements. The band levels that drive the actual EQ
 * correction are on the float path, which is what mattered. Retuning the
 * classifier is a separate, measurable change. */

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

function modeMargin(mode: MaterialClass, f: ClassifierFeatures): number {
  // Soft margin against the dominant threshold for the chosen mode.
  // Smaller margin → lower confidence → target blends back toward reference.
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

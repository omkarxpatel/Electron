import type { EffectsState } from '../state/effects';

/**
 * The effects rack's Web Audio node graph, built as one unit so
 * `useAudioEngine` only has to splice `input`/`output` into the chain
 * between the tone shelves and the panner.
 *
 * Signal flow:
 *
 *   input → [mid/side width] → [bass exciter] → [reverb] → output
 *
 * Two of the three branches are attach-on-demand. The convolver and the
 * 4x-oversampled waveshaper are the only genuinely expensive nodes here, and
 * leaving them connected-but-silent would burn CPU for nothing — so at zero
 * they're disconnected outright, mirroring the pre-EQ analyser attach/detach
 * already used for the AI enhancer.
 */

/** Seconds for setTargetAtTime ramps. Short enough to feel instant, long
 *  enough that a knob drag doesn't produce zipper noise. */
const RAMP = 0.02;

export interface EffectsChain {
  /** Splice point: feed the post-shelf signal here. */
  input: AudioNode;
  /** Splice point: read the processed signal from here. */
  output: AudioNode;
  /** Push the full state in. Cheap ops only — decay is handled separately. */
  apply(state: EffectsState): void;
  /** Rebuild the impulse response. Allocates a multi-megabyte buffer, so the
   *  caller debounces this rather than running it per slider tick. */
  setDecay(seconds: number): void;
  /** Tear every node down. */
  dispose(): void;
}

/**
 * Exponentially-decaying white noise, which is a serviceable stand-in for a
 * real room impulse without shipping any audio assets. The 2.5 exponent is
 * the tuning that matters: a linear ramp ends too abruptly and reads as a
 * gate rather than a tail.
 *
 * `convolver.normalize` is left at its default `true`, which scales the
 * result so wet-at-100 % lands near unity instead of deafening.
 */
function buildImpulse(ctx: AudioContext, decaySeconds: number): AudioBuffer {
  const rate = ctx.sampleRate;
  const len = Math.max(1, Math.floor(rate * decaySeconds));
  const buf = ctx.createBuffer(2, len, rate);
  for (let ch = 0; ch < 2; ch++) {
    const data = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.5);
    }
  }
  return buf;
}

/**
 * Asymmetric soft-clip curve. The asymmetry is the point: a symmetric
 * clipper makes odd harmonics, while an asymmetric one makes strong *even*
 * harmonics — the octave-up your ear uses to reconstruct a fundamental the
 * speaker can't physically produce. That's why this makes bass audible on
 * laptop speakers where an EQ boost just wastes headroom.
 */
function buildExciterCurve(n = 2048): Float32Array<ArrayBuffer> {
  // Explicit ArrayBuffer: WaveShaperNode.curve won't take the ArrayBufferLike
  // that the bare `new Float32Array(n)` overload infers.
  const curve = new Float32Array(new ArrayBuffer(n * Float32Array.BYTES_PER_ELEMENT));
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = x >= 0 ? Math.tanh(2.5 * x) : Math.tanh(1.2 * x) * 0.8;
  }
  return curve;
}

export function buildEffectsChain(ctx: AudioContext, initial: EffectsState): EffectsChain {
  const input = ctx.createGain();
  const output = ctx.createGain();

  /* ─── Mid/side stereo width ───
     M = (L+R)/2, S = (L-R)/2, then L' = M + S*w, R' = M - S*w.
     At w = 1 this reconstructs the input exactly, so width=100 is a true
     no-op rather than an approximation.

     A mono source needs no special case: ChannelSplitter up-mixes it to
     stereo, giving S = 0, so both outputs stay the original mono signal. */
  const splitter = ctx.createChannelSplitter(2);
  const lToMid = ctx.createGain();
  const rToMid = ctx.createGain();
  const midSum = ctx.createGain();
  const lToSide = ctx.createGain();
  const rToSide = ctx.createGain();
  const sideSum = ctx.createGain();
  const widthGain = ctx.createGain();
  const sideToL = ctx.createGain();
  const sideToR = ctx.createGain();
  const merger = ctx.createChannelMerger(2);

  lToMid.gain.value = 0.5;
  rToMid.gain.value = 0.5;
  lToSide.gain.value = 0.5;
  rToSide.gain.value = -0.5;
  sideToL.gain.value = 1;
  sideToR.gain.value = -1;
  widthGain.gain.value = initial.width / 100;

  input.connect(splitter);
  splitter.connect(lToMid, 0);
  splitter.connect(rToMid, 1);
  lToMid.connect(midSum);
  rToMid.connect(midSum);
  splitter.connect(lToSide, 0);
  splitter.connect(rToSide, 1);
  lToSide.connect(sideSum);
  rToSide.connect(sideSum);
  sideSum.connect(widthGain);
  widthGain.connect(sideToL);
  widthGain.connect(sideToR);
  midSum.connect(merger, 0, 0);
  midSum.connect(merger, 0, 1);
  sideToL.connect(merger, 0, 0);
  sideToR.connect(merger, 0, 1);

  const widthOut = ctx.createGain();
  merger.connect(widthOut);

  /* ─── Bass exciter ───
     Isolate the lows, generate harmonics, then high-pass the result at the
     same crossover so only the harmonics are added back — not more of the
     fundamental the speaker already can't reproduce. */
  const exciterSum = ctx.createGain();
  const exciterDry = ctx.createGain();
  exciterDry.gain.value = 1;
  widthOut.connect(exciterDry);
  exciterDry.connect(exciterSum);

  const exciterLP = ctx.createBiquadFilter();
  exciterLP.type = 'lowpass';
  exciterLP.frequency.value = initial.exciterFreq;
  const exciterShaper = ctx.createWaveShaper();
  exciterShaper.curve = buildExciterCurve();
  exciterShaper.oversample = '4x';
  const exciterHP = ctx.createBiquadFilter();
  exciterHP.type = 'highpass';
  exciterHP.frequency.value = initial.exciterFreq;
  const exciterAmount = ctx.createGain();
  exciterAmount.gain.value = initial.exciter / 100;

  exciterLP.connect(exciterShaper);
  exciterShaper.connect(exciterHP);
  exciterHP.connect(exciterAmount);
  exciterAmount.connect(exciterSum);

  let exciterAttached = false;
  const setExciterAttached = (want: boolean): void => {
    if (want === exciterAttached) return;
    if (want) widthOut.connect(exciterLP);
    else widthOut.disconnect(exciterLP);
    exciterAttached = want;
  };

  /* ─── Reverb ─── */
  const reverbSum = ctx.createGain();
  const reverbDry = ctx.createGain();
  reverbDry.gain.value = 1;
  exciterSum.connect(reverbDry);
  reverbDry.connect(reverbSum);

  const convolver = ctx.createConvolver();
  convolver.normalize = true;
  convolver.buffer = buildImpulse(ctx, initial.reverbDecay);
  const reverbTone = ctx.createBiquadFilter();
  reverbTone.type = 'lowpass';
  reverbTone.frequency.value = initial.reverbTone;
  const reverbWet = ctx.createGain();
  reverbWet.gain.value = initial.reverbMix / 100;

  convolver.connect(reverbTone);
  reverbTone.connect(reverbWet);
  reverbWet.connect(reverbSum);

  let reverbAttached = false;
  const setReverbAttached = (want: boolean): void => {
    if (want === reverbAttached) return;
    if (want) exciterSum.connect(convolver);
    else exciterSum.disconnect(convolver);
    reverbAttached = want;
  };

  reverbSum.connect(output);

  // Initial attach state has to match the initial values, or a rack restored
  // from localStorage with reverb already up would come back silent.
  setExciterAttached(initial.exciter > 0);
  setReverbAttached(initial.reverbMix > 0);

  return {
    input,
    output,

    apply(state: EffectsState): void {
      const now = ctx.currentTime;
      widthGain.gain.setTargetAtTime(state.width / 100, now, RAMP);
      exciterLP.frequency.setTargetAtTime(state.exciterFreq, now, RAMP);
      exciterHP.frequency.setTargetAtTime(state.exciterFreq, now, RAMP);
      exciterAmount.gain.setTargetAtTime(state.exciter / 100, now, RAMP);
      reverbTone.frequency.setTargetAtTime(state.reverbTone, now, RAMP);
      reverbWet.gain.setTargetAtTime(state.reverbMix / 100, now, RAMP);
      // Attach before it's audible, detach only once it's silent. Detaching
      // on the same tick the gain starts ramping down would cut the tail off
      // mid-decay, so this leans on the gain already being at zero.
      setExciterAttached(state.exciter > 0);
      setReverbAttached(state.reverbMix > 0);
    },

    setDecay(seconds: number): void {
      convolver.buffer = buildImpulse(ctx, seconds);
    },

    dispose(): void {
      for (const node of [
        input,
        splitter,
        lToMid,
        rToMid,
        midSum,
        lToSide,
        rToSide,
        sideSum,
        widthGain,
        sideToL,
        sideToR,
        merger,
        widthOut,
        exciterDry,
        exciterLP,
        exciterShaper,
        exciterHP,
        exciterAmount,
        exciterSum,
        reverbDry,
        convolver,
        reverbTone,
        reverbWet,
        reverbSum,
        output,
      ]) {
        try {
          node.disconnect();
        } catch {
          // Already detached during teardown — nothing to do.
        }
      }
    },
  };
}

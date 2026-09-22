import { useCallback, useEffect, useMemo, useState } from 'react';

/**
 * Effects rack — sits AFTER the EQ + enhancer tone shelves and BEFORE the
 * panner / limiter in the audio graph. See `src/audio/effectsGraph.ts` for
 * the node wiring.
 *
 *   abBypass  : compare switch. Routes the raw input straight to the limiter,
 *               skipping EQ, enhancer and every effect here. Not level
 *               matched — the whole point is hearing what the chain does.
 *   width     : mid/side stereo width. 0 = mono, 100 = untouched, 200 = wide.
 *   exciter   : bass harmonic exciter mix, 0..100 %.
 *   exciterFreq : crossover the exciter works below, 40..160 Hz.
 *   reverbMix : wet level, 0..100 %. 0 detaches the convolver entirely.
 *   reverbDecay : impulse-response length in seconds, 0.2..5.
 *   reverbTone  : damping lowpass on the wet path only, 500..16000 Hz.
 *
 * Every control is unity-at-default: with the defaults below the rack is
 * bit-identical to not having it, and the expensive branches (convolution,
 * the 4x-oversampled shaper) are disconnected rather than merely silent.
 */

export interface EffectsState {
  abBypass: boolean;
  width: number;
  exciter: number;
  exciterFreq: number;
  reverbMix: number;
  reverbDecay: number;
  reverbTone: number;
}

export const DEFAULT_EFFECTS: EffectsState = {
  abBypass: false,
  width: 100,
  exciter: 0,
  exciterFreq: 90,
  reverbMix: 0,
  reverbDecay: 1.6,
  reverbTone: 6000,
};

const STORAGE_KEY = 'av.effects.v1';

function load(): EffectsState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_EFFECTS;
    const parsed = JSON.parse(raw) as Partial<EffectsState>;
    // A/B is a momentary comparison tool, not a setting — always start off,
    // so a restart never leaves you listening to an unprocessed signal and
    // wondering why the EQ does nothing.
    return { ...DEFAULT_EFFECTS, ...parsed, abBypass: false };
  } catch {
    return DEFAULT_EFFECTS;
  }
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

export function useEffectsRack() {
  const [state, setState] = useState<EffectsState>(load);

  // Debounced persistence — same rationale as useEQ / useEnhancer: slider
  // drags fire at ~60 Hz and each write is a blocking JSON.stringify.
  useEffect(() => {
    const t = window.setTimeout(() => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    }, 250);
    return () => window.clearTimeout(t);
  }, [state]);

  const setWidth = useCallback((v: number) => {
    setState((s) => ({ ...s, width: clamp(v, 0, 200) }));
  }, []);

  const setExciter = useCallback((v: number) => {
    setState((s) => ({ ...s, exciter: clamp(v, 0, 100) }));
  }, []);

  const setExciterFreq = useCallback((v: number) => {
    setState((s) => ({ ...s, exciterFreq: clamp(v, 40, 160) }));
  }, []);

  const setReverbMix = useCallback((v: number) => {
    setState((s) => ({ ...s, reverbMix: clamp(v, 0, 100) }));
  }, []);

  const setReverbDecay = useCallback((v: number) => {
    setState((s) => ({ ...s, reverbDecay: clamp(v, 0.2, 5) }));
  }, []);

  const setReverbTone = useCallback((v: number) => {
    setState((s) => ({ ...s, reverbTone: clamp(v, 500, 16000) }));
  }, []);

  const toggleAbBypass = useCallback(() => {
    setState((s) => ({ ...s, abBypass: !s.abBypass }));
  }, []);

  /** Reset the processing but leave A/B alone — resetting while holding the
   *  compare switch would silently change what you're comparing against. */
  const reset = useCallback(() => {
    setState((s) => ({ ...DEFAULT_EFFECTS, abBypass: s.abBypass }));
  }, []);

  // Memoized because consumers take the rack as a *single object* prop
  // (EqSection → EqPanel → EffectsPanel) rather than flattened setters. A
  // fresh literal here would invalidate EqPanel's memo on every parent
  // render — and App re-renders on each 1.5 s playback poll. Every setter
  // below is already stable, so this only changes identity when state does.
  return useMemo(
    () => ({
      state,
      setWidth,
      setExciter,
      setExciterFreq,
      setReverbMix,
      setReverbDecay,
      setReverbTone,
      toggleAbBypass,
      reset,
    }),
    [
      state,
      setWidth,
      setExciter,
      setExciterFreq,
      setReverbMix,
      setReverbDecay,
      setReverbTone,
      toggleAbBypass,
      reset,
    ],
  );
}

export type UseEffectsRackReturn = ReturnType<typeof useEffectsRack>;

import { useCallback, useEffect, useState } from 'react';

/**
 * Enhancer settings — sits AFTER the EQ in the signal chain. Tone-control trio
 * (Bass/Mid/Treble) plus master volume and L/R balance — built around knobs
 * rather than sliders.
 *
 *   bass    : low-shelf at 80 Hz, ±12 dB
 *   mid     : peaking at 1 kHz,   ±12 dB, Q ≈ 1
 *   treble  : high-shelf at 10 kHz, ±12 dB
 *   volume  : master output, 0..250 (% of unity, i.e. -∞ dB to +8 dB)
 *   balance : stereo pan, -100 (full L) .. +100 (full R)
 *
 * The 250 % ceiling pairs with the limiter (threshold -1 dBFS): the limiter
 * clamps peaks while the average level keeps rising roughly dB-for-dB with
 * masterGain. Past ~250 % the average enters the limiter knee and you get
 * compression instead of additional loudness — diminishing returns.
 */

export interface EnhancerState {
  bypass: boolean;
  bass: number;     // dB, -12..+12
  mid: number;      // dB, -12..+12
  treble: number;   // dB, -12..+12
  volume: number;   // 0..250
  balance: number;  // -100..+100
}

export const DEFAULT_ENHANCER: EnhancerState = {
  bypass: false,
  bass: 0,
  mid: 0,
  treble: 0,
  volume: 100,
  balance: 0,
};

const STORAGE_KEY = 'av.enhancer.v2';

function load(): EnhancerState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_ENHANCER;
    return { ...DEFAULT_ENHANCER, ...(JSON.parse(raw) as Partial<EnhancerState>) };
  } catch {
    return DEFAULT_ENHANCER;
  }
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

export function useEnhancer() {
  const [state, setState] = useState<EnhancerState>(load);

  // Debounce: knob drags fire setState ~60 Hz; collapse a drag burst into one
  // write. See useEQ for the same rationale.
  useEffect(() => {
    const t = window.setTimeout(() => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    }, 250);
    return () => window.clearTimeout(t);
  }, [state]);

  const setBass = useCallback((v: number) => {
    setState((s) => ({ ...s, bass: clamp(v, -12, 12) }));
  }, []);

  const setMid = useCallback((v: number) => {
    setState((s) => ({ ...s, mid: clamp(v, -12, 12) }));
  }, []);

  const setTreble = useCallback((v: number) => {
    setState((s) => ({ ...s, treble: clamp(v, -12, 12) }));
  }, []);

  const setVolume = useCallback((v: number) => {
    setState((s) => ({ ...s, volume: clamp(v, 0, 250) }));
  }, []);

  const setBalance = useCallback((v: number) => {
    setState((s) => ({ ...s, balance: clamp(v, -100, 100) }));
  }, []);

  const toggleBypass = useCallback(() => {
    setState((s) => ({ ...s, bypass: !s.bypass }));
  }, []);

  const reset = useCallback(() => setState(DEFAULT_ENHANCER), []);

  return { state, setBass, setMid, setTreble, setVolume, setBalance, toggleBypass, reset };
}

export type UseEnhancerReturn = ReturnType<typeof useEnhancer>;

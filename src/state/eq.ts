import { useCallback, useEffect, useState } from 'react';

/* ─────────────────────────────────────────────────────────────
   Band layouts
   ───────────────────────────────────────────────────────────── */

export type BandCount = 10 | 15 | 31;

/** 1-octave ISO bands (10) */
const BANDS_10 = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];

/** 2/3-octave ISO bands (15) */
const BANDS_15 = [25, 40, 63, 100, 160, 250, 400, 630, 1000, 1600, 2500, 4000, 6300, 10000, 16000];

/** 1/3-octave ISO bands (31) */
const BANDS_31 = [
  20, 25, 31.5, 40, 50, 63, 80, 100, 125, 160, 200, 250, 315, 400, 500,
  630, 800, 1000, 1250, 1600, 2000, 2500, 3150, 4000, 5000, 6300, 8000, 10000, 12500, 16000, 20000,
];

/** Standard graphic-EQ Q values — narrower bands need higher Q. */
const Q_BY_COUNT: Record<BandCount, number> = {
  10: 1.41,
  15: 2.87,
  31: 4.32,
};

export function frequenciesFor(count: BandCount): number[] {
  if (count === 10) return BANDS_10;
  if (count === 15) return BANDS_15;
  return BANDS_31;
}

export function qFor(count: BandCount): number {
  return Q_BY_COUNT[count];
}

export function labelFor(freq: number): string {
  if (freq >= 1000) {
    const k = freq / 1000;
    return Number.isInteger(k) ? `${k}k` : `${k.toFixed(1).replace(/\.0$/, '')}k`;
  }
  return Number.isInteger(freq) ? `${freq}` : freq.toFixed(1);
}

/* ─────────────────────────────────────────────────────────────
   Presets — defined at 10-band, interpolated for 15/31.
   Curve is interpreted in log-frequency space.
   ───────────────────────────────────────────────────────────── */

export type EQPresetId = 'flat' | 'bassboost' | 'vocal' | 'loudness' | 'rock' | 'custom';

interface PresetSpec {
  label: string;
  bands10: number[];
  preamp?: number;
}

export const EQ_PRESETS: Record<Exclude<EQPresetId, 'custom'>, PresetSpec> = {
  flat:      { label: 'Flat',     bands10: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0], preamp: 0 },
  bassboost: { label: 'Bass',     bands10: [6, 5, 3, 1, 0, 0, 0, 0, 0, 0], preamp: -2 },
  vocal:     { label: 'Vocal',    bands10: [-2, -2, -1, 0, 2, 3, 3, 2, 0, -1], preamp: 0 },
  loudness:  { label: 'Loudness', bands10: [4, 3, 0, 0, -1, -1, 0, 0, 3, 4], preamp: -1 },
  rock:      { label: 'Rock',     bands10: [3, 2, -1, -2, 0, 1, 2, 3, 4, 3], preamp: -2 },
};

/**
 * Interpolate a 10-band preset curve to a different band-count layout
 * by sampling the curve at the target frequencies in log-frequency space.
 */
function sampleCurveAtFreqs(bands10: number[], targetFreqs: number[]): number[] {
  const freqs10 = BANDS_10;
  return targetFreqs.map((f) => {
    if (f <= freqs10[0]) return bands10[0];
    if (f >= freqs10[freqs10.length - 1]) return bands10[freqs10.length - 1];
    for (let i = 0; i < freqs10.length - 1; i++) {
      if (freqs10[i] <= f && f <= freqs10[i + 1]) {
        const t =
          (Math.log(f) - Math.log(freqs10[i])) /
          (Math.log(freqs10[i + 1]) - Math.log(freqs10[i]));
        return bands10[i] + t * (bands10[i + 1] - bands10[i]);
      }
    }
    return 0;
  });
}

/* ─────────────────────────────────────────────────────────────
   State + hook
   ───────────────────────────────────────────────────────────── */

export interface EQState {
  bandCount: BandCount;
  bypass: boolean;
  preamp: number;
  /** Bands for the *currently active* count. Length === bandCount. */
  bands: number[];
  /** Per-band lock state. Length === bandCount. When locked, the AI Enhancer
   *  skips this band so the user's manual value is preserved. */
  locked: boolean[];
  /** Whether the AI Enhancer is actively adjusting bands in real time. */
  aiEnhance: boolean;
  activePreset: EQPresetId;
}

interface PersistedState extends EQState {
  /** Cached bands for the inactive counts so switching is non-destructive. */
  cache: Partial<Record<BandCount, number[]>>;
  /** Cached locks for inactive counts (parallel to cache). */
  lockedCache: Partial<Record<BandCount, boolean[]>>;
}

const STORAGE_KEY = 'av.eq.v2';

function defaultBands(count: BandCount): number[] {
  return new Array(count).fill(0);
}

function defaultLocks(count: BandCount): boolean[] {
  return new Array(count).fill(false);
}

const DEFAULT_STATE: PersistedState = {
  bandCount: 10,
  bypass: false,
  preamp: 0,
  bands: defaultBands(10),
  locked: defaultLocks(10),
  aiEnhance: false,
  activePreset: 'flat',
  cache: {},
  lockedCache: {},
};

function load(): PersistedState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_STATE;
    const parsed = JSON.parse(raw) as Partial<PersistedState>;
    const bandCount = (parsed.bandCount === 15 || parsed.bandCount === 31 ? parsed.bandCount : 10) as BandCount;
    return {
      ...DEFAULT_STATE,
      ...parsed,
      bandCount,
      bands:
        Array.isArray(parsed.bands) && parsed.bands.length === bandCount
          ? parsed.bands
          : defaultBands(bandCount),
      locked:
        Array.isArray(parsed.locked) && parsed.locked.length === bandCount
          ? parsed.locked
          : defaultLocks(bandCount),
      aiEnhance: parsed.aiEnhance ?? false,
      cache: parsed.cache ?? {},
      lockedCache: parsed.lockedCache ?? {},
    };
  } catch {
    return DEFAULT_STATE;
  }
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

export function useEQ() {
  const [state, setState] = useState<PersistedState>(load);

  // Debounce persistence. Slider drags fire setState at ~60 Hz; without the
  // debounce we'd run JSON.stringify (including the band-cache object) and
  // a blocking localStorage write on every tick. 250 ms trailing collapses
  // a drag burst to a single write.
  useEffect(() => {
    const t = window.setTimeout(() => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    }, 250);
    return () => window.clearTimeout(t);
  }, [state]);

  const setBand = useCallback((index: number, value: number) => {
    setState((s) => {
      const next = s.bands.slice();
      next[index] = clamp(value, -12, 12);
      return { ...s, bands: next, activePreset: 'custom' };
    });
  }, []);

  const toggleBandLock = useCallback((index: number) => {
    setState((s) => {
      const next = s.locked.slice();
      next[index] = !next[index];
      return { ...s, locked: next };
    });
  }, []);

  const toggleAiEnhance = useCallback(() => {
    setState((s) => ({ ...s, aiEnhance: !s.aiEnhance }));
  }, []);

  const setPreamp = useCallback((value: number) => {
    setState((s) => ({ ...s, preamp: clamp(value, -12, 12) }));
  }, []);

  const applyPreset = useCallback((id: Exclude<EQPresetId, 'custom'>) => {
    const spec = EQ_PRESETS[id];
    setState((s) => {
      const targetFreqs = frequenciesFor(s.bandCount);
      const bands = s.bandCount === 10 ? spec.bands10.slice() : sampleCurveAtFreqs(spec.bands10, targetFreqs);
      return {
        ...s,
        bands,
        preamp: spec.preamp ?? s.preamp,
        activePreset: id,
      };
    });
  }, []);

  const setBandCount = useCallback((count: BandCount) => {
    setState((s) => {
      if (s.bandCount === count) return s;
      const newCache = { ...s.cache, [s.bandCount]: s.bands };
      const newLockCache = { ...s.lockedCache, [s.bandCount]: s.locked };
      const cached = newCache[count];
      const cachedLocks = newLockCache[count];
      const nextBands = cached && cached.length === count ? cached : defaultBands(count);
      const nextLocks = cachedLocks && cachedLocks.length === count ? cachedLocks : defaultLocks(count);
      return {
        ...s,
        bandCount: count,
        bands: nextBands,
        locked: nextLocks,
        cache: newCache,
        lockedCache: newLockCache,
        activePreset: 'custom',
      };
    });
  }, []);

  const toggleBypass = useCallback(() => {
    setState((s) => ({ ...s, bypass: !s.bypass }));
  }, []);

  const reset = useCallback(() => {
    setState((s) => ({
      ...DEFAULT_STATE,
      bandCount: s.bandCount,
      bands: defaultBands(s.bandCount),
      locked: defaultLocks(s.bandCount),
      aiEnhance: false,
      cache: {},
      lockedCache: {},
    }));
  }, []);

  return {
    state,
    setBand,
    setPreamp,
    applyPreset,
    setBandCount,
    toggleBypass,
    toggleBandLock,
    toggleAiEnhance,
    reset,
  };
}

export type UseEQReturn = ReturnType<typeof useEQ>;

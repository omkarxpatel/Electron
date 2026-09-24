import { useCallback, useEffect, useRef, useState } from 'react';
import { ENHANCE_PROFILES, type EnhanceProfileId } from '../audio/enhanceProfiles';
import type { AiAdaptMode } from '../audio/useAiEnhancer';

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
 * Resample a gain curve from one band layout to another, interpolating in
 * log-frequency space and clamping past either end.
 *
 * Generalized from the 10-band-only version so user presets saved at one
 * band count survive a switch to another — a curve saved at 31 bands and
 * recalled at 10 has to come back as the same shape, not garbage.
 */
function resampleCurve(
  sourceFreqs: number[],
  sourceGains: number[],
  targetFreqs: number[],
): number[] {
  const last = sourceFreqs.length - 1;
  return targetFreqs.map((f) => {
    if (f <= sourceFreqs[0]) return sourceGains[0];
    if (f >= sourceFreqs[last]) return sourceGains[last];
    for (let i = 0; i < last; i++) {
      if (sourceFreqs[i] <= f && f <= sourceFreqs[i + 1]) {
        const t =
          (Math.log(f) - Math.log(sourceFreqs[i])) /
          (Math.log(sourceFreqs[i + 1]) - Math.log(sourceFreqs[i]));
        return sourceGains[i] + t * (sourceGains[i + 1] - sourceGains[i]);
      }
    }
    return 0;
  });
}

function sampleCurveAtFreqs(bands10: number[], targetFreqs: number[]): number[] {
  return resampleCurve(BANDS_10, bands10, targetFreqs);
}

/* ─────────────────────────────────────────────────────────────
   User presets — saved curves, stored separately from the live
   EQ state so a slider drag's debounced write doesn't rewrite
   the whole preset library 4x a second.
   ───────────────────────────────────────────────────────────── */

export interface UserPreset {
  name: string;
  bandCount: BandCount;
  bands: number[];
  preamp: number;
}

const USER_PRESETS_KEY = 'av.eq.userPresets.v1';

function loadUserPresets(): UserPreset[] {
  try {
    const raw = localStorage.getItem(USER_PRESETS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((p): p is UserPreset => {
      if (!p || typeof p !== 'object') return false;
      const c = p as Partial<UserPreset>;
      return (
        typeof c.name === 'string' &&
        Array.isArray(c.bands) &&
        (c.bandCount === 10 || c.bandCount === 15 || c.bandCount === 31) &&
        c.bands.length === c.bandCount &&
        typeof c.preamp === 'number'
      );
    });
  } catch {
    return [];
  }
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
  /** Which target spectrum the AI Enhancer matches toward. 'auto' classifies
   *  the material live; anything else pins that profile. */
  aiProfile: EnhanceProfileId;
  /** How long the AI averages the spectrum over before correcting. 'steady'
   *  estimates the track's long-term balance and settles; 'live' follows the
   *  arrangement. See AiAdaptMode in useAiEnhancer. */
  aiAdapt: AiAdaptMode;
  /** Equal-loudness (Fletcher-Munson) compensation for quiet listening.
   *  Opt-in: it can't be detected, only asserted — see useAiEnhancer. */
  aiLoudnessComp: boolean;
  /** Let the AI drive the effects rack's stereo width and bass exciter.
   *  Reverb stays manual — see the AI_WIDTH_* block in useAiEnhancer. */
  aiEffects: boolean;
  activePreset: EQPresetId;
  /** Name of the user preset currently loaded, or null. Separate from
   *  `activePreset` so the built-in id union doesn't have to grow a case for
   *  every curve the user saves. Cleared by anything that edits the curve. */
  activeUserPreset: string | null;
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
  aiProfile: 'auto',
  aiAdapt: 'steady',
  aiLoudnessComp: false,
  aiEffects: false,
  activePreset: 'flat',
  activeUserPreset: null,
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
      // A profile id persisted by an older build may no longer exist.
      aiProfile:
        parsed.aiProfile === 'auto' ||
        (parsed.aiProfile !== undefined && parsed.aiProfile in ENHANCE_PROFILES)
          ? parsed.aiProfile
          : 'auto',
      aiAdapt: parsed.aiAdapt === 'live' ? 'live' : 'steady',
      aiLoudnessComp: parsed.aiLoudnessComp ?? false,
      aiEffects: parsed.aiEffects ?? false,
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
  const [userPresets, setUserPresets] = useState<UserPreset[]>(loadUserPresets);

  // Saving reads the live curve. Going through a ref keeps the save/apply
  // callbacks stable, so EqPanel's memo isn't invalidated on every drag tick.
  const stateRef = useRef(state);
  stateRef.current = state;
  const userPresetsRef = useRef(userPresets);
  userPresetsRef.current = userPresets;

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
      return { ...s, bands: next, activePreset: 'custom', activeUserPreset: null };
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

  /** Picking a profile also arms the enhancer — choosing a voicing while it's
   *  switched off would otherwise look like it did nothing. */
  const setAiProfile = useCallback((id: EnhanceProfileId) => {
    setState((s) => ({ ...s, aiProfile: id, aiEnhance: true }));
  }, []);

  const setAiAdapt = useCallback((mode: AiAdaptMode) => {
    setState((s) => ({ ...s, aiAdapt: mode, aiEnhance: true }));
  }, []);

  const toggleAiEffects = useCallback(() => {
    setState((s) => ({ ...s, aiEffects: !s.aiEffects, aiEnhance: true }));
  }, []);

  const toggleAiLoudnessComp = useCallback(() => {
    setState((s) => ({ ...s, aiLoudnessComp: !s.aiLoudnessComp }));
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
        activeUserPreset: null,
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
        activeUserPreset: null,
      };
    });
  }, []);

  /** Save the live curve under `name`. Re-saving an existing name overwrites
   *  it — the alternative is silently accumulating "Rock 2", "Rock 3". */
  const saveUserPreset = useCallback((name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const s = stateRef.current;
    const entry: UserPreset = {
      name: trimmed,
      bandCount: s.bandCount,
      bands: s.bands.slice(),
      preamp: s.preamp,
    };
    setUserPresets((prev) => {
      const next = prev.filter((p) => p.name !== trimmed).concat(entry);
      next.sort((a, b) => a.name.localeCompare(b.name));
      localStorage.setItem(USER_PRESETS_KEY, JSON.stringify(next));
      return next;
    });
    setState((cur) => ({ ...cur, activePreset: 'custom', activeUserPreset: trimmed }));
  }, []);

  const applyUserPreset = useCallback((name: string) => {
    const preset = userPresetsRef.current.find((p) => p.name === name);
    if (!preset) return;
    setState((s) => {
      // A preset saved at a different band count is resampled rather than
      // rejected, so curves survive switching layouts.
      const bands =
        preset.bandCount === s.bandCount
          ? preset.bands.slice()
          : resampleCurve(
              frequenciesFor(preset.bandCount),
              preset.bands,
              frequenciesFor(s.bandCount),
            );
      return {
        ...s,
        bands,
        preamp: preset.preamp,
        activePreset: 'custom',
        activeUserPreset: preset.name,
      };
    });
  }, []);

  const deleteUserPreset = useCallback((name: string) => {
    setUserPresets((prev) => {
      const next = prev.filter((p) => p.name !== name);
      localStorage.setItem(USER_PRESETS_KEY, JSON.stringify(next));
      return next;
    });
    setState((s) => (s.activeUserPreset === name ? { ...s, activeUserPreset: null } : s));
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
    userPresets,
    saveUserPreset,
    applyUserPreset,
    deleteUserPreset,
    setBand,
    setPreamp,
    applyPreset,
    setBandCount,
    toggleBypass,
    toggleBandLock,
    toggleAiEnhance,
    setAiProfile,
    setAiAdapt,
    toggleAiEffects,
    toggleAiLoudnessComp,
    reset,
  };
}

export type UseEQReturn = ReturnType<typeof useEQ>;

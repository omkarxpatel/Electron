import { useEffect, useState, useCallback, useMemo } from 'react';

export type PaletteId =
  | 'spotify'
  | 'aurora'
  | 'sunset'
  | 'neon'
  | 'fire'
  | 'ocean'
  | 'mono'
  | 'rainbow'
  | 'cyberpunk'
  | 'pastel'
  | 'magenta'
  | 'ice'
  | 'ember'
  | 'forest'
  | 'candy'
  | 'mono2'
  | 'custom';
export type WaveformStyle = 'ribbon' | 'radial' | 'dots' | 'mirror' | 'bars' | 'line' | 'filled' | 'spectrum' | 'particles' | 'silk' | 'lissajous' | 'crystal' | 'ripples';

/**
 * Per-stage visual tuning.
 *
 * The banner strip (~110px) and the immersive stage (~890px) are different
 * instruments, not one instrument at two sizes. A trail length that reads as
 * elegant smear across 110px reads as soup across 890px; a particle count
 * that fills the strip disappears fullscreen. Every attempt to serve both
 * with a single number ends up compromising both, so each stage carries its
 * own profile and the active one is resolved at render time.
 */
export interface VisualProfile {
  waveformStyle: WaveformStyle;
  glow: number;              // 0..1 — shadow blur strength
  sensitivity: number;       // 0.5..10 — amplitude gain (a trim when autoGain is on)
  autoGain: boolean;         // normalize loudness song-to-song
  spectralPosition: boolean; // lows drive the left, highs the right
  trail: number;             // 0..0.6 — motion blur (alpha decay per frame)
  smoothing: number;         // 0..0.95 — temporal smoothing (higher = calmer)
  barWidth: number;          // 1..12
  barGap: number;            // 0..6
  /** 0.15..2 — multiplier on the auto-computed particle count. */
  particleDensity: number;
  /** 0.3..2.5 — multiplier on particle radius, independent of count. */
  particleSize: number;
  /** 0.05..1 — shared by the two radial styles, meaning slightly different
   *  things in each. For Scope it is the fraction of analyser samples plotted:
   *  the full 2048-point trace draws as a hairball at any real amplitude, and
   *  taking every Nth point after the smoothing pass thins it into readable
   *  curves. For Crystal the figure is a single closed outline either way, so
   *  it sets that outline's resolution — faceted at the low end, smooth at
   *  the high. */
  scopeDensity: number;
  /** 0..2 — brightness of Scope's peripheral corner lighting. A literal
   *  multiplier on the layer's alpha: 0 turns it off entirely, 1 is the
   *  tuned level, and the top of the range is deliberately past it so the
   *  surround can be pushed brighter than the default if that is the look
   *  wanted. Immersive only — four corner glows across the banner strip is a
   *  smear, so the banner ignores it. */
  scopeAmbience: number;
}

/** Which stage a profile applies to. Chosen by canvas geometry, not by the
 *  UI flag, so a resized or windowed stage still picks correctly. */
export type StageKey = 'banner' | 'immersive';

/** Settings that are not per-stage: identity and app-level behavior. The
 *  palette lives here because it drives `--accent` for the entire UI, not
 *  just the canvas — a per-stage palette would re-theme the whole app on
 *  entering fullscreen. */
export interface SharedSettings {
  palette: PaletteId;
  /** Gradient stops for the user-defined 'custom' palette. Always length 3. */
  customColors: [string, string, string];
  /** Override the palette with colors extracted from the current album art. */
  autoTintFromAlbumArt: boolean;
  /** Show the lyrics pane (and the immersive lyric line). */
  showLyrics: boolean;
  /** Blur the current album art behind the visualizer stage. */
  albumArtBackdrop: boolean;
  /** Visuals-only mode — hides chrome, EQ, and side panels. */
  immersive: boolean;
}

export interface Settings extends SharedSettings {
  profiles: Record<StageKey, VisualProfile>;
}

/**
 * A profile flattened onto the shared settings. This is what the render
 * pipeline consumes — the worker, canvas helpers and visualizer components
 * never learn that profiles exist, they just receive a flat object shaped
 * exactly like the old Settings.
 */
export type ResolvedSettings = SharedSettings & VisualProfile;

const BANNER_PROFILE: VisualProfile = {
  waveformStyle: 'ribbon',
  glow: 0.45,
  sensitivity: 1.1,
  autoGain: true,
  spectralPosition: true,
  trail: 0.32,
  smoothing: 0.85,
  barWidth: 4,
  barGap: 2,
  particleDensity: 1,
  particleSize: 1,
  scopeDensity: 0.5,
  scopeAmbience: 1,
};

/** Fullscreen wants calmer defaults: more trail and smoothing read as depth
 *  at size where the banner's settings read as chaos, and the particle field
 *  needs far fewer than a constant-per-area count would give it. */
const IMMERSIVE_PROFILE: VisualProfile = {
  ...BANNER_PROFILE,
  glow: 0.55,
  trail: 0.42,
  smoothing: 0.88,
  particleDensity: 0.45,
  particleSize: 0.85,
  scopeDensity: 0.3,
};

export const DEFAULT_SETTINGS: Settings = {
  palette: 'spotify',
  customColors: ['#7c3aed', '#ec4899', '#f59e0b'],
  autoTintFromAlbumArt: false,
  showLyrics: true,
  albumArtBackdrop: false,
  // Never persisted as `true` — see load(). Immersive is a session mode, not
  // a preference; booting into a chrome-less window with no visible way out
  // is a trap.
  immersive: false,
  profiles: {
    banner: BANNER_PROFILE,
    immersive: IMMERSIVE_PROFILE,
  },
};

const STORAGE_KEY = 'av.settings.v3';
/** Previous flat schema, migrated on first v3 load. */
const LEGACY_KEY = 'av.settings.v2';

/** The only keys a profile may contain. Load-bearing: coerceProfile is fed
 *  raw localStorage and, during migration, an entire legacy flat settings
 *  blob. Spreading that wholesale let SHARED keys (showLyrics, albumArtBackdrop,
 *  autoTintFromAlbumArt) land inside the profile, where resolveSettings'
 *  `{ ...shared, ...profile }` then overrode the live shared value with a
 *  frozen copy — the toggles rendered a stale value and could never change.
 *  Whitelisting also self-heals profiles already polluted in storage. */
const VISUAL_KEYS: readonly (keyof VisualProfile)[] = [
  'waveformStyle',
  'glow',
  'sensitivity',
  'autoGain',
  'spectralPosition',
  'trail',
  'smoothing',
  'barWidth',
  'barGap',
  'particleDensity',
  'particleSize',
  'scopeDensity',
  'scopeAmbience',
];

function coerceProfile(raw: unknown, base: VisualProfile): VisualProfile {
  if (!raw || typeof raw !== 'object') return base;
  const src = raw as Partial<VisualProfile>;
  const out = { ...base };
  for (const k of VISUAL_KEYS) {
    const v = src[k];
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

/** Lift a legacy flat settings blob into the profile shape. The user's
 *  existing tuning seeds BOTH stages rather than only one — they configured
 *  it deliberately, so it shouldn't silently reset for fullscreen; they can
 *  diverge the two afterwards. */
function migrateLegacy(flat: Record<string, unknown>): Settings {
  const visual = coerceProfile(flat, BANNER_PROFILE);
  return {
    ...DEFAULT_SETTINGS,
    palette: (flat.palette as PaletteId) ?? DEFAULT_SETTINGS.palette,
    customColors:
      (flat.customColors as [string, string, string]) ?? DEFAULT_SETTINGS.customColors,
    autoTintFromAlbumArt:
      (flat.autoTintFromAlbumArt as boolean) ?? DEFAULT_SETTINGS.autoTintFromAlbumArt,
    showLyrics: (flat.showLyrics as boolean) ?? DEFAULT_SETTINGS.showLyrics,
    albumArtBackdrop: (flat.albumArtBackdrop as boolean) ?? DEFAULT_SETTINGS.albumArtBackdrop,
    immersive: false,
    profiles: {
      banner: visual,
      immersive: {
        ...visual,
        // The one value that was already split before profiles existed.
        particleDensity:
          typeof flat.particleDensityImmersive === 'number'
            ? flat.particleDensityImmersive
            : IMMERSIVE_PROFILE.particleDensity,
      },
    },
  };
}

function load(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<Settings>;
      const merged: Settings = {
        ...DEFAULT_SETTINGS,
        ...parsed,
        profiles: {
          banner: coerceProfile(parsed.profiles?.banner, BANNER_PROFILE),
          immersive: coerceProfile(parsed.profiles?.immersive, IMMERSIVE_PROFILE),
        },
      };
      if (!Array.isArray(merged.customColors) || merged.customColors.length !== 3) {
        merged.customColors = DEFAULT_SETTINGS.customColors;
      }
      merged.immersive = false;
      return merged;
    }
    const legacy = localStorage.getItem(LEGACY_KEY);
    if (legacy) return migrateLegacy(JSON.parse(legacy) as Record<string, unknown>);
    return DEFAULT_SETTINGS;
  } catch {
    return DEFAULT_SETTINGS;
  }
}

/** Which profile a given stage height should use. Kept here so the UI and
 *  the worker agree on the threshold. Mirrors draw.ts's isLargeStage. */
export function stageKeyForHeight(heightPx: number): StageKey {
  return heightPx >= 330 ? 'immersive' : 'banner';
}

export function resolveSettings(settings: Settings, stage: StageKey): ResolvedSettings {
  const { profiles, ...shared } = settings;
  // Copy only the visual keys rather than spreading the profile wholesale.
  // A profile carrying a stray shared key (a bad migration, hand-edited
  // storage) would otherwise shadow the live value here and the matching
  // control would render stale and refuse to change. Enforcing it at the
  // point of use keeps the invariant local instead of depending on every
  // writer having sanitized first.
  const profile = profiles[stage];
  const out = { ...shared } as unknown as Record<string, unknown>;
  for (const k of VISUAL_KEYS) {
    out[k] = profile[k];
  }
  return out as unknown as ResolvedSettings;
}

export function useSettings() {
  const [settings, setSettings] = useState<Settings>(load);

  // The stage you're editing follows the mode you're looking at.
  const activeStage: StageKey = settings.immersive ? 'immersive' : 'banner';
  const resolved = useMemo(
    () => resolveSettings(settings, activeStage),
    [settings, activeStage],
  );

  // Debounce: sliders drag at ~60 Hz. See useEQ for the same rationale.
  useEffect(() => {
    const t = window.setTimeout(() => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    }, 250);
    return () => window.clearTimeout(t);
  }, [settings]);

  /** Update a shared (non-per-stage) setting. */
  const update = useCallback(<K extends keyof SharedSettings>(key: K, value: SharedSettings[K]) => {
    setSettings((s) => ({ ...s, [key]: value }));
  }, []);

  /** Update a visual setting on whichever stage is currently active. */
  const updateVisual = useCallback(
    <K extends keyof VisualProfile>(key: K, value: VisualProfile[K]) => {
      setSettings((s) => {
        const stage: StageKey = s.immersive ? 'immersive' : 'banner';
        return {
          ...s,
          profiles: { ...s.profiles, [stage]: { ...s.profiles[stage], [key]: value } },
        };
      });
    },
    [],
  );

  /** Reset only the active stage's visuals, leaving the other stage and the
   *  shared settings alone — resetting fullscreen shouldn't wipe the banner. */
  const resetActiveProfile = useCallback(() => {
    setSettings((s) => {
      const stage: StageKey = s.immersive ? 'immersive' : 'banner';
      const base = stage === 'immersive' ? IMMERSIVE_PROFILE : BANNER_PROFILE;
      return { ...s, profiles: { ...s.profiles, [stage]: base } };
    });
  }, []);

  const reset = useCallback(() => setSettings(DEFAULT_SETTINGS), []);

  return { settings, resolved, activeStage, update, updateVisual, reset, resetActiveProfile };
}

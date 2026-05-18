import { useEffect, useState, useCallback } from 'react';

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
  | 'magenta';
export type WaveformStyle = 'ribbon' | 'radial' | 'dots' | 'mirror' | 'bars' | 'line' | 'filled' | 'spectrum' | 'particles' | 'silk';

export interface Settings {
  palette: PaletteId;
  glow: number;          // 0..1 — shadow blur strength
  sensitivity: number;   // 0.5..10 — amplitude gain (acts as trim when autoGain on)
  autoGain: boolean;     // when true, normalize loudness song-to-song; sensitivity acts as a trim
  spectralPosition: boolean; // map low freqs to left, highs to right; each visual reacts to the audio at its position
  trail: number;         // 0..0.6 — motion blur (alpha decay per frame)
  smoothing: number;     // 0..0.95 — temporal smoothing of bar values (higher = calmer)
  waveformStyle: WaveformStyle;
  barWidth: number;      // 1..12
  barGap: number;        // 0..6
}

export const DEFAULT_SETTINGS: Settings = {
  palette: 'spotify',
  glow: 0.45,
  sensitivity: 1.1,
  autoGain: true,
  spectralPosition: true,
  trail: 0.32,
  smoothing: 0.85,
  waveformStyle: 'ribbon',
  barWidth: 4,
  barGap: 2,
};

// Bump this when defaults change in a way that should override user storage.
const STORAGE_KEY = 'av.settings.v2';

function load(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<Settings>;
    return { ...DEFAULT_SETTINGS, ...parsed };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function useSettings() {
  const [settings, setSettings] = useState<Settings>(load);

  // Debounce: settings sliders (glow, sensitivity, trail, smoothing) drag at
  // ~60 Hz. See useEQ for the same rationale.
  useEffect(() => {
    const t = window.setTimeout(() => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    }, 250);
    return () => window.clearTimeout(t);
  }, [settings]);

  const update = useCallback(<K extends keyof Settings>(key: K, value: Settings[K]) => {
    setSettings((s) => ({ ...s, [key]: value }));
  }, []);

  const reset = useCallback(() => setSettings(DEFAULT_SETTINGS), []);

  return { settings, update, reset };
}

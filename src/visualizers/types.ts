import type { ResolvedSettings } from '../state/settings';
import type { QualityKnobs } from '../state/quality';
import type { Palette } from './palettes';

export interface VisualizerProps {
  analyser: AnalyserNode;
  /** Per-channel analysers. Sampled only by stereo styles (Scope, Crystal),
   *  so they stay optional and cost nothing for every other style. */
  analyserL?: AnalyserNode | null;
  analyserR?: AnalyserNode | null;
  settings: ResolvedSettings;
  /** When false, the RAF loop is paused (used when the window is hidden so
   *  we don't burn CPU rendering invisible frames). Defaults to true. */
  active?: boolean;
  /** Synthesized palette from album-art extraction. When non-null, overrides
   *  `settings.palette` in the worker's draw loop. */
  paletteOverride?: Palette | null;
  /** Quality-tier knobs. Omitted means full quality — that's the right default
   *  while the device profile is still resolving, and when there's no bridge
   *  at all. See src/state/quality.ts. */
  quality?: QualityKnobs;
}

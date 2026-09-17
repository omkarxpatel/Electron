import { memo } from 'react';
import { WaveformVisualizer } from '../visualizers';
import type { ResolvedSettings } from '../state/settings';
import type { Palette } from '../visualizers/palettes';

/**
 * The middle "banner" strip between the workspace and the bottom player bar.
 * Pure presentational — wraps existing memo'd children so any App-level
 * re-render skips this subtree.
 *
 * analyserL/analyserR stay threaded through even though nothing reads them
 * today: they carry per-channel time-domain data that the stereo styles need.
 */

interface Props {
  analyser: AnalyserNode;
  analyserL: AnalyserNode | null;
  analyserR: AnalyserNode | null;
  settings: ResolvedSettings;
  active: boolean;
  /** Synthesized palette extracted from the current Spotify track's album
   *  art when "Auto-tint from album art" is on. Null otherwise — the worker
   *  falls back to `PALETTES[settings.palette]`. */
  paletteOverride: Palette | null;
}

export const VisualizerBanner = memo(VisualizerBannerImpl);

function VisualizerBannerImpl({ analyser, analyserL, analyserR, settings, active, paletteOverride }: Props) {
  return (
    <div className="viz-banner">
      <WaveformVisualizer
        analyser={analyser}
        analyserL={analyserL}
        analyserR={analyserR}
        settings={settings}
        active={active}
        paletteOverride={paletteOverride}
      />
    </div>
  );
}

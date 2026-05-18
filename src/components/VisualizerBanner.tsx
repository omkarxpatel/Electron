import { memo } from 'react';
import { AudioStats } from './AudioStats';
import { WaveformVisualizer } from '../visualizers';
import type { Settings } from '../state/settings';

/**
 * The middle "banner" strip between the workspace and the bottom player bar.
 * Visualizer canvas + per-channel audio stats. Pure presentational — wraps
 * existing memo'd children so any App-level re-render skips this subtree.
 */

interface Props {
  analyser: AnalyserNode;
  analyserL: AnalyserNode | null;
  analyserR: AnalyserNode | null;
  settings: Settings;
  active: boolean;
}

export const VisualizerBanner = memo(VisualizerBannerImpl);

function VisualizerBannerImpl({ analyser, analyserL, analyserR, settings, active }: Props) {
  return (
    <div className="viz-banner">
      <WaveformVisualizer analyser={analyser} settings={settings} active={active} />
      <AudioStats analyser={analyser} analyserL={analyserL} analyserR={analyserR} active={active} />
    </div>
  );
}

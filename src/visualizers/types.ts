import type { Settings } from '../state/settings';

export interface VisualizerProps {
  analyser: AnalyserNode;
  settings: Settings;
  /** When false, the RAF loop is paused (used when the window is hidden so
   *  we don't burn CPU rendering invisible frames). Defaults to true. */
  active?: boolean;
}

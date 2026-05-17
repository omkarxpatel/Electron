import { useEffect, useState } from 'react';
import {
  subscribeFrameStats,
  type FrameStatsSnapshot,
} from './frameStats';
import {
  subscribeRenderCounts,
  resetRenderCounts,
  type RenderCountSnapshot,
} from './renderCounts';

/**
 * Diagnostic overlay — toggled via Cmd+Shift+P (or Ctrl+Shift+P on Linux/Win).
 * Renders:
 *   - FPS, average frame time, count of long frames (>50ms) in the last second
 *   - Top components by re-render rate (commits/sec)
 *
 * Hidden by default; zero render cost when closed (component returns null).
 * Subscribers are only attached while visible, so subscribing has no impact
 * on the perf data itself when the overlay isn't open.
 */
export function PerfOverlay() {
  const [open, setOpen] = useState<boolean>(false);
  const [frame, setFrame] = useState<FrameStatsSnapshot>({ fps: 0, frameMs: 0, longFrames: 0 });
  const [renders, setRenders] = useState<RenderCountSnapshot>({ totals: {}, rates: {} });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.shiftKey && (e.key === 'P' || e.key === 'p')) {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (!open) return;
    const unsubFrame = subscribeFrameStats(setFrame);
    const unsubRenders = subscribeRenderCounts(setRenders);
    return () => {
      unsubFrame();
      unsubRenders();
    };
  }, [open]);

  if (!open) return null;

  const topRates = Object.entries(renders.rates)
    .filter(([, rate]) => rate > 0.1)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12);

  const fpsClass = frame.fps >= 55 ? 'ok' : frame.fps >= 40 ? 'warn' : 'bad';
  const longClass = frame.longFrames === 0 ? 'ok' : frame.longFrames < 3 ? 'warn' : 'bad';

  return (
    <div className="perf-overlay" role="status" aria-live="polite">
      <header className="perf-overlay-header">
        <span>perf</span>
        <button
          type="button"
          className="perf-overlay-reset"
          onClick={() => {
            resetRenderCounts();
            setRenders({ totals: {}, rates: {} });
          }}
          title="Reset render counts"
        >
          ↻
        </button>
        <button
          type="button"
          className="perf-overlay-close"
          onClick={() => setOpen(false)}
          aria-label="Close perf overlay"
          title="Close (⌘⇧P)"
        >
          ×
        </button>
      </header>
      <div className="perf-overlay-row">
        <span className="perf-overlay-label">fps</span>
        <span className={`perf-overlay-val perf-overlay-val-${fpsClass}`}>{frame.fps}</span>
        <span className="perf-overlay-label">ms/f</span>
        <span className="perf-overlay-val">{frame.frameMs.toFixed(1)}</span>
        <span className="perf-overlay-label">long</span>
        <span className={`perf-overlay-val perf-overlay-val-${longClass}`}>{frame.longFrames}</span>
      </div>
      <div className="perf-overlay-divider" />
      <div className="perf-overlay-rates">
        <div className="perf-overlay-rates-head">
          <span>component</span>
          <span>rps</span>
          <span>total</span>
        </div>
        {topRates.length === 0 ? (
          <div className="perf-overlay-empty">(no instrumented components)</div>
        ) : (
          topRates.map(([name, rate]) => {
            const cls = rate >= 5 ? 'bad' : rate >= 2 ? 'warn' : 'ok';
            return (
              <div key={name} className="perf-overlay-rate">
                <span className="perf-overlay-rate-name">{name}</span>
                <span className={`perf-overlay-val perf-overlay-val-${cls}`}>
                  {rate.toFixed(1)}
                </span>
                <span className="perf-overlay-rate-total">
                  {renders.totals[name] ?? 0}
                </span>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

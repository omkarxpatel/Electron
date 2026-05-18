import { memo, useEffect, useRef } from 'react';
import { useRenderCount } from '../perf';

interface Props {
  analyser: AnalyserNode | null;
  /** The center frequency of each EQ band slot. */
  bandFreqs: number[];
  /** Per-band gain in dB — used to back-compute the "before" (pre-EQ)
   *  level alongside the measured post-EQ "current" level. */
  bands: number[];
  /** Hex accent color from the active palette. */
  accent: string;
  /** When false, the RAF loop is paused (window hidden). */
  active?: boolean;
}

/**
 * Live FFT energy displayed BEHIND each EQ band slider. Each band shows
 * TWO bars side-by-side:
 *
 *   • current  — post-EQ level (what the analyser is actually measuring),
 *                drawn in accent color
 *   • before   — what the same band's level would be WITHOUT the user's
 *                gain applied (= current ÷ 10^(gain/20)), drawn in
 *                neutral white so it visually reads as "raw signal"
 *
 * A positive band gain makes "before" SHORTER than "current" (you're
 * boosting). A negative cut makes "before" TALLER than "current" (you're
 * removing energy). At 0 dB they match.
 */
export const EqBandActivity = memo(EqBandActivityImpl);

function EqBandActivityImpl({ analyser, bandFreqs, bands, accent, active = true }: Props) {
  useRenderCount('EqBandActivity');
  const containerRef = useRef<HTMLDivElement>(null);
  /* Latest band gains via ref so the RAF loop reads current values
   * without needing the effect to re-run when a slider moves. */
  const bandsRef = useRef(bands);
  bandsRef.current = bands;

  useEffect(() => {
    if (!analyser) return;
    if (!active) return;
    const container = containerRef.current;
    if (!container) return;

    const cells = Array.from(
      container.querySelectorAll<HTMLElement>('.eq-band-activity-cell'),
    );
    if (cells.length === 0) return;

    const freq = new Uint8Array(analyser.frequencyBinCount);
    const sampleRate = analyser.context.sampleRate;
    const nyquist = sampleRate / 2;
    const smoothedCurrent = new Float32Array(bandFreqs.length);
    const smoothedBefore = new Float32Array(bandFreqs.length);

    const minDb = analyser.minDecibels;
    const dbRange = analyser.maxDecibels - analyser.minDecibels;
    // Wider visible window + steeper tilt so quieter content (mids/vocals)
    // still pushes a visible bar even when bass is dominant.
    const VIS_MIN_DB = -72;
    const VIS_MAX_DB = -3;
    const VIS_SPAN_DB = VIS_MAX_DB - VIS_MIN_DB;

    // Precompute per-band FFT bin ranges + tilt — these depend only on the
    // analyser's sample rate / bin count and the band centers, all stable
    // for the engine lifetime. Doing this every frame inside the RAF was
    // wasted log() work.
    const ranges = new Int32Array(bandFreqs.length * 2);
    const tiltDb = new Float32Array(bandFreqs.length);
    for (let i = 0; i < bandFreqs.length; i++) {
      const f = bandFreqs[i];
      const i0 = Math.max(1, Math.floor((f * 0.85 / nyquist) * freq.length));
      const i1 = Math.max(i0 + 1, Math.min(freq.length, Math.ceil((f * 1.18 / nyquist) * freq.length)));
      ranges[i * 2] = i0;
      ranges[i * 2 + 1] = i1;
      tiltDb[i] = Math.log2(Math.max(20, f) / 200) * 3.5;
    }

    // 30 Hz throttle. Activity bars don't need 60 Hz precision — the eye
    // can't distinguish between 33 ms and 16 ms updates on a level meter,
    // and the FFT itself has more inertia than that via smoothing.
    let rafId = 0;
    let last = 0;
    const draw = (now: number) => {
      rafId = requestAnimationFrame(draw);
      if (now - last < 33) return;
      last = now;
      analyser.getByteFrequencyData(freq);
      const currentBands = bandsRef.current;

      for (let i = 0; i < bandFreqs.length; i++) {
        const i0 = ranges[i * 2];
        const i1 = ranges[i * 2 + 1];
        let peak = 0;
        for (let j = i0; j < i1; j++) {
          if (freq[j] > peak) peak = freq[j];
        }

        const peakDb = peak === 0 ? -Infinity : minDb + (peak / 255) * dbRange;
        const currentDb = peakDb + tiltDb[i];
        // Back-compute the un-EQ'd level by subtracting band gain in dB.
        const bandGain = currentBands[i] ?? 0;
        const beforeDb = currentDb - bandGain;

        const currentTarget = isFinite(currentDb)
          ? Math.max(0, Math.min(1, (currentDb - VIS_MIN_DB) / VIS_SPAN_DB))
          : 0;
        const beforeTarget = isFinite(beforeDb)
          ? Math.max(0, Math.min(1, (beforeDb - VIS_MIN_DB) / VIS_SPAN_DB))
          : 0;

        smoothedCurrent[i] =
          currentTarget > smoothedCurrent[i]
            ? currentTarget * 0.7 + smoothedCurrent[i] * 0.3
            : smoothedCurrent[i] * 0.92 + currentTarget * 0.08;
        smoothedBefore[i] =
          beforeTarget > smoothedBefore[i]
            ? beforeTarget * 0.7 + smoothedBefore[i] * 0.3
            : smoothedBefore[i] * 0.92 + beforeTarget * 0.08;

        // 0..0.78 scaleY factor (CSS now consumes transform: scaleY(var)).
        const cur = Math.max(0, Math.min(0.78, smoothedCurrent[i] * 0.75));
        const bef = Math.max(0, Math.min(0.78, smoothedBefore[i] * 0.75));

        cells[i].style.setProperty('--current-h', String(cur));
        cells[i].style.setProperty('--before-h', String(bef));
      }
    };
    rafId = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(rafId);
  }, [analyser, bandFreqs, active]);

  const fill = hexToRgba(accent, 0.55);
  const fillDim = hexToRgba(accent, 0.08);
  const before = 'rgba(255, 255, 255, 0.35)';
  const beforeDim = 'rgba(255, 255, 255, 0.04)';

  return (
    <div
      ref={containerRef}
      className="eq-band-activity"
      aria-hidden
      style={{
        gridTemplateColumns: `repeat(${bandFreqs.length}, minmax(0, 1fr))`,
        ['--activity-fill' as string]: fill,
        ['--activity-fill-dim' as string]: fillDim,
        ['--activity-before' as string]: before,
        ['--activity-before-dim' as string]: beforeDim,
      }}
    >
      {bandFreqs.map((_, i) => (
        <div key={i} className="eq-band-activity-cell">
          <div className="eq-band-activity-current" />
          <div className="eq-band-activity-before" />
        </div>
      ))}
    </div>
  );
}

function hexToRgba(hex: string, alpha: number): string {
  if (/^#[0-9a-f]{6}$/i.test(hex)) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  return `rgba(29, 215, 96, ${alpha})`;
}

import { useEffect, useRef } from 'react';

interface Props {
  analyser: AnalyserNode | null;
  /** The center frequency of each EQ band slot. */
  bandFreqs: number[];
  /** Per-band gain in dB — used to back-compute the "before" (pre-EQ)
   *  level alongside the measured post-EQ "current" level. */
  bands: number[];
  /** Hex accent color from the active palette. */
  accent: string;
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
export function EqBandActivity({ analyser, bandFreqs, bands, accent }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  /* Latest band gains via ref so the RAF loop reads current values
   * without needing the effect to re-run when a slider moves. */
  const bandsRef = useRef(bands);
  bandsRef.current = bands;

  useEffect(() => {
    if (!analyser) return;
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

    let rafId = 0;
    const draw = () => {
      rafId = requestAnimationFrame(draw);
      analyser.getByteFrequencyData(freq);
      const currentBands = bandsRef.current;

      for (let i = 0; i < bandFreqs.length; i++) {
        const f = bandFreqs[i];
        const f0 = f * 0.85;
        const f1 = f * 1.18;
        const i0 = Math.max(1, Math.floor((f0 / nyquist) * freq.length));
        const i1 = Math.max(
          i0 + 1,
          Math.min(freq.length, Math.ceil((f1 / nyquist) * freq.length)),
        );
        let peak = 0;
        for (let j = i0; j < i1; j++) {
          if (freq[j] > peak) peak = freq[j];
        }

        const peakDb = peak === 0 ? -Infinity : minDb + (peak / 255) * dbRange;
        const tiltDb = Math.log2(Math.max(20, f) / 200) * 3.5;
        const currentDb = peakDb + tiltDb;
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

        const curPct = Math.max(0, Math.min(78, smoothedCurrent[i] * 75));
        const befPct = Math.max(0, Math.min(78, smoothedBefore[i] * 75));

        cells[i].style.setProperty('--current-h', `${curPct}%`);
        cells[i].style.setProperty('--before-h', `${befPct}%`);
      }
    };
    draw();
    return () => cancelAnimationFrame(rafId);
  }, [analyser, bandFreqs]);

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

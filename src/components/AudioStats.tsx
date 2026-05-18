import { memo, useEffect, useRef, useState } from 'react';
import { useRenderCount } from '../perf';

interface Props {
  analyser: AnalyserNode | null;
  /** Left-channel analyser for stereo correlation; null if unavailable. */
  analyserL?: AnalyserNode | null;
  /** Right-channel analyser for stereo correlation. */
  analyserR?: AnalyserNode | null;
  /** When false, the RAF analysis loop is paused (window not visible). */
  active?: boolean;
}

const LEVEL_WINDOW = 12;
const COLLAPSE_KEY = 'av.audioStats.collapsed';

export const AudioStats = memo(AudioStatsImpl);

/**
 * AudioStats writes its numeric readouts directly to DOM via refs instead of
 * React state. Previously, the RAF tick called setStats ~12×/sec which
 * triggered a React commit re-rendering all 7 <Stat> children. The pattern
 * here mirrors what SpotifyNowPlaying does with its progress scrubber: the
 * setState is reserved for "structural" UI (collapsed), and per-tick numeric
 * updates write `textContent` directly.
 */
function AudioStatsImpl({ analyser, analyserL, analyserR, active = true }: Props) {
  useRenderCount('AudioStats');
  const [collapsed, setCollapsed] = useState<boolean>(
    () => localStorage.getItem(COLLAPSE_KEY) === 'true',
  );

  // DOM refs for the six numeric readouts. Updated each RAF tick, no setState.
  const levelRef = useRef<HTMLSpanElement>(null);
  const rmsRef = useRef<HTMLSpanElement>(null);
  const peakRef = useRef<HTMLSpanElement>(null);
  const holdRef = useRef<HTMLSpanElement>(null);
  const crestRef = useRef<HTMLSpanElement>(null);
  const stereoRef = useRef<HTMLSpanElement>(null);
  const centroidRef = useRef<HTMLSpanElement>(null);

  // Per-frame analysis state kept in refs so the RAF closure doesn't need to
  // re-mount when something else re-renders this component.
  const peakHoldRef = useRef<number>(-Infinity);
  const rmsHistoryRef = useRef<number[]>([]);

  const toggleCollapsed = () => {
    setCollapsed((c) => {
      const next = !c;
      localStorage.setItem(COLLAPSE_KEY, String(next));
      return next;
    });
  };

  useEffect(() => {
    if (!analyser) {
      // Reset DOM readouts when no source.
      setText(levelRef, '−∞ dB');
      setText(rmsRef, '−∞ dB');
      setText(peakRef, '−∞ dB');
      setText(holdRef, '−∞ dB');
      setText(crestRef, '0.0 dB');
      setText(stereoRef, '—');
      setText(centroidRef, '— Hz');
      peakHoldRef.current = -Infinity;
      rmsHistoryRef.current = [];
      return;
    }
    if (collapsed) return;
    if (!active) return;

    const time = new Uint8Array(analyser.fftSize);
    const freq = new Uint8Array(analyser.frequencyBinCount);
    const sampleRate = analyser.context.sampleRate;
    const nyquist = sampleRate / 2;

    const lBuf = analyserL ? new Float32Array(analyserL.fftSize) : null;
    const rBuf = analyserR ? new Float32Array(analyserR.fftSize) : null;

    let rafId = 0;
    let lastUpdate = 0;

    const tick = (now: number) => {
      rafId = requestAnimationFrame(tick);
      if (now - lastUpdate < 80) return;
      lastUpdate = now;

      analyser.getByteTimeDomainData(time);
      analyser.getByteFrequencyData(freq);

      let sumSq = 0;
      let peakV = 0;
      for (let i = 0; i < time.length; i++) {
        const v = (time[i] - 128) / 128;
        sumSq += v * v;
        const abs = Math.abs(v);
        if (abs > peakV) peakV = abs;
      }
      const rms = Math.sqrt(sumSq / time.length);
      const rmsDb = rms > 0.0001 ? 20 * Math.log10(rms) : -Infinity;
      const peakDb = peakV > 0.0001 ? 20 * Math.log10(peakV) : -Infinity;

      const decayPerTick = 3 * 0.08;
      peakHoldRef.current = isFinite(peakDb)
        ? Math.max(peakDb, peakHoldRef.current - decayPerTick)
        : peakHoldRef.current - decayPerTick;

      const hist = rmsHistoryRef.current;
      hist.push(rms);
      if (hist.length > LEVEL_WINDOW) hist.shift();
      let histSum = 0;
      for (let i = 0; i < hist.length; i++) histSum += hist[i];
      const avgRms = histSum / hist.length;
      const levelDb = avgRms > 0.0001 ? 20 * Math.log10(avgRms) : -Infinity;

      let weightedSum = 0;
      let totalEnergy = 0;
      for (let i = 1; i < freq.length; i++) {
        const mag = freq[i];
        const f = (i / freq.length) * nyquist;
        weightedSum += f * mag;
        totalEnergy += mag;
      }
      const centroidHz = totalEnergy > 0 ? weightedSum / totalEnergy : 0;

      const crestDb = isFinite(peakDb) && isFinite(rmsDb) ? peakDb - rmsDb : 0;

      let stereo = 1;
      if (lBuf && rBuf && analyserL && analyserR) {
        analyserL.getFloatTimeDomainData(lBuf);
        analyserR.getFloatTimeDomainData(rBuf);
        let sLR = 0;
        let sLL = 0;
        let sRR = 0;
        const n = Math.min(lBuf.length, rBuf.length);
        for (let i = 0; i < n; i++) {
          sLR += lBuf[i] * rBuf[i];
          sLL += lBuf[i] * lBuf[i];
          sRR += rBuf[i] * rBuf[i];
        }
        const denom = Math.sqrt(sLL * sRR);
        stereo = denom > 0.000001 ? sLR / denom : 1;
      }

      // Direct DOM writes — no React commit per tick.
      setText(levelRef, fmtDb(levelDb));
      setText(rmsRef, fmtDb(rmsDb));
      setText(peakRef, fmtDb(peakDb));
      setText(holdRef, fmtDb(peakHoldRef.current));
      setText(crestRef, `${crestDb.toFixed(1)} dB`);
      setText(stereoRef, fmtCorrelation(stereo));
      setText(centroidRef, fmtHz(centroidHz));
    };

    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [analyser, analyserL, analyserR, collapsed, active]);

  return (
    <div className={`audio-stats ${collapsed ? 'is-collapsed' : ''}`}>
      {!collapsed && (
        <div className="audio-stats-row">
          <Stat
            label="LEVEL"
            valueRef={levelRef}
            initial="−∞ dB"
            title="Current loudness — 1-second moving-average RMS in dBFS."
          />
          <Stat
            label="RMS"
            valueRef={rmsRef}
            initial="−∞ dB"
            title="Per-frame average loudness in dBFS — faster than LEVEL."
          />
          <Stat
            label="PEAK"
            valueRef={peakRef}
            initial="−∞ dB"
            title="Highest sample amplitude this frame, in dBFS."
          />
          <Stat
            label="HOLD"
            valueRef={holdRef}
            initial="−∞ dB"
            title="Peak with slow decay (~3 dB/sec)."
          />
          <Stat
            label="CREST"
            valueRef={crestRef}
            initial="0.0 dB"
            title="Crest factor = PEAK − RMS. High (>15 dB) = dynamic, low (<6 dB) = heavily compressed / squashed."
          />
          <Stat
            label="STEREO"
            valueRef={stereoRef}
            initial="—"
            title="L/R correlation. +1.00 = mono, ~0 = wide stereo, negative = phase-inverted (problem)."
          />
          <Stat
            label="CENTROID"
            valueRef={centroidRef}
            initial="— Hz"
            title="Where the spectrum's energy is centered. Low = bass-heavy, mid = vocal-forward, high = bright."
          />
        </div>
      )}
      <button
        type="button"
        className="audio-stats-toggle"
        onClick={toggleCollapsed}
        aria-expanded={!collapsed}
        title={collapsed ? 'Show audio stats' : 'Hide audio stats'}
      >
        {collapsed ? '▸' : '×'}
      </button>
    </div>
  );
}

interface StatProps {
  label: string;
  valueRef: React.Ref<HTMLSpanElement>;
  initial: string;
  title: string;
}

function Stat({ label, valueRef, initial, title }: StatProps) {
  return (
    <div className="audio-stat" title={title}>
      <span className="audio-stat-label">{label}</span>
      <span className="audio-stat-value" ref={valueRef}>{initial}</span>
    </div>
  );
}

function setText(ref: React.RefObject<HTMLSpanElement | null>, text: string): void {
  const el = ref.current;
  if (el && el.textContent !== text) el.textContent = text;
}

function fmtDb(db: number): string {
  if (!isFinite(db)) return '−∞ dB';
  return `${db >= 0 ? '+' : ''}${db.toFixed(1)} dB`;
}

function fmtHz(hz: number): string {
  if (hz < 1) return '— Hz';
  if (hz >= 1000) return `${(hz / 1000).toFixed(2)} kHz`;
  return `${Math.round(hz)} Hz`;
}

function fmtCorrelation(c: number): string {
  if (!isFinite(c)) return '—';
  return c >= 0 ? `+${c.toFixed(2)}` : c.toFixed(2);
}

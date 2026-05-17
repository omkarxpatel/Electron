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

interface Stats {
  levelDb: number;
  rmsDb: number;
  peakDb: number;
  peakHoldDb: number;
  centroidHz: number;
  crestDb: number;
  stereo: number;
}

const INITIAL: Stats = {
  levelDb: -Infinity,
  rmsDb: -Infinity,
  peakDb: -Infinity,
  peakHoldDb: -Infinity,
  centroidHz: 0,
  crestDb: 0,
  stereo: 0,
};

const LEVEL_WINDOW = 12;
const COLLAPSE_KEY = 'av.audioStats.collapsed';

export const AudioStats = memo(AudioStatsImpl);

function AudioStatsImpl({ analyser, analyserL, analyserR, active = true }: Props) {
  useRenderCount('AudioStats');
  const [stats, setStats] = useState<Stats>(INITIAL);
  const [collapsed, setCollapsed] = useState<boolean>(
    () => localStorage.getItem(COLLAPSE_KEY) === 'true',
  );
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
      setStats(INITIAL);
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
      const avgRms = hist.reduce((a, b) => a + b, 0) / hist.length;
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

      const crestDb =
        isFinite(peakDb) && isFinite(rmsDb) ? peakDb - rmsDb : 0;

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

      setStats({
        levelDb,
        rmsDb,
        peakDb,
        peakHoldDb: peakHoldRef.current,
        centroidHz,
        crestDb,
        stereo,
      });
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
            value={fmtDb(stats.levelDb)}
            title="Current loudness — 1-second moving-average RMS in dBFS."
          />
          <Stat
            label="RMS"
            value={fmtDb(stats.rmsDb)}
            title="Per-frame average loudness in dBFS — faster than LEVEL."
          />
          <Stat
            label="PEAK"
            value={fmtDb(stats.peakDb)}
            title="Highest sample amplitude this frame, in dBFS."
          />
          <Stat
            label="HOLD"
            value={fmtDb(stats.peakHoldDb)}
            title="Peak with slow decay (~3 dB/sec)."
          />
          <Stat
            label="CREST"
            value={`${stats.crestDb.toFixed(1)} dB`}
            title="Crest factor = PEAK − RMS. High (>15 dB) = dynamic, low (<6 dB) = heavily compressed / squashed."
          />
          <Stat
            label="STEREO"
            value={fmtCorrelation(stats.stereo)}
            title="L/R correlation. +1.00 = mono, ~0 = wide stereo, negative = phase-inverted (problem)."
          />
          <Stat
            label="CENTROID"
            value={fmtHz(stats.centroidHz)}
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

function Stat({ label, value, title }: { label: string; value: string; title: string }) {
  return (
    <div className="audio-stat" title={title}>
      <span className="audio-stat-label">{label}</span>
      <span className="audio-stat-value">{value}</span>
    </div>
  );
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

import { memo, useEffect, useRef, useState } from 'react';

/**
 * Scrolling waveform row for the meter bridge — the CDJ / rekordbox display.
 *
 * Each column is one slice of recent audio: height is level, colour is where
 * the energy sits in the spectrum. Bass columns take the palette accent,
 * treble columns run to white, and mids land in between — the same
 * accent-to-white ramp the OUT ladder uses, so the strip reads as one
 * instrument. Columns are mirrored around the centre line, which is what
 * gives a waveform its shape rather than a bar chart's.
 *
 * ── Why the column metric is what it is ──────────────────────────────────
 *
 * Two earlier versions of this came out as a solid block of colour, and the
 * reason is worth writing down, because it isn't a tuning problem:
 *
 *   1. Peak over the whole analyser buffer. That buffer is ~46 ms, which
 *      almost always contains the loudest moment of whatever beat it landed
 *      in, so every column measured the same thing.
 *   2. RMS over the whole buffer, mapped across a wide dB window. Music's
 *      short-term RMS only moves a few dB, so every column sat near the top
 *      of the window regardless of how wide the window was.
 *
 * What produces shape is measuring a SHORT slice: the newest ~12 ms of the
 * buffer. At that length a column either lands on a transient or in the tail
 * between hits, and the difference is 15-20 dB — so the display gets spikes
 * on the kicks and low columns between them, which is what a waveform is.
 * That variation is real, not synthesised: the display samples 12 ms out of
 * every 45 ms, so it is a sampled view of the audio, not a full render.
 *
 * Other implementation notes:
 *
 *   • Columns advance on a wall-clock interval, not per frame, so the scroll
 *     speed is the same on a 60 Hz and a 120 Hz display.
 *   • Height is a dB span below a running reference, so the shape stays
 *     readable at any absolute level. A linear scale would be a flat line at
 *     normal listening levels (~0.03 of full scale); a fixed dB floor would
 *     go blank whenever the source is quiet.
 *   • The colour ramp is baked into 256 pre-built style strings at setup, so
 *     per-column colouring is an array index rather than string building
 *     sixty times a frame.
 */

interface Props {
  /** Post-EQ mono analyser — read for both level and spectral balance. */
  analyser: AnalyserNode | null;
  /** Active palette accent; the low end of the colour ramp. */
  accent: string;
  /** Paused when the window is hidden. */
  active: boolean;
  height?: number;
}

/** Pixel width of one column. Contiguous, so the result reads as a wave. */
const COL_W = 2;
/** Wall-clock spacing between columns — ~22 columns/sec. Fast enough that a
 *  full-width strip fills in under 10 s from cold, slow enough that the
 *  scroll still reads as a waveform rather than a blur. */
const COL_INTERVAL_MS = 45;
/** Samples measured per column, taken from the newest end of the buffer.
 *  ~12 ms at 44.1 kHz — short enough to tell a transient from a tail. */
const SLICE_SAMPLES = 512;
/** Fraction of the half-height the loudest recent column fills. */
const TARGET_EXTENT = 0.85;
/** Height spans this many dB below the running reference. Columns quieter
 *  than that flatten to the centre line. Chosen by measuring the spread of
 *  column heights on a simulated 120 BPM passage: 20 dB left a dense mix
 *  sitting at 0.6 of full height with little variation (the "solid chunk"),
 *  14 dB puts it at 0.4 with clear beat structure. */
const DYN_RANGE_DB = 14;
/** Display curve on the height, not a measurement: pushes mid-level columns
 *  down so the gap between a transient and the tail after it reads at a
 *  glance. Absolute level is the OUT ladder's job, not this row's. */
const HEIGHT_GAMMA = 1.5;
/** Reference release, in dB per column (~9 dB/sec). Attack is instant. */
const REF_FALL_DB = 0.4;
/** Where the reference starts, and the floor it can fall to. */
const REF_FLOOR_DB = -72;
/** Crossover points for the three bands, in Hz. */
const LOW_HZ = 250;
const HIGH_HZ = 4000;

export const LiveWaveform = memo(LiveWaveformImpl);

function LiveWaveformImpl({ analyser, accent, active, height = 30 }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const faceRef = useRef<HTMLDivElement | null>(null);
  // The bridge is a flex card, so the drawable width isn't known up front and
  // changes with the window. Measured rather than hardcoded, and fed back as
  // state so the draw effect re-allocates its ring buffer on resize.
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const el = faceRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      setWidth(Math.max(0, Math.round(entry.contentRect.width)));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (!active || !analyser || width <= 0) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx.scale(dpr, dpr);

    // Accent → white ramp, resolved through a gradient so whatever CSS colour
    // the palette hands us works without parsing it here.
    const ramp = document.createElement('canvas');
    ramp.width = 256;
    ramp.height = 1;
    const rctx = ramp.getContext('2d');
    const styles: string[] = [];
    if (rctx) {
      const grad = rctx.createLinearGradient(0, 0, 256, 0);
      grad.addColorStop(0, accent);
      grad.addColorStop(1, '#ffffff');
      rctx.fillStyle = grad;
      rctx.fillRect(0, 0, 256, 1);
      const px = rctx.getImageData(0, 0, 256, 1).data;
      for (let i = 0; i < 256; i++) {
        styles.push(`rgb(${px[i * 4]},${px[i * 4 + 1]},${px[i * 4 + 2]})`);
      }
    } else {
      for (let i = 0; i < 256; i++) styles.push(accent);
    }

    const time = new Float32Array(analyser.fftSize);
    const freq = new Uint8Array(analyser.frequencyBinCount);
    const hzPerBin = analyser.context.sampleRate / analyser.fftSize;
    const lowBin = Math.max(1, Math.round(LOW_HZ / hzPerBin));
    const highBin = Math.min(freq.length - 1, Math.round(HIGH_HZ / hzPerBin));
    const sliceStart = Math.max(0, time.length - SLICE_SAMPLES);

    const cols = Math.ceil(width / COL_W);
    const amps = new Float32Array(cols);
    const tones = new Float32Array(cols);
    // Ring buffer head: the newest column, drawn at the right edge.
    let head = 0;
    let filled = 0;
    let refDb = REF_FLOOR_DB;
    let lastCol = 0;
    const mid = height / 2;
    let raf = 0;

    const tick = () => {
      raf = requestAnimationFrame(tick);
      const now = performance.now();
      if (now - lastCol < COL_INTERVAL_MS) return;
      lastCol = now;

      // ── Level for this column: peak of the newest short slice ──
      analyser.getFloatTimeDomainData(time);
      let peak = 0;
      for (let i = sliceStart; i < time.length; i++) {
        const a = Math.abs(time[i]);
        if (a > peak) peak = a;
      }
      const db = peak > 0 ? 20 * Math.log10(peak) : REF_FLOOR_DB;
      // Instant attack, slow fall — the loudest recent column defines full
      // height, so the shape holds at any absolute level.
      refDb = db > refDb ? db : Math.max(db, refDb - REF_FALL_DB, REF_FLOOR_DB);
      const span = (db - (refDb - DYN_RANGE_DB)) / DYN_RANGE_DB;

      // ── Where the energy sits ──
      analyser.getByteFrequencyData(freq);
      let low = 0;
      let midBand = 0;
      let high = 0;
      for (let i = 1; i < lowBin; i++) low += freq[i];
      for (let i = lowBin; i < highBin; i++) midBand += freq[i];
      for (let i = highBin; i < freq.length; i++) high += freq[i];
      // Averaged per band, not summed: the treble band holds roughly ten
      // times as many bins as the bass one, so raw sums read as treble
      // always and the whole display came out white.
      const lowAvg = low / Math.max(1, lowBin - 1);
      const midAvg = midBand / Math.max(1, highBin - lowBin);
      const highAvg = high / Math.max(1, freq.length - highBin);
      const total = lowAvg + midAvg + highAvg;
      // 0 = all bass, 1 = all treble. Mids sit mid-ramp, which is what makes
      // a busy mix read as a gradient rather than two flat colours.
      const tone = total > 0 ? (midAvg * 0.5 + highAvg) / total : 0;

      amps[head] = Math.max(0, Math.min(1, span)) ** HEIGHT_GAMMA * TARGET_EXTENT;
      tones[head] = tone;
      head = (head + 1) % cols;
      if (filled < cols) filled++;

      // ── Redraw ──
      ctx.clearRect(0, 0, width, height);
      for (let i = 0; i < filled; i++) {
        // Walk back from the newest column so the wave scrolls leftward.
        const idx = (head - 1 - i + cols * 2) % cols;
        const h = Math.max(0.6, amps[idx] * mid);
        ctx.fillStyle = styles[Math.round(tones[idx] * 255)] ?? accent;
        ctx.fillRect(width - (i + 1) * COL_W, mid - h, COL_W, h * 2);
      }
    };

    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    };
  }, [analyser, accent, active, width, height]);

  return (
    <div
      className="wavestrip"
      title="Recent audio. Height is level, colour is frequency content — accent for bass through to white for treble."
    >
      <div className="wavestrip-face" ref={faceRef} style={{ height }}>
        <canvas ref={canvasRef} className="wavestrip-canvas" style={{ width, height }} />
      </div>
    </div>
  );
}

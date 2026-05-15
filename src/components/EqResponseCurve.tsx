import { useEffect, useRef } from 'react';
import { combinedResponseDb, logSpacedFrequencies } from '../audio/biquadResponse';

interface Props {
  bands: number[];
  bandFreqs: number[];
  Q: number;
  preamp: number;
  bypass: boolean;
  bassEnhance?: number;
  trebleEnhance?: number;
  /** Hex accent color from the active palette. Threaded through so the
   *  effect can re-run on palette change — getComputedStyle alone won't
   *  trigger a redraw without a dependency change. */
  accent: string;
  /** Used to drive the time-averaged tonal-balance halo drawn behind the
   *  main response curve. Null when no audio source is connected. */
  analyser: AnalyserNode | null;
}

const SAMPLE_COUNT = 320;
const FREQS = logSpacedFrequencies(SAMPLE_COUNT);
/** Visible dB span on each side of zero. With preamp ±12 and per-band ±12,
 *  total signal can reach ±24 — give a little headroom on top of that. */
const DB_RANGE = 24;

const LOG_MIN_BASE = Math.log(20);
const LOG_MAX_BASE = Math.log(20000);
/** Max horizontal pan, in natural-log units. log(2) ≈ one octave each direction. */
const PAN_LIMIT = Math.log(2);
/** Max vertical pan, in dB. The default view shows ±24 dB; we let the user
 *  pan another ±18 dB so a +12 preamp on top of a +12 band boost (= +24 dB)
 *  can be inspected even though it normally sits right at the edge. */
const PAN_DB_LIMIT = 18;

export function EqResponseCurve({
  bands,
  bandFreqs,
  Q,
  preamp,
  bypass,
  bassEnhance = 0,
  trebleEnhance = 0,
  accent,
  analyser,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  /** Pan offset in natural-log frequency units. Mutated by pointer events
   *  and read by draw() — using a ref avoids re-running the draw effect on
   *  every mousemove. */
  const panLogRef = useRef(0);
  /** Vertical pan offset in dB — shifts the visible dB window up/down. */
  const panDbRef = useRef(0);
  /** Stable handle to the latest draw closure so pointer handlers can
   *  trigger redraws without re-installing themselves each prop change. */
  const drawRef = useRef<() => void>(() => {});
  /** Slow-EMA of FFT magnitudes — drives the tonal-balance halo. */
  const tonalRef = useRef<Float32Array | null>(null);
  /** Cached Nyquist frequency for halo y-mapping (sample-rate / 2). */
  const nyquistRef = useRef<number>(24000);

  useEffect(() => {
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext('2d')!;

    let r = 29, g = 215, b = 96;
    if (/^#[0-9a-f]{6}$/i.test(accent)) {
      r = parseInt(accent.slice(1, 3), 16);
      g = parseInt(accent.slice(3, 5), 16);
      b = parseInt(accent.slice(5, 7), 16);
    }
    const accentRgba = (a: number) => `rgba(${r}, ${g}, ${b}, ${a})`;

    const draw = () => {
      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      canvas.width = Math.max(1, rect.width * dpr);
      canvas.height = Math.max(1, rect.height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const w = rect.width;
      const h = rect.height;
      const padLeft = 22;
      const padRight = 6;
      const padTop = 8;
      const padBottom = 18;
      const plotW = w - padLeft - padRight;
      const plotH = h - padTop - padBottom;

      ctx.clearRect(0, 0, w, h);

      // Vertical pan shifts the visible dB window. center=0 by default;
      // pan up means we shift the window so higher dB is visible at the top.
      const visMaxDb = DB_RANGE + panDbRef.current;
      const visMinDb = -DB_RANGE + panDbRef.current;
      const dbToY = (db: number) => padTop + plotH * ((visMaxDb - db) / (2 * DB_RANGE));
      const logMin = LOG_MIN_BASE + panLogRef.current;
      const logMax = LOG_MAX_BASE + panLogRef.current;
      const fToX = (f: number) =>
        padLeft + plotW * ((Math.log(f) - logMin) / (logMax - logMin));

      // ─── horizontal grid lines + dB tick labels on the left.
      // Grid steps adapt to the visible window so labels stay relevant as
      // the user pans vertically.
      ctx.font = '9px -apple-system, system-ui';
      ctx.textBaseline = 'middle';
      const stepStart = Math.ceil(visMinDb / 6) * 6;
      const stepEnd = Math.floor(visMaxDb / 6) * 6;
      for (let db = stepStart; db <= stepEnd; db += 6) {
        const y = dbToY(db);
        ctx.strokeStyle = db === 0 ? 'rgba(255,255,255,0.12)' : 'rgba(255,255,255,0.05)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(padLeft, y);
        ctx.lineTo(w - padRight, y);
        ctx.stroke();

        ctx.textAlign = 'right';
        ctx.fillStyle = db === 0 ? 'rgba(255,255,255,0.5)' : 'rgba(255,255,255,0.3)';
        const label = db > 0 ? `+${db}` : `${db}`;
        ctx.fillText(label, padLeft - 4, y);
      }
      ctx.textBaseline = 'alphabetic';
      const y0 = dbToY(0);

      // ─── frequency labels along the bottom (only on octave markers to avoid clutter)
      const octaveMarkers = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];
      ctx.fillStyle = 'rgba(255,255,255,0.32)';
      ctx.font = '9.5px -apple-system, system-ui';
      ctx.textAlign = 'center';
      for (const f of octaveMarkers) {
        const x = fToX(f);
        if (x < padLeft - 8 || x > w - padRight + 8) continue;
        const label = f >= 1000 ? `${f / 1000}k` : `${f}`;
        ctx.fillText(label, x, h - 4);
      }

      // ─── response sampled across frequency
      const responses: number[] = new Array(SAMPLE_COUNT);
      for (let i = 0; i < SAMPLE_COUNT; i++) {
        responses[i] = bypass
          ? 0
          : combinedResponseDb(
              FREQS[i],
              bands,
              bandFreqs,
              Q,
              preamp,
              bassEnhance,
              trebleEnhance,
            );
      }

      // ─── tonal-balance halo (averaged music spectrum behind the curve)
      const tonal = tonalRef.current;
      if (tonal && !bypass) {
        const nyq = nyquistRef.current;
        // Bottom of plot = 0 energy; max halo height = 75% of plot
        const haloMaxH = plotH * 0.75;
        ctx.fillStyle = 'rgba(255, 255, 255, 0.13)';
        ctx.beginPath();
        ctx.moveTo(fToX(FREQS[0]), padTop + plotH);
        for (let i = 0; i < SAMPLE_COUNT; i++) {
          const f = FREQS[i];
          const binIdx = Math.min(tonal.length - 1, Math.floor((f / nyq) * tonal.length));
          const mag = tonal[binIdx];
          const y = padTop + plotH - mag * haloMaxH;
          ctx.lineTo(fToX(f), y);
        }
        ctx.lineTo(fToX(FREQS[SAMPLE_COUNT - 1]), padTop + plotH);
        ctx.closePath();
        ctx.fill();
      }

      // ─── filled area
      const gradient = ctx.createLinearGradient(0, padTop, 0, padTop + plotH);
      gradient.addColorStop(0, accentRgba(0.42));
      gradient.addColorStop(0.5, accentRgba(0.12));
      gradient.addColorStop(1, accentRgba(0.42));

      ctx.fillStyle = bypass ? 'rgba(255,255,255,0.04)' : gradient;
      ctx.beginPath();
      ctx.moveTo(fToX(FREQS[0]), y0);
      for (let i = 0; i < SAMPLE_COUNT; i++) {
        ctx.lineTo(fToX(FREQS[i]), dbToY(responses[i]));
      }
      ctx.lineTo(fToX(FREQS[SAMPLE_COUNT - 1]), y0);
      ctx.closePath();
      ctx.fill();

      // ─── stroke on top with glow
      ctx.strokeStyle = bypass ? 'rgba(255,255,255,0.25)' : accent;
      ctx.lineWidth = 1.8;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.shadowBlur = bypass ? 0 : 8;
      ctx.shadowColor = accent;
      ctx.beginPath();
      for (let i = 0; i < SAMPLE_COUNT; i++) {
        const x = fToX(FREQS[i]);
        const y = dbToY(responses[i]);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.shadowBlur = 0;

      // ─── band-anchor dots at the user's slider centers
      if (!bypass) {
        ctx.fillStyle = '#ffffff';
        ctx.shadowBlur = 4;
        ctx.shadowColor = accent;
        for (let i = 0; i < bandFreqs.length; i++) {
          const f = bandFreqs[i];
          const dbAtBand = combinedResponseDb(f, bands, bandFreqs, Q, preamp, bassEnhance, trebleEnhance);
          const x = fToX(f);
          const y = dbToY(dbAtBand);
          ctx.beginPath();
          ctx.arc(x, y, 2.2, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.shadowBlur = 0;
      }
    };

    drawRef.current = draw;
    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(canvas);
    return () => ro.disconnect();
  }, [bands, bandFreqs, Q, preamp, bypass, bassEnhance, trebleEnhance, accent]);

  /* Tonal balance halo — slow-EMA over the analyser's frequency data,
   * read at ~10 Hz so the halo represents the recent musical balance
   * rather than instantaneous spectrum. Updates trigger a redraw via the
   * stable drawRef so the existing draw effect doesn't need to re-run. */
  useEffect(() => {
    if (!analyser) {
      tonalRef.current = null;
      drawRef.current();
      return;
    }
    tonalRef.current = new Float32Array(analyser.frequencyBinCount);
    nyquistRef.current = analyser.context.sampleRate / 2;
    const freq = new Uint8Array(analyser.frequencyBinCount);
    const ALPHA = 0.02; // ~5s time constant at 10 Hz updates

    let rafId = 0;
    let lastUpdate = 0;
    const update = (now: number) => {
      rafId = requestAnimationFrame(update);
      if (now - lastUpdate < 100) return;
      lastUpdate = now;
      analyser.getByteFrequencyData(freq);
      const tonal = tonalRef.current;
      if (!tonal) return;
      for (let i = 0; i < freq.length; i++) {
        const norm = freq[i] / 255;
        tonal[i] = tonal[i] * (1 - ALPHA) + norm * ALPHA;
      }
      drawRef.current();
    };
    rafId = requestAnimationFrame(update);
    return () => cancelAnimationFrame(rafId);
  }, [analyser]);

  // Pointer handlers for click-and-drag pan + double-click reset.
  useEffect(() => {
    const canvas = canvasRef.current!;
    let dragging = false;
    let lastX = 0;

    const onPointerDown = (e: PointerEvent) => {
      dragging = true;
      lastX = e.clientX;
      lastY = e.clientY;
      canvas.setPointerCapture(e.pointerId);
    };
    let lastY = 0;
    const onPointerMove = (e: PointerEvent) => {
      if (!dragging) return;
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;
      const rect = canvas.getBoundingClientRect();
      const plotW = Math.max(1, rect.width - 28);
      const plotH = Math.max(1, rect.height - 26);
      // Dragging right pans the view right (higher freqs slide in from the
      // right); in log space that means decreasing logMin offset.
      const dLog = -(dx / plotW) * (LOG_MAX_BASE - LOG_MIN_BASE);
      // Dragging up moves the visible window up — top edge shows higher dB.
      const dDb = (dy / plotH) * (2 * DB_RANGE);
      panLogRef.current = Math.max(-PAN_LIMIT, Math.min(PAN_LIMIT, panLogRef.current + dLog));
      panDbRef.current = Math.max(-PAN_DB_LIMIT, Math.min(PAN_DB_LIMIT, panDbRef.current + dDb));
      drawRef.current();
    };
    const endDrag = (e: PointerEvent) => {
      if (!dragging) return;
      dragging = false;
      try { canvas.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    };
    const onDoubleClick = () => {
      panLogRef.current = 0;
      panDbRef.current = 0;
      drawRef.current();
    };

    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', endDrag);
    canvas.addEventListener('pointercancel', endDrag);
    canvas.addEventListener('dblclick', onDoubleClick);
    return () => {
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', endDrag);
      canvas.removeEventListener('pointercancel', endDrag);
      canvas.removeEventListener('dblclick', onDoubleClick);
    };
  }, []);

  return <canvas ref={canvasRef} className="eq-curve-canvas" title="Drag to pan (horizontal + vertical) • Double-click to reset" />;
}

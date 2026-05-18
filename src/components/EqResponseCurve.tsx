import { memo, useEffect, useMemo, useRef } from 'react';
import { useRenderCount } from '../perf';
import { buildBandCoefs, logSpacedFrequencies, responseCurveDb } from '../audio/biquadResponse';

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
  /** When false, the halo update loop is paused (window hidden). */
  active?: boolean;
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

const PAD_LEFT = 22;
const PAD_RIGHT = 6;
const PAD_TOP = 8;
const PAD_BOTTOM = 18;

export const EqResponseCurve = memo(EqResponseCurveImpl);

/**
 * Rendering is split into THREE concerns:
 *
 *   1. Static-grid offscreen layer — dB lines + dB tick labels + octave-marker
 *      labels along the bottom. Caches per (w, h, dpr, panLog, panDb). During
 *      a slider drag (which doesn't change pan or dimensions) this entire
 *      layer is reused without any new strokes / fills.
 *
 *   2. Tonal halo + filled response area + stroke + dots — dynamic per draw.
 *      Cheap once the static layer is composited.
 *
 *   3. Mounting concerns (canvas size, observer, pointer handlers) — run once
 *      per component lifetime, NOT on every prop change. The old code
 *      reinstalled the ResizeObserver on every band drag.
 */
function EqResponseCurveImpl({
  bands,
  bandFreqs,
  Q,
  preamp,
  bypass,
  bassEnhance = 0,
  trebleEnhance = 0,
  accent,
  analyser,
  active = true,
}: Props) {
  useRenderCount('EqResponseCurve');
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Precompute coefficients once per parameter set. The previous code rebuilt
  // 320 × bandCount coefficient sets per draw — at 31 bands and ~10 Hz halo
  // draws that's ~100k peakingCoefs calls/sec. Now it's 31 per parameter
  // change.
  const coefs = useMemo(
    () => buildBandCoefs(bands, bandFreqs, Q, preamp, bassEnhance, trebleEnhance),
    [bands, bandFreqs, Q, preamp, bassEnhance, trebleEnhance],
  );

  // Refs that the long-lived draw closure reads from. Updated by the
  // "props -> refs" effect below; the draw closure itself never changes
  // identity, so the ResizeObserver and pointer handlers stay installed.
  const coefsRef = useRef(coefs);
  const bandFreqsRef = useRef(bandFreqs);
  const bypassRef = useRef(bypass);
  const accentRef = useRef(accent);
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
  /** Reusable response buffer — was `new Array(SAMPLE_COUNT)` every draw. */
  const responsesRef = useRef<Float32Array>(new Float32Array(SAMPLE_COUNT));
  /** Offscreen canvas for the static grid layer + cache-key string. */
  const gridCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const gridKeyRef = useRef<string>('');

  /* ─────────────────────────────────────────────────────────────
     INSTALL-ONCE effect. Owns the canvas size sync, the long-lived
     draw closure, the ResizeObserver, and the pointer handlers.
     Runs exactly once per component lifetime (deps: empty).
     Reads all dynamic state from refs.
     ───────────────────────────────────────────────────────────── */

  useEffect(() => {
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext('2d')!;
    // Build a hidden grid canvas once; reused across draws.
    if (!gridCanvasRef.current) gridCanvasRef.current = document.createElement('canvas');

    const draw = (): void => {
      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      const targetW = Math.max(1, Math.round(rect.width * dpr));
      const targetH = Math.max(1, Math.round(rect.height * dpr));
      if (canvas.width !== targetW || canvas.height !== targetH) {
        canvas.width = targetW;
        canvas.height = targetH;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      }

      const w = rect.width;
      const h = rect.height;
      const plotW = w - PAD_LEFT - PAD_RIGHT;
      const plotH = h - PAD_TOP - PAD_BOTTOM;
      const bypass = bypassRef.current;
      const accent = accentRef.current;
      const coefSet = coefsRef.current;
      const bandFreqsNow = bandFreqsRef.current;
      const panLog = panLogRef.current;
      const panDb = panDbRef.current;

      ctx.clearRect(0, 0, w, h);

      // Vertical pan shifts the visible dB window. center=0 by default;
      // pan up means we shift the window so higher dB is visible at the top.
      const visMaxDb = DB_RANGE + panDb;
      const visMinDb = -DB_RANGE + panDb;
      const dbToY = (db: number): number =>
        PAD_TOP + plotH * ((visMaxDb - db) / (2 * DB_RANGE));
      const logMin = LOG_MIN_BASE + panLog;
      const logMax = LOG_MAX_BASE + panLog;
      const fToX = (f: number): number =>
        PAD_LEFT + plotW * ((Math.log(f) - logMin) / (logMax - logMin));

      // ─── static grid (composited from cached offscreen canvas) ───
      const gridKey = `${targetW}|${targetH}|${dpr.toFixed(3)}|${panLog.toFixed(4)}|${panDb.toFixed(3)}`;
      const gridCanvas = gridCanvasRef.current!;
      if (gridKey !== gridKeyRef.current) {
        renderStaticGridTo(gridCanvas, targetW, targetH, dpr, w, h, plotH, dbToY, fToX, visMinDb, visMaxDb);
        gridKeyRef.current = gridKey;
      }
      // Composite the grid in CSS-pixel space (drawImage uses our transform).
      ctx.drawImage(gridCanvas, 0, 0, w, h);

      const y0 = dbToY(0);

      // ─── response sampled across frequency ───
      const responses = responsesRef.current;
      for (let i = 0; i < SAMPLE_COUNT; i++) {
        responses[i] = bypass ? 0 : responseCurveDb(FREQS[i], coefSet);
      }

      // ─── tonal-balance halo (averaged music spectrum behind the curve) ───
      // Anchored at dbToY(-DB_RANGE) — the default visible window's bottom —
      // so the halo tracks the y-axis when the user pans vertically. At
      // pan=0 this is the literal plot bottom (same as the old behavior);
      // at any non-zero pan the halo shifts with the rest of the dB axis.
      // Clipped to the plot rect so the halo doesn't bleed past the labels
      // when the user pans hard.
      const tonal = tonalRef.current;
      if (tonal && !bypass) {
        const nyq = nyquistRef.current;
        const haloMaxH = plotH * 0.75;
        const haloBaseY = dbToY(-DB_RANGE);
        ctx.save();
        ctx.beginPath();
        ctx.rect(PAD_LEFT, PAD_TOP, plotW, plotH);
        ctx.clip();
        ctx.fillStyle = 'rgba(255, 255, 255, 0.13)';
        ctx.beginPath();
        ctx.moveTo(fToX(FREQS[0]), haloBaseY);
        for (let i = 0; i < SAMPLE_COUNT; i++) {
          const f = FREQS[i];
          const binIdx = Math.min(tonal.length - 1, Math.floor((f / nyq) * tonal.length));
          const mag = tonal[binIdx];
          const y = haloBaseY - mag * haloMaxH;
          ctx.lineTo(fToX(f), y);
        }
        ctx.lineTo(fToX(FREQS[SAMPLE_COUNT - 1]), haloBaseY);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      }

      // ─── filled area ───
      const accentRgba = parseAccent(accent);
      const gradient = ctx.createLinearGradient(0, PAD_TOP, 0, PAD_TOP + plotH);
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

      // ─── stroke on top with glow ───
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

      // ─── band-anchor dots at the user's slider centers ───
      if (!bypass) {
        ctx.fillStyle = '#ffffff';
        ctx.shadowBlur = 4;
        ctx.shadowColor = accent;
        for (let i = 0; i < bandFreqsNow.length; i++) {
          const f = bandFreqsNow[i];
          const dbAtBand = responseCurveDb(f, coefSet);
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

    // Invalidate the grid cache on resize so it re-renders at the new size.
    const ro = new ResizeObserver(() => {
      gridKeyRef.current = '';
      draw();
    });
    ro.observe(canvas);

    // Pointer handlers — installed once. Pan deltas accumulate inside RAF.
    let dragging = false;
    let lastX = 0;
    let lastY = 0;
    let pendingDLog = 0;
    let pendingDDb = 0;
    let rafPending = false;
    const flushPan = (): void => {
      rafPending = false;
      if (pendingDLog === 0 && pendingDDb === 0) return;
      panLogRef.current = Math.max(-PAN_LIMIT, Math.min(PAN_LIMIT, panLogRef.current + pendingDLog));
      panDbRef.current = Math.max(-PAN_DB_LIMIT, Math.min(PAN_DB_LIMIT, panDbRef.current + pendingDDb));
      pendingDLog = 0;
      pendingDDb = 0;
      drawRef.current();
    };
    const onPointerDown = (e: PointerEvent): void => {
      dragging = true;
      lastX = e.clientX;
      lastY = e.clientY;
      canvas.setPointerCapture(e.pointerId);
    };
    const onPointerMove = (e: PointerEvent): void => {
      if (!dragging) return;
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;
      const rect = canvas.getBoundingClientRect();
      const plotW = Math.max(1, rect.width - 28);
      const plotH = Math.max(1, rect.height - 26);
      pendingDLog += -(dx / plotW) * (LOG_MAX_BASE - LOG_MIN_BASE);
      pendingDDb += (dy / plotH) * (2 * DB_RANGE);
      if (!rafPending) {
        rafPending = true;
        requestAnimationFrame(flushPan);
      }
    };
    const endDrag = (e: PointerEvent): void => {
      if (!dragging) return;
      dragging = false;
      try { canvas.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    };
    const onDoubleClick = (): void => {
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
      ro.disconnect();
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', endDrag);
      canvas.removeEventListener('pointercancel', endDrag);
      canvas.removeEventListener('dblclick', onDoubleClick);
    };
    // Empty deps: this effect installs once. All dynamic data is read from
    // refs that the prop-mirror effect below keeps fresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ─────────────────────────────────────────────────────────────
     PROP-MIRROR effect. Updates refs the install effect's draw
     closure reads from, then triggers a single redraw. Cheap;
     does not reinstall anything.
     ───────────────────────────────────────────────────────────── */

  useEffect(() => {
    coefsRef.current = coefs;
    bandFreqsRef.current = bandFreqs;
    bypassRef.current = bypass;
    accentRef.current = accent;
    drawRef.current();
  }, [coefs, bandFreqs, bypass, accent]);

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
    // When window is hidden, don't spin up the halo RAF — skips the FFT
    // read + EMA work entirely until the user comes back.
    if (!active) return;
    tonalRef.current = new Float32Array(analyser.frequencyBinCount);
    nyquistRef.current = analyser.context.sampleRate / 2;
    const freq = new Uint8Array(analyser.frequencyBinCount);
    const ALPHA = 0.02; // ~5s time constant at 10 Hz updates

    let rafId = 0;
    let lastUpdate = 0;
    const update = (now: number): void => {
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
  }, [analyser, active]);

  return <canvas ref={canvasRef} className="eq-curve-canvas" title="Drag to pan (horizontal + vertical) • Double-click to reset" />;
}

/** Parse "#rrggbb" once, return a fast rgba() formatter. Falls back to
 *  the default Spotify-accent color on parse failure. */
function parseAccent(accent: string): (alpha: number) => string {
  let r = 29, g = 215, b = 96;
  if (/^#[0-9a-f]{6}$/i.test(accent)) {
    r = parseInt(accent.slice(1, 3), 16);
    g = parseInt(accent.slice(3, 5), 16);
    b = parseInt(accent.slice(5, 7), 16);
  }
  return (a) => `rgba(${r}, ${g}, ${b}, ${a})`;
}

/** Render the static grid (dB lines + tick labels + frequency markers) to
 *  the offscreen canvas. Called only when the cache key changes (size, DPR,
 *  or pan offsets). The offscreen canvas is sized in DEVICE pixels and is
 *  composited back into the main ctx in CSS pixels via drawImage. */
function renderStaticGridTo(
  off: HTMLCanvasElement,
  targetW: number,
  targetH: number,
  dpr: number,
  cssW: number,
  cssH: number,
  plotH: number,
  dbToY: (db: number) => number,
  fToX: (f: number) => number,
  visMinDb: number,
  visMaxDb: number,
): void {
  if (off.width !== targetW || off.height !== targetH) {
    off.width = targetW;
    off.height = targetH;
  }
  const ogctx = off.getContext('2d');
  if (!ogctx) return;
  ogctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ogctx.clearRect(0, 0, cssW, cssH);

  // Horizontal dB grid + tick labels.
  ogctx.font = '9px -apple-system, system-ui';
  ogctx.textBaseline = 'middle';
  const stepStart = Math.ceil(visMinDb / 6) * 6;
  const stepEnd = Math.floor(visMaxDb / 6) * 6;
  for (let db = stepStart; db <= stepEnd; db += 6) {
    const y = dbToY(db);
    ogctx.strokeStyle = db === 0 ? 'rgba(255,255,255,0.12)' : 'rgba(255,255,255,0.05)';
    ogctx.lineWidth = 1;
    ogctx.beginPath();
    ogctx.moveTo(PAD_LEFT, y);
    ogctx.lineTo(cssW - PAD_RIGHT, y);
    ogctx.stroke();

    ogctx.textAlign = 'right';
    ogctx.fillStyle = db === 0 ? 'rgba(255,255,255,0.5)' : 'rgba(255,255,255,0.3)';
    const label = db > 0 ? `+${db}` : `${db}`;
    ogctx.fillText(label, PAD_LEFT - 4, y);
  }
  ogctx.textBaseline = 'alphabetic';

  // Vertical frequency labels (octave markers only).
  const octaveMarkers = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];
  ogctx.fillStyle = 'rgba(255,255,255,0.32)';
  ogctx.font = '9.5px -apple-system, system-ui';
  ogctx.textAlign = 'center';
  for (const f of octaveMarkers) {
    const x = fToX(f);
    if (x < PAD_LEFT - 8 || x > cssW - PAD_RIGHT + 8) continue;
    const label = f >= 1000 ? `${f / 1000}k` : `${f}`;
    ogctx.fillText(label, x, cssH - 4);
  }
  // Suppress unused-arg lint for plotH (kept for future use).
  void plotH;
}

import { memo, useEffect, useRef } from 'react';
import { useRenderCount } from '../perf';
import type { Settings } from '../state/settings';
import type { VisualizerProps } from './types';

/**
 * WaveformVisualizer — thin shell that owns the on-screen <canvas>, captures
 * analyser bytes on a lightweight RAF, and offloads the entire per-frame draw
 * loop to a Web Worker via OffscreenCanvas.
 *
 * Transport: postMessage(FRAME) with structured-clone copies of the analyser
 * byte arrays (~4 KB/frame, < 100 µs round-trip).
 *
 * StrictMode handling: React 18 dev intentionally double-mounts effects to
 * catch lifecycle bugs. `transferControlToOffscreen()` is one-shot per
 * canvas, which would throw on the second mount if we naively re-ran setup.
 * We cache the worker per-canvas in a module-scope WeakMap and defer cleanup
 * by a grace window so the immediate remount can reuse the existing worker
 * instead of trying to re-transfer the canvas.
 */
export const WaveformVisualizer = memo(WaveformVisualizerImpl);

interface WorkerBundle {
  worker: Worker;
  analyser: AnalyserNode;
  /** Pending cleanup timer; set on effect-cleanup, cleared on next mount. */
  cleanupTimer: number | null;
  scratchTime: Uint8Array<ArrayBuffer>;
  scratchFreq: Uint8Array<ArrayBuffer>;
}

// Cached per HTMLCanvasElement. WeakMap so entries are GC'd when the canvas
// DOM element is gone (truly unmounted, no remount coming).
const canvasBundles = new WeakMap<HTMLCanvasElement, WorkerBundle>();
const STRICTMODE_GRACE_MS = 500;

function WaveformVisualizerImpl({ analyser, settings, active = true }: VisualizerProps) {
  useRenderCount('WaveformVisualizer');
  // Bumps when the *analyser* changes (which means we need a fresh sample
  // rate / fft size, plus a fresh canvas because transferControlToOffscreen
  // is one-shot). For StrictMode's same-analyser remount, the key stays
  // and the canvas DOM is reused — we handle that case via canvasBundles.
  const analyserKeyRef = useRef<{ analyser: AnalyserNode | null; key: number }>({
    analyser: null,
    key: 0,
  });
  if (analyserKeyRef.current.analyser !== analyser) {
    analyserKeyRef.current = {
      analyser,
      key: analyserKeyRef.current.key + 1,
    };
  }
  const canvasKey = analyserKeyRef.current.key;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const workerRef = useRef<Worker | null>(null);
  const scratchTimeRef = useRef<Uint8Array<ArrayBuffer> | null>(null);
  const scratchFreqRef = useRef<Uint8Array<ArrayBuffer> | null>(null);
  const initedRef = useRef<boolean>(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    initedRef.current = false;

    // Look up an existing bundle for this canvas. Three cases:
    //   1. None → first mount, create everything.
    //   2. Exists, same analyser → StrictMode remount, cancel the deferred
    //      cleanup and reuse the worker / scratch buffers.
    //   3. Exists, different analyser → shouldn't reach here (analyser change
    //      bumps canvasKey → fresh DOM element → no entry), but defend in
    //      depth by tearing down + recreating.
    let bundle = canvasBundles.get(canvas);
    if (bundle && bundle.analyser !== analyser) {
      if (bundle.cleanupTimer !== null) window.clearTimeout(bundle.cleanupTimer);
      bundle.worker.postMessage({ type: 'DESTROY' });
      bundle.worker.terminate();
      canvasBundles.delete(canvas);
      bundle = undefined;
    }

    if (bundle) {
      // Reuse existing bundle.
      if (bundle.cleanupTimer !== null) {
        window.clearTimeout(bundle.cleanupTimer);
        bundle.cleanupTimer = null;
      }
      workerRef.current = bundle.worker;
      scratchTimeRef.current = bundle.scratchTime;
      scratchFreqRef.current = bundle.scratchFreq;
      // Re-apply current settings + size to the (already-inited) worker.
      const rect = canvas.getBoundingClientRect();
      bundle.worker.postMessage({
        type: 'RESIZE',
        dpr: window.devicePixelRatio || 1,
        cssWidth: rect.width,
        cssHeight: rect.height,
      });
      bundle.worker.postMessage({ type: 'SETTINGS', settings });
      bundle.worker.postMessage({ type: 'RESUME' });
      initedRef.current = true;
    } else {
      // Fresh setup.
      const worker = new Worker(new URL('./worker/visualizer.worker.ts', import.meta.url), {
        type: 'module',
      });
      const fftSize = analyser.fftSize;
      const binCount = analyser.frequencyBinCount;
      const scratchTime = new Uint8Array(fftSize);
      const scratchFreq = new Uint8Array(binCount);

      // transferControlToOffscreen is one-shot per canvas. Wrap defensively in
      // case some upstream code path already burned the transfer slot.
      let offscreen: OffscreenCanvas;
      try {
        offscreen = canvas.transferControlToOffscreen();
      } catch (err) {
        console.error('WaveformVisualizer: canvas transfer failed', err);
        worker.terminate();
        return;
      }
      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      worker.postMessage(
        {
          type: 'INIT',
          canvas: offscreen,
          fftSize,
          freqBinCount: binCount,
          sampleRate: analyser.context.sampleRate,
          dpr,
          cssWidth: rect.width,
          cssHeight: rect.height,
          settings,
        },
        [offscreen],
      );

      bundle = {
        worker,
        analyser,
        cleanupTimer: null,
        scratchTime,
        scratchFreq,
      };
      canvasBundles.set(canvas, bundle);
      workerRef.current = worker;
      scratchTimeRef.current = scratchTime;
      scratchFreqRef.current = scratchFreq;
      initedRef.current = true;
    }

    // ResizeObserver lives per-effect-mount; it's cheap to recreate.
    const ro = new ResizeObserver(() => {
      if (!initedRef.current) return;
      const r = canvas.getBoundingClientRect();
      workerRef.current?.postMessage({
        type: 'RESIZE',
        dpr: window.devicePixelRatio || 1,
        cssWidth: r.width,
        cssHeight: r.height,
      });
    });
    ro.observe(canvas);

    return () => {
      ro.disconnect();
      // Defer worker termination. If React StrictMode remounts within the
      // grace window, the next setup will cancel this timer and reuse the
      // existing worker. On a real unmount, the timer fires and we tear down.
      const b = bundle;
      if (b) {
        if (b.cleanupTimer !== null) window.clearTimeout(b.cleanupTimer);
        b.cleanupTimer = window.setTimeout(() => {
          b.worker.postMessage({ type: 'DESTROY' });
          b.worker.terminate();
          canvasBundles.delete(canvas);
        }, STRICTMODE_GRACE_MS);
      }
      workerRef.current = null;
      scratchTimeRef.current = null;
      scratchFreqRef.current = null;
      initedRef.current = false;
    };
    // settings is forwarded via a separate effect; not a setup dep.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [analyser]);

  // Forward settings updates to the worker.
  useEffect(() => {
    if (!initedRef.current) return;
    workerRef.current?.postMessage({ type: 'SETTINGS', settings } satisfies SettingsMsg);
  }, [settings]);

  // Main-thread RAF — read analyser bytes, postMessage FRAME to worker.
  useEffect(() => {
    if (!active) {
      workerRef.current?.postMessage({ type: 'PAUSE' });
      return;
    }
    workerRef.current?.postMessage({ type: 'RESUME' });
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const scratchT = scratchTimeRef.current;
      const scratchF = scratchFreqRef.current;
      const worker = workerRef.current;
      if (!scratchT || !scratchF || !worker) return;
      analyser.getByteTimeDomainData(scratchT);
      analyser.getByteFrequencyData(scratchF);
      worker.postMessage({ type: 'FRAME', time: scratchT, freq: scratchF });
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [analyser, active]);

  return (
    <canvas
      key={canvasKey}
      ref={canvasRef}
      style={{ width: '100%', height: '100%', display: 'block' }}
    />
  );
}

// Tiny local type so the SETTINGS post is type-checked against the worker
// protocol — keeps a stale message shape from silently slipping through.
interface SettingsMsg {
  type: 'SETTINGS';
  settings: Settings;
}

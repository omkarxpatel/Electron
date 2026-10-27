/**
 * Visualizer worker — runs the entire per-frame draw loop off the main thread.
 *
 * Transport: plain postMessage with structured clone. Each main-thread RAF
 * sends a FRAME message containing the two analyser byte arrays. The worker
 * stores them as "current frame" and re-uses them on its own RAF clock —
 * dropped frames are invisible because the visualizer smooths.
 *
 * (Earlier iterations tried SharedArrayBuffer for zero-copy. Electron's
 * renderer doesn't enable SAB by default in dev, and adding the COOP/COEP
 * headers fights with other features. The postMessage path is ~4 KB
 * structured-clone per frame, well under 100 µs — far cheaper than running
 * the entire draw loop on the main thread.)
 *
 * Lifecycle:
 *   1. INIT: { canvas, fftSize, freqBinCount, sampleRate, dpr, cssWidth,
 *      cssHeight, settings }. `canvas` is an OffscreenCanvas transferred
 *      from the main thread.
 *   2. FRAME: { time: Uint8Array, freq: Uint8Array } — 60×/sec while playing.
 *   3. SETTINGS / RESIZE / PAUSE / RESUME / DESTROY — control messages.
 */

import { createDrawState, drawFrame, type DrawState } from './draw';
import { clearGradientCache, type Palette } from '../palettes';
import { setupOffscreenCanvas } from '../canvasUtils';
import type { ResolvedSettings } from '../../state/settings';

type InboundMessage =
  | {
      type: 'INIT';
      canvas: OffscreenCanvas;
      fftSize: number;
      freqBinCount: number;
      sampleRate: number;
      dpr: number;
      cssWidth: number;
      cssHeight: number;
      settings: ResolvedSettings;
      paletteOverride: Palette | null;
    }
  | {
      type: 'FRAME';
      time: Uint8Array;
      freq: Uint8Array;
      /** Present only for stereo styles — see WaveformVisualizer's tick. */
      timeL?: Uint8Array;
      timeR?: Uint8Array;
      seq: number;
    }
  | { type: 'SETTINGS'; settings: ResolvedSettings }
  | { type: 'PALETTE_OVERRIDE'; palette: Palette | null }
  | { type: 'RESIZE'; dpr: number; cssWidth: number; cssHeight: number }
  | { type: 'PAUSE' }
  | { type: 'RESUME' }
  | { type: 'DESTROY' };

interface ReadyMessage { type: 'READY'; seq: number }

/** Sent once when `drawFrame` throws. The host stops the pump on receipt —
 *  see the catch in the FRAME branch for why a silent retry loop was worse
 *  than a stopped visualizer. */
interface FailedMessage { type: 'FAILED'; message: string; stack: string | null }

let canvas: OffscreenCanvas | null = null;
let ctx: OffscreenCanvasRenderingContext2D | null = null;
let sampleRate = 48000;
let settings: ResolvedSettings | null = null;
let paletteOverride: Palette | null = null;
let drawState: DrawState = createDrawState();
let cssWidth = 0;
let cssHeight = 0;
let dpr = 1;
let running = false;
// Re-entry guard: if a FRAME arrives mid-draw (postMessage is async but
// drawFrame is synchronous, so this would only happen if we ever schedule
// async work inside draw) we skip rather than double-draw.
let drawing = false;

self.addEventListener('message', (event: MessageEvent<InboundMessage>) => {
  const msg = event.data;
  switch (msg.type) {
    case 'INIT':
      handleInit(msg);
      break;
    case 'FRAME':
      // Draw directly on FRAME receipt. This keeps the visual cadence
      // perfectly aligned with the audio-analyser cadence on the main
      // thread (no second-RAF phase lag) and ensures every fresh frame is
      // painted exactly once.
      //
      // Backpressure: the main thread only sends the next FRAME after it
      // receives our READY ack. If we're paused or not init'd we still
      // ack so the main thread doesn't deadlock waiting on us.
      if (!running || !ctx || !settings) {
        ack(msg.seq);
        break;
      }
      if (drawing) {
        // Should not happen under correct backpressure, but defend in depth.
        ack(msg.seq);
        break;
      }
      drawing = true;
      try {
        drawFrame(ctx, cssWidth, cssHeight, msg.time, msg.freq, sampleRate, settings, drawState, paletteOverride, msg.timeL, msg.timeR);
      } catch (err) {
        // A throw in here used to be invisible AND permanent. The ack below
        // lives in `finally`, so backpressure stayed satisfied and the main
        // thread kept sending frames that threw again, at the full frame cap,
        // forever — a frozen canvas and a pinned core with nothing logged.
        // React error boundaries cannot help: they do not see worker errors.
        //
        // So: stop drawing, and tell the host once. The host surfaces it and
        // stops the pump. `running` is cleared before the post so a FRAME
        // already in flight takes the paused branch above rather than
        // throwing a second time.
        running = false;
        reportFailure(err);
      } finally {
        drawing = false;
        ack(msg.seq);
      }
      break;
    case 'SETTINGS':
      settings = msg.settings;
      break;
    case 'PALETTE_OVERRIDE':
      paletteOverride = msg.palette;
      // Override changes invalidate any cached gradients keyed on the old
      // palette id — clear so the next frame rebuilds with the new colors.
      if (ctx) clearGradientCache(ctx);
      break;
    case 'RESIZE':
      dpr = msg.dpr;
      cssWidth = msg.cssWidth;
      cssHeight = msg.cssHeight;
      if (canvas && ctx) {
        if (setupOffscreenCanvas(canvas, ctx, cssWidth, cssHeight, dpr)) {
          clearGradientCache(ctx);
        }
      }
      break;
    case 'PAUSE':
      running = false;
      break;
    case 'RESUME':
      running = true;
      break;
    case 'DESTROY':
      running = false;
      canvas = null;
      ctx = null;
      drawState = createDrawState();
      break;
  }
});

/** Report a draw failure to the host. Deliberately tolerant of a non-Error
 *  throw, because the whole point is that this path runs when something
 *  unexpected happened. */
function reportFailure(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error && err.stack ? err.stack : null;
  console.error('visualizer worker: drawFrame threw, stopping', err);
  const msg: FailedMessage = { type: 'FAILED', message, stack };
  (self as unknown as { postMessage(m: unknown): void }).postMessage(msg);
}

function ack(seq: number): void {
  const msg: ReadyMessage = { type: 'READY', seq };
  // `self` inside a dedicated worker module is the worker's global scope;
  // we use the global postMessage to ack each frame. Typed loosely because
  // the default lib doesn't include DedicatedWorkerGlobalScope unless
  // tsconfig opts in to "WebWorker" lib — and we're sharing this file's
  // helpers with the main thread via imports, so a worker-only lib opt-in
  // would be wrong here.
  (self as unknown as { postMessage(m: unknown): void }).postMessage(msg);
}

function handleInit(msg: Extract<InboundMessage, { type: 'INIT' }>): void {
  canvas = msg.canvas;
  const got = canvas.getContext('2d');
  if (!got) {
    console.error('visualizer worker: could not acquire 2D context');
    return;
  }
  ctx = got;
  sampleRate = msg.sampleRate;
  settings = msg.settings;
  paletteOverride = msg.paletteOverride;
  dpr = msg.dpr;
  cssWidth = msg.cssWidth;
  cssHeight = msg.cssHeight;
  setupOffscreenCanvas(canvas, ctx, cssWidth, cssHeight, dpr);
  drawState = createDrawState();
  running = true;
}

export {};

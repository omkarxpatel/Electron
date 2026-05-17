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
import { clearGradientCache } from '../palettes';
import { setupOffscreenCanvas } from '../canvasUtils';
import type { Settings } from '../../state/settings';

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
      settings: Settings;
    }
  | { type: 'FRAME'; time: Uint8Array; freq: Uint8Array }
  | { type: 'SETTINGS'; settings: Settings }
  | { type: 'RESIZE'; dpr: number; cssWidth: number; cssHeight: number }
  | { type: 'PAUSE' }
  | { type: 'RESUME' }
  | { type: 'DESTROY' };

let canvas: OffscreenCanvas | null = null;
let ctx: OffscreenCanvasRenderingContext2D | null = null;
let sampleRate = 48000;
let settings: Settings | null = null;
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
      if (!running || drawing || !ctx || !settings) break;
      drawing = true;
      try {
        drawFrame(ctx, cssWidth, cssHeight, msg.time, msg.freq, sampleRate, settings, drawState);
      } finally {
        drawing = false;
      }
      break;
    case 'SETTINGS':
      settings = msg.settings;
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
  dpr = msg.dpr;
  cssWidth = msg.cssWidth;
  cssHeight = msg.cssHeight;
  setupOffscreenCanvas(canvas, ctx, cssWidth, cssHeight, dpr);
  drawState = createDrawState();
  running = true;
}

export {};

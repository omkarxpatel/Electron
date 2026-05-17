/**
 * Frame-rate / frame-time tracker. RAF-driven, near-zero overhead.
 *
 * Maintains a rolling 60-sample (~1 second) window of inter-frame intervals.
 * Exposes:
 *   - `fps`: averaged frames-per-second
 *   - `frameMs`: average ms between frames
 *   - `longFrames`: count of frames longer than 50 ms in the window (a "long
 *     frame" is anything that would have skipped a 60 Hz vsync — these are
 *     the perceptible hitches the user reports)
 *
 * Pure DOM (no React). Subscribe via `subscribeFrameStats(callback)`. Throttles
 * notifications to 4 Hz so subscribers don't re-render every frame.
 */

export interface FrameStatsSnapshot {
  fps: number;
  frameMs: number;
  longFrames: number;
}

type Subscriber = (snapshot: FrameStatsSnapshot) => void;

const WINDOW = 60; // ~1 second at 60Hz
const LONG_FRAME_MS = 50; // anything over 3 vsync intervals = perceptible hitch
const NOTIFY_INTERVAL_MS = 250; // 4 Hz subscriber notifications

const samples = new Float32Array(WINDOW);
let sampleIdx = 0;
let sampleCount = 0;
let prevTime = 0;
let rafId: number | null = null;
let lastNotify = 0;
const subscribers = new Set<Subscriber>();

function loop(time: number): void {
  if (prevTime > 0) {
    const dt = time - prevTime;
    samples[sampleIdx] = dt;
    sampleIdx = (sampleIdx + 1) % WINDOW;
    if (sampleCount < WINDOW) sampleCount++;
  }
  prevTime = time;

  if (time - lastNotify >= NOTIFY_INTERVAL_MS && subscribers.size > 0) {
    lastNotify = time;
    const snap = computeSnapshot();
    for (const cb of subscribers) cb(snap);
  }

  rafId = requestAnimationFrame(loop);
}

function computeSnapshot(): FrameStatsSnapshot {
  if (sampleCount === 0) return { fps: 0, frameMs: 0, longFrames: 0 };
  let sum = 0;
  let long = 0;
  for (let i = 0; i < sampleCount; i++) {
    const v = samples[i];
    sum += v;
    if (v > LONG_FRAME_MS) long++;
  }
  const avg = sum / sampleCount;
  return {
    fps: avg > 0 ? Math.round(1000 / avg) : 0,
    frameMs: Math.round(avg * 10) / 10,
    longFrames: long,
  };
}

export function subscribeFrameStats(cb: Subscriber): () => void {
  subscribers.add(cb);
  if (rafId === null) {
    rafId = requestAnimationFrame(loop);
  }
  return () => {
    subscribers.delete(cb);
    if (subscribers.size === 0 && rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
      prevTime = 0;
      sampleCount = 0;
      sampleIdx = 0;
    }
  };
}

export function getFrameStatsSnapshot(): FrameStatsSnapshot {
  return computeSnapshot();
}

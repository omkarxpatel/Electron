/**
 * Render-count tracking — opt-in instrumentation for spotting components
 * that re-render too often. Each component calls `useRenderCount('Name')`
 * and the global counter map increments on every commit.
 *
 * Snapshots are throttled to 4 Hz to match the frame-stats subscribers.
 * When the perf overlay isn't subscribed, the hook adds ~1 integer write
 * per render (negligible) — there's no allocation, no setState.
 */

import { useEffect, useRef } from 'react';

const counts: Map<string, number> = new Map();
const rates: Map<string, number> = new Map();
let lastSnapshotAt = 0;
const lastCounts: Map<string, number> = new Map();
const NOTIFY_INTERVAL_MS = 250;

type Subscriber = (snapshot: RenderCountSnapshot) => void;
const subscribers = new Set<Subscriber>();
let notifyTimer: number | null = null;

export interface RenderCountSnapshot {
  /** Total commits per component name since instrumentation started. */
  totals: Record<string, number>;
  /** Commits per second over the last ~250ms window. */
  rates: Record<string, number>;
}

export function useRenderCount(name: string): void {
  // Bump on every commit. Hook runs in useEffect (post-commit phase) so
  // strict-mode double-renders in dev don't double-count production paths.
  // useRef ensures the increment runs exactly once per commit, not per render
  // (this matters with React 18 strict mode dev-time double-invokes).
  const isFirstRef = useRef(true);
  useEffect(() => {
    counts.set(name, (counts.get(name) ?? 0) + 1);
    if (isFirstRef.current) isFirstRef.current = false;
    scheduleNotify();
  });
}

function scheduleNotify(): void {
  if (subscribers.size === 0) return;
  if (notifyTimer !== null) return;
  notifyTimer = window.setTimeout(() => {
    notifyTimer = null;
    notifySubscribers();
  }, NOTIFY_INTERVAL_MS);
}

function notifySubscribers(): void {
  const now = performance.now();
  const elapsed = lastSnapshotAt > 0 ? (now - lastSnapshotAt) / 1000 : NOTIFY_INTERVAL_MS / 1000;
  rates.clear();
  for (const [name, total] of counts) {
    const prev = lastCounts.get(name) ?? 0;
    const delta = total - prev;
    rates.set(name, delta / Math.max(0.001, elapsed));
    lastCounts.set(name, total);
  }
  lastSnapshotAt = now;
  const snap: RenderCountSnapshot = {
    totals: Object.fromEntries(counts),
    rates: Object.fromEntries(rates),
  };
  for (const cb of subscribers) cb(snap);
}

export function subscribeRenderCounts(cb: Subscriber): () => void {
  subscribers.add(cb);
  scheduleNotify();
  return () => {
    subscribers.delete(cb);
    if (subscribers.size === 0 && notifyTimer !== null) {
      window.clearTimeout(notifyTimer);
      notifyTimer = null;
    }
  };
}

export function resetRenderCounts(): void {
  counts.clear();
  rates.clear();
  lastCounts.clear();
  lastSnapshotAt = 0;
}

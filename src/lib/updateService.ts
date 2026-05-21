import { useEffect, useSyncExternalStore } from 'react';
import type { UpdateState } from '../types/api';

/**
 * Renderer-side mirror of the main-process update state machine.
 *
 * State is owned by main (electron/updater.ts) — the source of truth for
 * version, download progress, error categorization, etc. This module is a
 * thin store + React hook on top of the IPC bridge:
 *
 *   - Initial hydration via sync IPC (`getInitialState`) so the UI mounts
 *     with the correct kind right away instead of flashing 'idle' for one
 *     frame.
 *   - Subsequent updates pushed via the `update:state` IPC channel.
 *   - Actions (check / download / install / openFallback / dismissVersion)
 *     forwarded to main; we don't optimistically mutate local state because
 *     main always echoes the new state back.
 *
 * The store is a singleton so multiple components (UpdateBanner + Settings
 * About) share one subscription. We use useSyncExternalStore so React's
 * concurrent rendering doesn't tear the value during transitions.
 *
 * Per-version dismissal is delegated to main; we just call dismissVersion()
 * which suppresses re-prompting for that exact version until a newer one
 * appears. The main module remembers it for the process lifetime.
 */

type Listener = () => void;

let state: UpdateState = readInitialState();
const listeners = new Set<Listener>();
let subscribed = false;

function readInitialState(): UpdateState {
  // window.api may be undefined in unit tests; fall back to idle.
  if (typeof window === 'undefined' || !window.api?.update) return { kind: 'idle' };
  try {
    const initial = window.api.update.getInitialState();
    return initial ?? { kind: 'idle' };
  } catch {
    return { kind: 'idle' };
  }
}

function emit(): void {
  for (const l of listeners) l();
}

function ensureSubscribed(): void {
  if (subscribed) return;
  if (typeof window === 'undefined' || !window.api?.update) return;
  subscribed = true;
  window.api.update.onState((next) => {
    state = next;
    emit();
  });
}

// ── Public actions ─────────────────────────────────────────────────────────

export async function checkForUpdate(): Promise<void> {
  await window.api.update.check();
}

export async function downloadUpdate(): Promise<void> {
  await window.api.update.download();
}

export async function installUpdate(): Promise<void> {
  await window.api.update.install();
}

export async function openReleasePage(url?: string): Promise<void> {
  await window.api.update.openFallback(url);
}

export async function dismissVersion(version: string): Promise<void> {
  await window.api.update.dismissVersion(version);
}

// ── React subscription ────────────────────────────────────────────────────

function subscribe(listener: Listener): () => void {
  ensureSubscribed();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): UpdateState {
  ensureSubscribed();
  return state;
}

/** React hook returning the current update state. Re-renders subscribing
 *  components on every state push from main. */
export function useUpdateState(): UpdateState {
  return useSyncExternalStore(subscribe, getSnapshot);
}

/** Imperative read for non-React callers. */
export function getUpdateState(): UpdateState {
  return state;
}

// ── Convenience: subscribe to one specific transition ─────────────────────

/** Run `handler` once whenever the state transitions to `kind`. Used by
 *  e.g. the UpdateBanner to fire a system notification when a download
 *  completes, without coupling that side effect to a React effect. */
export function useUpdateStateTransition(
  kind: UpdateState['kind'],
  handler: (state: UpdateState) => void,
): void {
  useEffect(() => {
    let lastKind: UpdateState['kind'] | null = null;
    const unsubscribe = subscribe(() => {
      if (state.kind === kind && lastKind !== kind) {
        handler(state);
      }
      lastKind = state.kind;
    });
    return unsubscribe;
  }, [kind, handler]);
}

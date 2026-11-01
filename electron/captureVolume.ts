/**
 * How far the macOS volume slider has turned down the device we record.
 *
 * System output goes into BlackHole so the app can capture it, and the slider
 * only reaches the default output device, which is BlackHole. Its attenuation
 * is real (measured: -11.97 dB back at a -12.0 dB setting) and it happens
 * BEFORE we hear anything, so every visual and measurement in the app used to
 * see the music turned down by the slider: 32 dB at 50%. The visualizer and
 * the EQ's activity bars shrank with the volume, and the loudness tap recorded
 * where the slider was rather than how loud the track is.
 *
 * deviceVolume.ts explains why the SOUND must not compensate for that: the
 * slider is the user's volume control, and cancelling it would connect it to
 * nothing. This is the other half. The measuring side does compensate, so what
 * the app shows and measures is the music, at any volume. The renderer applies
 * it on branches with no path to the destination.
 *
 * `avvolume watch` streams one JSON line per change. Closing its stdin stops
 * it, and so does this process dying, however it dies.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { helperPath } from './deviceVolume';

export type CaptureVolumeState =
  | { kind: 'idle' }
  /** A loopback device whose output volume lands before we capture it. `db`
   *  is the HAL's own reading, 0 at full volume and negative below it. */
  | { kind: 'tracking'; deviceName: string; db: number }
  /** Nothing to add back: a microphone, a device with no volume control, or
   *  a helper that could not say. The renderer treats it exactly like idle. */
  | { kind: 'untracked'; deviceName: string; reason: string };

interface WatchLine {
  name?: string;
  loopback?: boolean;
  db?: number | null;
  gone?: boolean;
  error?: string;
}

let state: CaptureVolumeState = { kind: 'idle' };
let listener: ((state: CaptureVolumeState) => void) | null = null;
let watcher: ChildProcess | null = null;

function setState(next: CaptureVolumeState): void {
  state = next;
  listener?.(next);
}

export function onCaptureVolumeChange(handler: (state: CaptureVolumeState) => void): void {
  listener = handler;
}

/** Starts watching the input with this enumerateDevices() label, replacing
 *  any watch already running. Null stops watching. */
export function watchCaptureVolume(deviceLabel: string | null): void {
  stopCaptureVolumeWatch();
  if (!deviceLabel) {
    setState({ kind: 'idle' });
    return;
  }

  const child = spawn(helperPath(), ['watch', deviceLabel], { stdio: ['pipe', 'pipe', 'ignore'] });
  watcher = child;
  let buffer = '';
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    buffer += chunk;
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      // A superseded watcher can still flush a line or two on its way out,
      // and those belong to a device the renderer has moved off.
      if (watcher === child) handleLine(deviceLabel, line);
      newline = buffer.indexOf('\n');
    }
  });
  child.on('error', (err) => {
    if (watcher !== child) return;
    watcher = null;
    setState({ kind: 'untracked', deviceName: deviceLabel, reason: err.message });
  });
  child.on('exit', () => {
    if (watcher !== child) return;
    watcher = null;
    // A reading nobody is updating any more would go stale the moment the
    // slider moves, and a stale one over-boosts everything it touches.
    if (state.kind === 'tracking') {
      setState({ kind: 'untracked', deviceName: state.deviceName, reason: 'the watcher stopped' });
    }
  });
}

function handleLine(deviceLabel: string, raw: string): void {
  let line: WatchLine;
  try {
    line = JSON.parse(raw) as WatchLine;
  } catch {
    return;
  }
  const deviceName = typeof line.name === 'string' ? line.name : deviceLabel;
  if (typeof line.error === 'string') {
    setState({ kind: 'untracked', deviceName, reason: line.error });
  } else if (line.gone) {
    setState({ kind: 'untracked', deviceName, reason: 'the device went away' });
  } else if (line.loopback !== true) {
    // A microphone's volume, or an output's, says nothing about what reaches
    // us, so there is nothing honest to add back.
    setState({ kind: 'untracked', deviceName, reason: 'not a loopback device' });
  } else if (typeof line.db !== 'number' || !Number.isFinite(line.db)) {
    setState({ kind: 'untracked', deviceName, reason: 'it reports no volume in dB' });
  } else {
    setState({ kind: 'tracking', deviceName, db: line.db });
  }
}

export function stopCaptureVolumeWatch(): void {
  const child = watcher;
  watcher = null;
  if (!child) return;
  // Closing stdin is the helper's stop signal; the kill is the backstop.
  child.stdin?.end();
  child.kill();
}

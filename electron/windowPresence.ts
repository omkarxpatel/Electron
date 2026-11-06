/**
 * Whether anyone can see the main window, so the renderer can stop drawing
 * for nobody.
 *
 * The renderer's only signal used to be document.visibilityState, and on
 * macOS that turns 'hidden' only when the window is minimised or hidden.
 * Electron disables Chromium's occlusion detection (--disable-features=
 * MacWebContentsOcclusion), and an enable switch cannot override it: tested
 * on Electron 33, the child processes still carry the disable. So a window
 * covered by other apps, on another Space or behind a full-screen app stayed
 * "visible" and kept every loop drawing at the display's 120 Hz. Measured on a
 * real session with the window off screen: renderer ~113% and GPU process
 * ~120%, about 2.3 cores for a window nobody was looking at.
 *
 * Main can work it out. Focus, visibility and minimising come from the
 * window's own events, a locked screen from powerMonitor, and covering from
 * the window server, asked by build/helpers/avwindow. That helper only runs
 * while the window is shown but unfocused, the one state where the answer
 * depends on what other apps are doing.
 */

import { powerMonitor, type BrowserWindow } from 'electron';
import { spawn, type ChildProcess } from 'node:child_process';
import { helperPath } from './deviceVolume';

export type AwayReason = 'hidden' | 'minimized' | 'covered' | 'not-on-screen' | 'locked';

export type WindowPresence =
  | { kind: 'focused' }
  /** On screen, but another app has focus. */
  | { kind: 'background' }
  | { kind: 'away'; reason: AwayReason };

let presence: WindowPresence = { kind: 'focused' };
let listener: ((presence: WindowPresence) => void) | null = null;
let tracked: BrowserWindow | null = null;
let watcher: ChildProcess | null = null;
/** The window server's verdict. Only meaningful while the watcher runs. */
let occluded: 'covered' | 'not-on-screen' | null = null;
/** Set when the helper is missing or dies on its own. A watcher that cannot
 *  start would otherwise be respawned on every focus change, so it is given
 *  up for the session and presence falls back to the window's own events,
 *  which can only ever err towards drawing. */
let watcherBroken = false;
let screenLocked = false;
let powerHooked = false;

export function getWindowPresence(): WindowPresence {
  return presence;
}

export function onWindowPresenceChange(handler: (presence: WindowPresence) => void): void {
  listener = handler;
}

function samePresence(a: WindowPresence, b: WindowPresence): boolean {
  return a.kind === b.kind && (a.kind !== 'away' || (b.kind === 'away' && a.reason === b.reason));
}

function update(): void {
  const win = tracked;
  if (!win || win.isDestroyed()) return;
  const visible = win.isVisible() && !win.isMinimized();
  if (!screenLocked && visible && !win.isFocused()) startWatcher(win);
  else stopWatcher();

  const next: WindowPresence = screenLocked
    ? { kind: 'away', reason: 'locked' }
    : !win.isVisible()
      ? { kind: 'away', reason: 'hidden' }
      : win.isMinimized()
        ? { kind: 'away', reason: 'minimized' }
        : win.isFocused()
          ? { kind: 'focused' }
          : occluded
            ? { kind: 'away', reason: occluded }
            : { kind: 'background' };
  if (samePresence(next, presence)) return;
  presence = next;
  listener?.(next);
}

/** Starts following this window. Safe to call again for a recreated window. */
export function trackWindowPresence(win: BrowserWindow): void {
  stopWatcher();
  tracked = win;
  win.on('focus', update);
  win.on('blur', update);
  win.on('show', update);
  win.on('hide', update);
  win.on('minimize', update);
  win.on('restore', update);
  win.on('closed', () => {
    if (tracked === win) tracked = null;
    stopWatcher();
  });
  if (!powerHooked) {
    powerHooked = true;
    powerMonitor.on('lock-screen', () => {
      screenLocked = true;
      update();
    });
    powerMonitor.on('unlock-screen', () => {
      screenLocked = false;
      update();
    });
  }
  update();
}

function startWatcher(win: BrowserWindow): void {
  if (watcher || watcherBroken) return;
  // "window:<CGWindowID>:0" on macOS: the number the window server knows the
  // window by. Without one there is nothing to ask, and staying in the
  // background state is the safe side of that.
  const number = Number(win.getMediaSourceId().split(':')[1]);
  if (!Number.isInteger(number) || number <= 0) return;

  const child = spawn(helperPath('avwindow'), ['watch', String(number), String(process.pid)], {
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  watcher = child;
  let buffer = '';
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    buffer += chunk;
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf('\n');
      if (watcher !== child) continue;
      let verdict: { visible?: unknown; reason?: unknown };
      try {
        verdict = JSON.parse(line) as { visible?: unknown; reason?: unknown };
      } catch {
        continue;
      }
      const next =
        verdict.visible === false && (verdict.reason === 'covered' || verdict.reason === 'not-on-screen')
          ? verdict.reason
          : null;
      if (next !== occluded) {
        occluded = next;
        update();
      }
    }
  });
  const unexpected = (): void => {
    if (watcher !== child) return;
    watcher = null;
    watcherBroken = true;
    if (occluded) {
      occluded = null;
      update();
    }
  };
  child.on('error', unexpected);
  child.on('exit', unexpected);
}

export function stopWindowPresenceWatch(): void {
  stopWatcher();
}

function stopWatcher(): void {
  const child = watcher;
  watcher = null;
  occluded = null;
  if (!child) return;
  // Closing stdin is the helper's stop signal; the kill is the backstop.
  child.stdin?.end();
  child.kill();
}

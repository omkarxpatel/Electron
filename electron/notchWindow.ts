/**
 * The notch HUD — a music panel that hangs from the MacBook notch and stays
 * on screen while you're in another app.
 *
 * It owns no Spotify session. The main renderer owns that, and pushes state up
 * here exactly the way `TrayBridge` already feeds the menu bar; commands flow
 * back down the same way. That is not an arbitrary choice — see the throttling
 * note on `pushState` for why the renderer cannot be trusted to animate
 * anything while it's occluded.
 */

import { BrowserWindow, ipcMain, screen, type Display } from 'electron';
import path from 'node:path';

// ── Contract with the renderer (mirrored in src/types/api.d.ts) ────────────

export interface NotchLyricLine {
  /** Seconds from track start. */
  time: number;
  text: string;
}

export interface NotchMetrics {
  /** Height of the menu-bar band on the display hosting the HUD, in points. */
  menuBarHeight: number;
}

export interface NotchState {
  title: string;
  artist: string;
  artUrl: string | null;
  /** Hex accent sampled from the album art, or null to use the default.
   *  Null whenever "auto-tint from album art" is off — the HUD follows that
   *  setting rather than having one of its own. */
  accent: string | null;
  /** Second, cooler album colour. Gives the ambient wash somewhere to travel
   *  to; a one-colour gradient reads as a flat vignette. */
  ambient: string | null;
  isPlaying: boolean;
  progressMs: number;
  durationMs: number;
  shuffle: boolean;
  /** null while the saved-state lookup is still in flight. */
  saved: boolean | null;
  /** Whole synced lyric track, pushed once per song. The notch does its own
   *  line timing — see pushState. */
  lyrics: NotchLyricLine[] | null;
}

export type NotchCommand =
  /** Clicking the panel itself (not a control) brings the app forward. */
  | { kind: 'activate' }
  | { kind: 'toggle' }
  | { kind: 'next' }
  | { kind: 'previous' }
  | { kind: 'shuffle' }
  | { kind: 'save' }
  | { kind: 'seek'; ms: number };

// ── Geometry ───────────────────────────────────────────────────────────────

/** Expanded panel size. The window is ALWAYS this big and mostly transparent;
 *  it never resizes. Resizing per hover made the expand animation stutter,
 *  because the CSS transition and the window resize are driven by two
 *  different clocks and the window's is not vsync-aligned. */
/**
 * Window size, which is deliberately LARGER than the visible panel: the panel
 * is 580x188 and the remainder is transparent margin for its drop shadow,
 * which has nowhere to draw if the panel fills the window edge to edge.
 */
const PANEL_W = 600;
const PANEL_H = 212;

/** Width of the hover target over the notch. Must stay >= the idle pill's
 *  width in notch.css, or part of the visible pill doesn't respond to hover.
 *
 *  Deliberately wider than any real notch: Electron cannot read the notch's
 *  width at all (`Display` has no such field, and `env(safe-area-inset-*)`
 *  reports 0px even in a window that spans it), so the target is sized to
 *  comfortably cover every model rather than pretending to know. */
const HOVER_TARGET_W = 340;

/** A notched Mac's menu bar is ~32pt; an un-notched one ~24pt. Used only to
 *  size the hover target's height, so being wrong is cosmetic. */
const MENU_BAR_FALLBACK_H = 32;

/**
 * How often main samples the cursor to decide hover.
 *
 * Polling rather than the window's own mouse events: while collapsed the
 * window is click-through (`setIgnoreMouseEvents`), and a click-through window
 * gets no `mouseenter`. `{ forward: true }` would deliver moves, but then the
 * hover region has to be hit-tested in the renderer and stays wrong for one
 * frame after every reposition. A cursor sample is one syscall and is right
 * immediately.
 */
const HOVER_POLL_MS = 55;

/** Grace period before collapsing. Without it, clipping a corner of the panel
 *  on the way to a button collapses it out from under the pointer. */
const COLLAPSE_GRACE_MS = 220;

/**
 * How often the panel is told what state it should be in, regardless of
 * whether it changed.
 *
 * Main is the only owner of `expanded`, and it used to send ONLY on a
 * transition. One dropped or mistimed message and the two disagree forever:
 * main believes it is collapsed so it never sends `false` again, while the
 * panel is still drawn open — and, because collapsing also sets
 * `setIgnoreMouseEvents(true)`, open AND unclickable, floating above every
 * Space with no way to dismiss it.
 *
 * Re-asserting once a second makes that self-healing. One boolean per second
 * is nothing next to the frame traffic this window already carries.
 */
const REASSERT_MS = 1000;

// ── Module state ───────────────────────────────────────────────────────────

let win: BrowserWindow | null = null;
let enabled = false;
let expanded = false;
let hoverTimer: NodeJS.Timeout | null = null;
let leftAt = 0;
let lastAssertAt = 0;
/** Last state pushed by the renderer, replayed when the window (re)loads so a
 *  reload doesn't leave the panel blank until the next Spotify poll. */
let lastState: NotchState | null = null;

function hostDisplay(): Display {
  // The notch is a property of the built-in panel. Fall back to primary when
  // the lid is shut and there is no internal display.
  return screen.getAllDisplays().find((d) => d.internal) ?? screen.getPrimaryDisplay();
}

function panelBounds(d: Display): Electron.Rectangle {
  return {
    x: Math.round(d.bounds.x + (d.bounds.width - PANEL_W) / 2),
    y: d.bounds.y,
    width: PANEL_W,
    height: PANEL_H,
  };
}

function hoverTargetBounds(d: Display): Electron.Rectangle {
  const h = Math.max(d.workArea.y - d.bounds.y, MENU_BAR_FALLBACK_H);
  return {
    x: Math.round(d.bounds.x + (d.bounds.width - HOVER_TARGET_W) / 2),
    y: d.bounds.y,
    width: HOVER_TARGET_W,
    height: h,
  };
}

function contains(r: Electron.Rectangle, p: Electron.Point): boolean {
  return p.x >= r.x && p.x < r.x + r.width && p.y >= r.y && p.y < r.y + r.height;
}

// ── Expand / collapse ──────────────────────────────────────────────────────

/**
 * (Re-)apply the window level and Space behaviour. Safe to call repeatedly.
 *
 * Two different mechanisms decide where this panel is allowed to appear, and
 * only one of them is ours:
 *
 *  - Ordinary Spaces are `NSWindowCollectionBehaviorCanJoinAllSpaces`, set
 *    here. Measured: this survives `app.dock.show()` / `app.dock.hide()`,
 *    which this app performs on every window show/hide, so it does not need
 *    re-applying for that reason. `isVisibleOnAllWorkspaces()` reads back
 *    true across both transitions.
 *
 *  - Another app's FULLSCREEN Space is not ours to grant. Since 10.14 Apple
 *    only floats a window there if the process is an accessory
 *    (`kProcessTransformToUIElementApplication`) — which is precisely what
 *    `app.dock.hide()` does. So the panel reaches fullscreen apps while the
 *    main window is hidden, and not while it is open and holding a dock icon.
 *    Electron's own `SetVisibleOnAllWorkspaces` says the same thing in a
 *    comment above its `TransformProcessType` call.
 *
 * `skipTransformProcessType: true` keeps THIS call from transforming the
 * process on its own. Without it, merely enabling the HUD would strip the
 * dock icon and drop the app out of Cmd+Tab as a side effect — dock state
 * stays owned by showWindow/hideWindow.
 *
 * Re-asserting after a policy change is still worth doing:
 * `NSWindowCollectionBehaviorFullScreenAuxiliary` has no getter, so unlike
 * the all-Spaces bit it cannot be verified, and the call is free.
 */
function reassertLevel(): void {
  if (!win || win.isDestroyed()) return;
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, {
    visibleOnFullScreen: true,
    skipTransformProcessType: true,
  });
}

/** Called by main after anything that changes the app's activation policy. */
export function notchActivationPolicyChanged(): void {
  reassertLevel();
}

/** Push the current state to the panel, whether or not it changed. */
function applyExpanded(next: boolean): void {
  if (!win || win.isDestroyed()) return;
  expanded = next;
  // Click-through while collapsed, so the menu bar underneath keeps working.
  win.setIgnoreMouseEvents(!next);
  win.webContents.send('notch:expanded', next);
  lastAssertAt = Date.now();
}

function setExpanded(next: boolean): void {
  if (expanded === next) return;
  applyExpanded(next);
}

function pollHover(): void {
  if (!win || win.isDestroyed()) return;
  const d = hostDisplay();
  const p = screen.getCursorScreenPoint();

  if (expanded) {
    if (contains(panelBounds(d), p)) {
      leftAt = 0;
      return;
    }
    if (leftAt === 0) leftAt = Date.now();
    if (Date.now() - leftAt >= COLLAPSE_GRACE_MS) setExpanded(false);
    return;
  }

  if (contains(hoverTargetBounds(d), p)) {
    leftAt = 0;
    setExpanded(true);
  }
}

/** Runs on the same timer as the hover poll — see REASSERT_MS. */
function reassertExpanded(): void {
  if (Date.now() - lastAssertAt < REASSERT_MS) return;
  applyExpanded(expanded);
}

/** The idle shape has to sit in the menu-bar band exactly, and that band is
 *  ~32pt on a notched Mac but ~24pt without one. CSS cannot read it, so main
 *  measures it and the panel uses it as a custom property. */
function sendMetrics(): void {
  if (!win || win.isDestroyed()) return;
  const d = hostDisplay();
  win.webContents.send('notch:metrics', {
    menuBarHeight: Math.max(d.workArea.y - d.bounds.y, 24),
  });
}

function reposition(): void {
  if (!win || win.isDestroyed()) return;
  win.setBounds(panelBounds(hostDisplay()));
  sendMetrics();
}

// ── Lifecycle ──────────────────────────────────────────────────────────────

function create(): void {
  const d = hostDisplay();
  win = new BrowserWindow({
    ...panelBounds(d),
    show: false,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    // A non-activating panel: clicking a transport button must not pull focus
    // out of whatever the user is actually working in.
    focusable: false,
    type: 'panel',
    /*
     * What actually lets the panel sit in the menu-bar strip.
     *
     * macOS runs every window through NSWindow.constrainFrameRect, which
     * pins normal windows below the menu bar. Asking for y=0 silently came
     * back as y=32 — no error, the panel just rendered 32pt low and its idle
     * lozenge sat on the browser's tab bar instead of hiding in the notch.
     * Raising the window level does NOT lift the constraint; this flag is
     * the only thing that does.
     */
    enableLargerThanScreen: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // The panel is always on screen, so it is never occluded or hidden and
      // never gets throttled. Left at the default deliberately.
    },
  });

  reassertLevel();
  /*
   * Re-apply the bounds AFTER raising the window level. This is not
   * redundant with the constructor.
   *
   * macOS refuses to place a normal-level window in the menu-bar strip and
   * silently clamps it down: we asked for y=0 and the window reported back
   * y=32. Nothing errors. The panel then renders 32pt lower than intended,
   * so the idle lozenge — which is supposed to hide inside the notch — lands
   * squarely on whatever is below it, which in a browser is the tab bar.
   *
   * Once the level is `screen-saver` the strip is allowed, so setting the
   * same bounds a second time actually takes.
   */
  win.setBounds(panelBounds(d));

  win.setIgnoreMouseEvents(true);

  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  const url = process.env.VITE_DEV_SERVER_URL;
  if (url) void win.loadURL(new URL('notch.html', url).href);
  else void win.loadFile(path.join(__dirname, '../dist/notch.html'));

  win.webContents.on('did-finish-load', () => {
    // Replay: a dev reload or a display change otherwise leaves the panel
    // empty until Spotify's next poll, which can be 10s away.
    if (lastState) win?.webContents.send('notch:state', lastState);
    win?.webContents.send('notch:expanded', expanded);
    sendMetrics();
  });

  win.once('ready-to-show', () => {
    win?.showInactive();
    // Again after showing: applying collection behaviour to a window that has
    // never been ordered in does not reliably stick.
    reassertLevel();
  });

  win.on('show', reassertLevel);
}

function destroy(): void {
  if (hoverTimer) {
    clearInterval(hoverTimer);
    hoverTimer = null;
  }
  expanded = false;
  if (win && !win.isDestroyed()) win.destroy();
  win = null;
}

/**
 * Tear the panel down without changing the user's preference.
 *
 * Quitting closes every BrowserWindow anyway, but this panel is always-on-top
 * and floats over other Spaces, so the gap between "user asked to quit" and
 * "Electron got round to this window" is a gap where a HUD belonging to a
 * closing app is still sitting over whatever they switched to. Closing it
 * first makes the app disappear all at once.
 *
 * Deliberately not `setNotchEnabled(false)`: that would leave `enabled`
 * false, and the next launch reads the persisted pref, not this.
 */
export function shutdownNotch(): void {
  if (hoverTimer) {
    clearInterval(hoverTimer);
    hoverTimer = null;
  }
  expanded = false;
  if (win && !win.isDestroyed()) win.destroy();
  win = null;
}

export function isNotchEnabled(): boolean {
  return enabled;
}

export function setNotchEnabled(next: boolean): void {
  if (enabled === next) return;
  enabled = next;
  if (!next) {
    destroy();
    return;
  }
  create();
  hoverTimer = setInterval(() => {
    pollHover();
    reassertExpanded();
  }, HOVER_POLL_MS);
}

/**
 * Register IPC and display listeners. Call once, from app ready.
 *
 * `onCommand` is handed the renderer that owns the Spotify session.
 */
export function initNotch(onCommand: (cmd: NotchCommand) => void): void {
  ipcMain.on('notch:state', (_e, state: NotchState | null) => {
    lastState = state;
    if (win && !win.isDestroyed()) win.webContents.send('notch:state', state);
  });

  ipcMain.on('notch:command', (_e, cmd: NotchCommand) => onCommand(cmd));

  // The built-in display moves under the notch when an external monitor is
  // added, removed or rearranged; the panel has to follow it.
  screen.on('display-metrics-changed', reposition);
  screen.on('display-added', reposition);
  screen.on('display-removed', reposition);
}

import { BrowserWindow, app, dialog, ipcMain, shell } from 'electron';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  applyStagedUpdate,
  discardStagedUpdate,
  downloadUpdate,
  fetchLatestUpdate,
  findReplaceableBundle,
  stageUpdate,
  type DownloadProgress,
  type RemoteUpdate,
  type StagedUpdate,
} from './updateInstaller';

/**
 * Auto-update orchestration. Drives the macOS installer in
 * electron/updateInstaller.ts and adds:
 *   - A finite state machine surfaced to the renderer over IPC, so the UI can
 *     render exactly one banner no matter where in the flow we are.
 *   - Categorized errors (network / install / unknown) with appropriate
 *     retry semantics. Network errors back off + retry automatically; install
 *     errors halt and surface a manual-fallback option.
 *   - A native prompt as soon as a new version is found: install now, install
 *     on quit, or skip. Nothing downloads until that question is answered;
 *     "install on quit" is what lands the update with no further action.
 *   - Per-version dismissal honored across launches (persisted by main in
 *     userData; the renderer's "dismiss" call writes through to it).
 *   - Periodic background checks every hour while running, plus a one-shot
 *     check 8 s after startup so the first paint isn't fighting the network.
 *
 * This used to be a thin wrapper over electron-updater. It isn't any more:
 * on macOS electron-updater delegates the install to Squirrel.Mac, which
 * refuses to swap a bundle it can't code-sign-verify, so for an unsigned app
 * the download always succeeded and the install always failed.
 * updateInstaller.ts performs the swap directly — see the comment at the top
 * of that file for why that's safe without a signature.
 */

const REPO_URL = 'https://github.com/omkarxpatel/Electron';
const RELEASES_URL = `${REPO_URL}/releases`;

const SKIP_FILE_NAME = 'update-skip.json';

const PERIODIC_CHECK_INTERVAL_MS = 60 * 60 * 1000;  // 1 hr
const INITIAL_CHECK_DELAY_MS = 8 * 1000;            // 8 s after ready
const NETWORK_RETRY_DELAYS_MS = [30_000, 2 * 60_000, 10 * 60_000];
const MAX_CONSECUTIVE_FAILURES = 3;

// ── State machine surfaced to the renderer ─────────────────────────────────

export interface UpdateProgress {
  percent: number;
  bytesPerSecond: number;
  transferred: number;
  total: number;
}

export type UpdateErrorCategory = 'network' | 'install' | 'unknown';

export type UpdateState =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'up-to-date'; checkedAt: number }
  | { kind: 'available'; version: string; releaseNotes?: string; releasePageUrl: string }
  | {
      kind: 'downloading';
      version: string;
      progress: UpdateProgress;
      releasePageUrl: string;
    }
  | { kind: 'downloaded'; version: string; releaseNotes?: string; releasePageUrl: string }
  | {
      kind: 'error';
      message: string;
      category: UpdateErrorCategory;
      canRetry: boolean;
      lastVersionSeen?: string;
      lastReleasePageUrl?: string;
    }
  | {
      kind: 'manual-fallback';
      reason: string;
      version?: string;
      releasePageUrl: string;
    };

let currentState: UpdateState = { kind: 'idle' };
let periodicCheckTimer: NodeJS.Timeout | null = null;
let consecutiveFailures = 0;
let retryTimer: NodeJS.Timeout | null = null;
// Tracks the version currently flowing through the run, so error states can
// still name it and point at its release page.
let lastSeenVersion: string | null = null;
// The release the current prompt or download refers to.
let pendingUpdate: RemoteUpdate | null = null;
// Downloaded, verified and unpacked. The `will-quit` handler swaps it in.
let stagedUpdate: StagedUpdate | null = null;
// Persisted "skip this version" answer.
let suppressUntilNewerThan: string | null = null;
// Guards the prompt so a re-check that re-finds an already-answered version
// doesn't ask twice.
let promptedForVersion: string | null = null;
// Set when the user picked "Install now" — the restart happens once the
// download lands, not at click time.
let installWhenDownloaded = false;

// ── Skipped-version persistence ────────────────────────────────────────────
// Kept on disk, not just in memory: an install prompt that reappears on every
// launch after the user said "skip" is worse than no prompt at all. Path is
// resolved lazily because app.getPath() is only valid after `ready`.

function skipFilePath(): string {
  return join(app.getPath('userData'), SKIP_FILE_NAME);
}

function readSkippedVersion(): string | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(skipFilePath(), 'utf-8'));
    const v = (parsed as { version?: unknown } | null)?.version;
    return typeof v === 'string' && v.length > 0 ? v : null;
  } catch {
    // Missing or unreadable file just means "nothing skipped".
    return null;
  }
}

function writeSkippedVersion(version: string | null): void {
  try {
    writeFileSync(skipFilePath(), JSON.stringify({ version }), 'utf-8');
  } catch (err) {
    log('warn', 'could not persist skipped version:', err);
  }
}

/** True when the user has skipped exactly this version. */
function isSkipped(version: string): boolean {
  return suppressUntilNewerThan !== null && version === suppressUntilNewerThan;
}

function log(level: 'info' | 'warn' | 'error', ...args: unknown[]): void {
  // eslint-disable-next-line no-console
  console[level]('[updater]', ...args);
}

function broadcast(state: UpdateState): void {
  currentState = state;
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('update:state', state);
  }
}

function releasePageUrlFor(version?: string): string {
  if (!version) return RELEASES_URL;
  const v = version.startsWith('v') ? version : `v${version}`;
  return `${REPO_URL}/releases/tag/${v}`;
}

/** Plain x.y.z compare — this project has never shipped a prerelease tag. */
function isNewer(remote: string, current: string): boolean {
  const parts = (v: string): number[] => v.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const a = parts(remote);
  const b = parts(current);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const [x, y] = [a[i] ?? 0, b[i] ?? 0];
    if (x !== y) return x > y;
  }
  return false;
}

/**
 * Whether this is a shipped build rather than a `npm run dev` session.
 *
 * Deliberately not `app.isPackaged`. Electron implements that as
 * `basename(process.execPath).toLowerCase() !== 'electron'`, and this app's
 * productName is "Electron", so the executable is literally named `electron`
 * and every shipped build reports `isPackaged === false`. That one line is
 * why the updater silently no-opped in every release up to 1.1.0 — it took
 * the dev-mode branch in production and never checked anything.
 *
 * `process.defaultApp` is set only when Electron is launched as
 * `electron <path>`, which is exactly the dev case, and it doesn't care what
 * the app or its executable is called.
 */
export function isPackagedBuild(): boolean {
  return process.defaultApp !== true;
}

// ── Error categorization ───────────────────────────────────────────────────

function categorizeError(err: unknown): { category: UpdateErrorCategory; message: string; canRetry: boolean } {
  const raw = err instanceof Error ? err.message : String(err ?? 'Unknown error');
  const lower = raw.toLowerCase();

  // Network-ish: HTTP errors, timeouts, DNS, ENOTFOUND, ECONNRESET, etc.
  // A 404 lands here too, which is right: it's what a release published
  // without its latest-mac.yml looks like, and it fixes itself once the
  // release is completed.
  if (
    lower.includes('enotfound') ||
    lower.includes('econnreset') ||
    lower.includes('etimedout') ||
    lower.includes('econnrefused') ||
    lower.includes('network') ||
    lower.includes('timeout') ||
    lower.includes('socket') ||
    lower.includes('getaddrinfo') ||
    lower.match(/\bhttp\s*[45]\d\d\b/)
  ) {
    return { category: 'network', message: raw, canRetry: true };
  }

  // Install-ish: the bundle swap can't proceed. No point retrying these on a
  // timer — the user needs to do something (move the app, free disk space).
  if (
    lower.includes('permission denied') ||
    lower.includes('read-only') ||
    lower.includes('no write access') ||
    lower.includes('enospc') ||
    lower.includes('.app bundle')
  ) {
    return { category: 'install', message: raw, canRetry: false };
  }

  return { category: 'unknown', message: raw, canRetry: true };
}

// ── Retry orchestration ────────────────────────────────────────────────────

function clearRetryTimer(): void {
  if (retryTimer !== null) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
}

function scheduleRetryAfterError(): void {
  clearRetryTimer();
  if (consecutiveFailures > MAX_CONSECUTIVE_FAILURES) {
    log('warn', 'Max consecutive failures reached; pausing auto-checks. User-initiated checks still work.');
    return;
  }
  const idx = Math.min(consecutiveFailures - 1, NETWORK_RETRY_DELAYS_MS.length - 1);
  const delay = NETWORK_RETRY_DELAYS_MS[idx];
  log('info', `Scheduling retry in ${Math.round(delay / 1000)}s (attempt ${consecutiveFailures + 1}/${MAX_CONSECUTIVE_FAILURES + 1})`);
  retryTimer = setTimeout(() => {
    retryTimer = null;
    void triggerCheck({ source: 'retry' });
  }, delay);
}

// ── Public actions (call from main or via IPC) ─────────────────────────────

interface TriggerOptions {
  source: 'initial' | 'periodic' | 'user' | 'retry';
}

async function triggerCheck(opts: TriggerOptions): Promise<void> {
  if (!isPackagedBuild()) {
    // A dev run has no released version to compare against, and the bundle it
    // would "update" is node_modules/electron. Signal "no update behavior
    // available" so the UI hides itself.
    log('info', 'Skipping update check in dev mode.');
    broadcast({ kind: 'idle' });
    return;
  }

  // Don't pile up checks. If we're mid-flow, ignore lower-priority triggers.
  const inFlight = currentState.kind === 'checking' || currentState.kind === 'downloading';
  if (inFlight && opts.source !== 'user') {
    log('info', `Skipping ${opts.source} check; already in state ${currentState.kind}`);
    return;
  }

  if (opts.source === 'user') {
    // An explicit "Check for updates" click is how a user takes back a skip.
    // Without this the persisted skip would be a one-way door until the next
    // release, with the UI insisting the app is up to date.
    if (suppressUntilNewerThan !== null) {
      log('info', `user-initiated check clears the skip on v${suppressUntilNewerThan}`);
      suppressUntilNewerThan = null;
      writeSkippedVersion(null);
      promptedForVersion = null;
    }
  }

  log('info', `Checking for updates (source=${opts.source})`);
  broadcast({ kind: 'checking' });
  try {
    const update = await fetchLatestUpdate(REPO_URL);
    consecutiveFailures = 0;

    if (!isNewer(update.version, app.getVersion())) {
      log('info', `Up to date (running ${app.getVersion()}, latest is ${update.version})`);
      broadcast({ kind: 'up-to-date', checkedAt: Date.now() });
      return;
    }

    lastSeenVersion = update.version;
    if (isSkipped(update.version)) {
      log('info', `v${update.version} matches dismissed version; suppressing UI`);
      broadcast({ kind: 'up-to-date', checkedAt: Date.now() });
      return;
    }

    pendingUpdate = update;
    broadcast({
      kind: 'available',
      version: update.version,
      releasePageUrl: releasePageUrlFor(update.version),
    });
    await promptForUpdate(update);
  } catch (err) {
    handleError(err);
  }
}

/** Ask once per version, before downloading anything, and act on the answer.
 *
 *  Asking *before* the download is what makes "skip" truthful — a version the
 *  user refused is never fetched at all — and it's also where we find out
 *  whether we can install it, so we never promise a swap we can't perform. */
async function promptForUpdate(update: RemoteUpdate): Promise<void> {
  if (promptedForVersion === update.version) return;
  promptedForVersion = update.version;

  // Pre-flight the swap. An app on a read-only volume or owned by another
  // user can download all day and never install; the end of a 100 MB
  // download is the worst moment to discover that.
  const target = await findReplaceableBundle();
  if (!target.ok) {
    log('warn', `cannot replace this bundle: ${target.reason}`);
    broadcast({
      kind: 'manual-fallback',
      reason: target.reason,
      version: update.version,
      releasePageUrl: releasePageUrlFor(update.version),
    });
    return;
  }

  const win =
    BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
  if (!win) {
    log('warn', 'no window to prompt in; leaving the update undownloaded');
    return;
  }

  const { response } = await dialog.showMessageBox(win, {
    type: 'info',
    title: 'Update available',
    message: `Version ${update.version} is available.`,
    detail:
      'It downloads in the background. Installing restarts the app — your Spotify sign-in, EQ settings and visualizer presets are preserved.',
    buttons: ['Install now', 'Install when I quit', 'Skip this version'],
    defaultId: 0,
    cancelId: 1,
    normalizeAccessKeys: false,
  });

  if (response === 2) {
    suppressUntilNewerThan = update.version;
    writeSkippedVersion(update.version);
    pendingUpdate = null;
    log('info', `v${update.version} skipped by user; not downloading`);
    broadcast({ kind: 'up-to-date', checkedAt: Date.now() });
    return;
  }

  // Both remaining answers download now. They differ only in whether we
  // restart as soon as it lands, or apply it on the next quit.
  installWhenDownloaded = response === 0;
  log('info', `v${update.version} accepted (${installWhenDownloaded ? 'restart when ready' : 'install on quit'})`);
  await startDownload(update, target.bundlePath);
}

async function startDownload(update: RemoteUpdate, bundlePath: string): Promise<void> {
  const onProgress = (progress: DownloadProgress): void => {
    broadcast({
      kind: 'downloading',
      version: update.version,
      progress,
      releasePageUrl: releasePageUrlFor(update.version),
    });
  };

  log('info', `Downloading v${update.version} (${update.size} bytes)`);
  onProgress({ percent: 0, bytesPerSecond: 0, transferred: 0, total: update.size });

  try {
    const { zipPath, stageRoot } = await downloadUpdate(update, onProgress);
    stagedUpdate = await stageUpdate(zipPath, stageRoot, bundlePath);
    consecutiveFailures = 0;
    log('info', `v${update.version} staged at ${stagedUpdate.appPath}`);
    broadcast({
      kind: 'downloaded',
      version: update.version,
      releasePageUrl: releasePageUrlFor(update.version),
    });

    // "Install when I quit" needs nothing here: the `will-quit` handler
    // applies whatever is staged.
    if (installWhenDownloaded) {
      installWhenDownloaded = false;
      triggerInstall();
    }
  } catch (err) {
    handleError(err);
  }
}

async function triggerDownload(): Promise<void> {
  if (currentState.kind !== 'available' || pendingUpdate === null) {
    log('warn', `triggerDownload called from state ${currentState.kind}, ignoring`);
    return;
  }
  const target = await findReplaceableBundle();
  if (!target.ok) {
    broadcast({
      kind: 'manual-fallback',
      reason: target.reason,
      version: pendingUpdate.version,
      releasePageUrl: releasePageUrlFor(pendingUpdate.version),
    });
    return;
  }
  await startDownload(pendingUpdate, target.bundlePath);
}

function triggerInstall(): void {
  if (stagedUpdate === null) {
    log('warn', 'triggerInstall called with nothing staged, ignoring');
    return;
  }
  log('info', `Quitting to install v${lastSeenVersion ?? 'unknown'}`);
  // The swap itself happens in the `will-quit` handler: the helper it spawns
  // waits for this process to exit before touching the bundle.
  app.quit();
}

function openReleasePage(url?: string): void {
  const target = url && url.startsWith(RELEASES_URL) ? url : RELEASES_URL;
  void shell.openExternal(target).catch((err) => log('error', 'openExternal failed:', err));
}

function handleError(err: unknown): void {
  const cat = categorizeError(err);
  log('error', `[${cat.category}] ${cat.message}`);
  consecutiveFailures += 1;

  // Whatever we had staged or pending is suspect now; don't keep a
  // half-finished download around to be applied on quit.
  void clearStaged();
  pendingUpdate = null;
  promptedForVersion = null;

  if (cat.category === 'network' && cat.canRetry) {
    broadcast({
      kind: 'error',
      message: cat.message,
      category: cat.category,
      canRetry: true,
      lastVersionSeen: lastSeenVersion ?? undefined,
      lastReleasePageUrl: releasePageUrlFor(lastSeenVersion ?? undefined),
    });
    scheduleRetryAfterError();
  } else if (cat.category === 'install') {
    // No automatic retry on install errors — the user falls back to the
    // manual download path. Surface a clear explanation.
    broadcast({
      kind: 'manual-fallback',
      reason: cat.message,
      version: lastSeenVersion ?? undefined,
      releasePageUrl: releasePageUrlFor(lastSeenVersion ?? undefined),
    });
  } else {
    broadcast({
      kind: 'error',
      message: cat.message,
      category: cat.category,
      canRetry: cat.canRetry,
      lastVersionSeen: lastSeenVersion ?? undefined,
      lastReleasePageUrl: releasePageUrlFor(lastSeenVersion ?? undefined),
    });
  }
}

async function clearStaged(): Promise<void> {
  if (stagedUpdate === null) return;
  const staged = stagedUpdate;
  stagedUpdate = null;
  installWhenDownloaded = false;
  try {
    await discardStagedUpdate(staged);
  } catch (err) {
    log('warn', 'could not clean up the staged update:', err);
  }
}

// ── Setup ──────────────────────────────────────────────────────────────────

export function setupAutoUpdater(): void {
  suppressUntilNewerThan = readSkippedVersion();
  if (suppressUntilNewerThan) log('info', `v${suppressUntilNewerThan} is skipped (persisted)`);

  // Where the bundle swap actually gets kicked off, for both "install now"
  // (which quits immediately) and "install when I quit". Registered on
  // `will-quit` rather than `before-quit` because main.ts tears this module
  // down on `before-quit`.
  app.on('will-quit', () => {
    if (stagedUpdate === null) return;
    log('info', `Applying staged update from ${stagedUpdate.appPath}`);
    applyStagedUpdate(stagedUpdate);
  });

  // IPC handlers for renderer-initiated actions.
  ipcMain.handle('update:check', () => triggerCheck({ source: 'user' }));
  ipcMain.handle('update:download', () => triggerDownload());
  ipcMain.handle('update:install', () => {
    triggerInstall();
    return true;  // synchronous, returns before the quit kicks in
  });
  ipcMain.handle('update:open-fallback', (_e, url?: string) => {
    openReleasePage(url);
  });
  ipcMain.handle('update:dismiss-version', (_e, version: string) => {
    if (typeof version === 'string' && version.length > 0) {
      suppressUntilNewerThan = version.startsWith('v') ? version.slice(1) : version;
      writeSkippedVersion(suppressUntilNewerThan);
      // Drop anything already downloaded for it, or `will-quit` would install
      // the version they just dismissed.
      void clearStaged();
      pendingUpdate = null;
      log('info', `Suppressing UI for v${suppressUntilNewerThan} until a newer release`);
      broadcast({ kind: 'up-to-date', checkedAt: Date.now() });
    }
  });
  // Sync IPC so the renderer can hydrate its initial state at preload time
  // (avoids a flash of empty UI before the first 'update:state' broadcast).
  ipcMain.on('update:get-state', (event) => {
    event.returnValue = currentState;
  });
  ipcMain.handle('update:get-state-async', () => currentState);

  // The initial check happens after a short grace period so the first frame
  // isn't fighting the network and the user's auth flow has a chance to start.
  setTimeout(() => void triggerCheck({ source: 'initial' }), INITIAL_CHECK_DELAY_MS);

  // Periodic background check. We don't pile up checks (triggerCheck guards
  // against duplicate concurrent state); the cadence is governed by the
  // interval, not by retry storms.
  if (periodicCheckTimer === null) {
    periodicCheckTimer = setInterval(() => {
      void triggerCheck({ source: 'periodic' });
    }, PERIODIC_CHECK_INTERVAL_MS);
  }

  log('info', `Auto-updater configured. packaged=${isPackagedBuild()}, version=${app.getVersion()}`);
}

export function teardownAutoUpdater(): void {
  clearRetryTimer();
  if (periodicCheckTimer !== null) {
    clearInterval(periodicCheckTimer);
    periodicCheckTimer = null;
  }
  // Deliberately does not touch `stagedUpdate`: main.ts calls this on
  // `before-quit`, and the staged update has to survive until `will-quit`.
}

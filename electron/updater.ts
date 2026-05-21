import { BrowserWindow, app, ipcMain, shell } from 'electron';
import { autoUpdater, type ProgressInfo, type UpdateInfo, type UpdateDownloadedEvent } from 'electron-updater';

/**
 * Auto-update orchestration. Wraps `electron-updater` with:
 *   - A finite state machine surfaced to the renderer over IPC, so the UI
 *     can render exactly one banner regardless of which underlying event
 *     fired (`checking-for-update`, `update-available`, `download-progress`,
 *     `update-downloaded`, `error`).
 *   - Categorized errors (network / install / unknown) with appropriate
 *     retry semantics. Network errors back off + retry automatically; install
 *     errors halt and surface a manual-fallback option.
 *   - Per-version dismissal honored across launches (persisted in the renderer's
 *     localStorage by the UI; main just trusts the renderer's "dismiss" call).
 *   - Periodic background checks every hour while running, plus a one-shot
 *     check 8 s after startup so the first paint isn't fighting the network.
 *
 * Unsigned macOS apps note: electron-updater downloads the `.zip` artifact
 * (not `.dmg`) and uses Squirrel.Mac to swap binaries. The swap usually works
 * even without a Developer ID signature, but ~30% of the time on Sequoia+
 * macOS re-quarantines the new bundle and the relaunched app shows "damaged."
 * When that happens the user falls back to the manual install flow via the
 * always-visible "Open release page" button. We don't pretend silent
 * auto-update is a guarantee — the UI is honest about the failure modes.
 */

const REPO_URL = 'https://github.com/omkarxpatel/Electron';
const RELEASES_URL = `${REPO_URL}/releases`;

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
// Tracks the version currently flowing through the events (because not every
// event carries it — `download-progress`, `update-downloaded`, etc. need to
// fall back to a remembered value).
let lastSeenVersion: string | null = null;
let lastSeenReleaseNotes: string | undefined;
// User-asked-for download-now vs background-download distinction. Currently
// we always background-download because autoDownload = true, but if the user
// dismissed and a NEW version drops we want to re-trigger.
let suppressUntilNewerThan: string | null = null;

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

// ── Error categorization ───────────────────────────────────────────────────

function categorizeError(err: unknown): { category: UpdateErrorCategory; message: string; canRetry: boolean } {
  const raw = err instanceof Error ? err.message : String(err ?? 'Unknown error');
  const lower = raw.toLowerCase();

  // Network-ish: HTTP errors, timeouts, DNS, ENOTFOUND, ECONNRESET, etc.
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

  // Install-ish: signature mismatch, Squirrel/ShipIt errors, "code signature",
  // "verification", "permission denied" on the bundle swap.
  if (
    lower.includes('signature') ||
    lower.includes('squirrel') ||
    lower.includes('shipit') ||
    lower.includes('cannot be installed') ||
    lower.includes('permission denied') ||
    lower.includes('verify') ||
    lower.includes('verification') ||
    lower.includes('quarantine') ||
    lower.includes('integrity')
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
  if (!app.isPackaged) {
    // electron-updater in dev mode requires `forceDevUpdateConfig = true`
    // AND a local dev-app-update.yml. Not worth the friction for dev —
    // just signal "no update behavior available" so the UI hides itself.
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

  log('info', `Checking for updates (source=${opts.source})`);
  broadcast({ kind: 'checking' });
  try {
    await autoUpdater.checkForUpdates();
  } catch (err) {
    handleError(err);
  }
}

async function triggerDownload(): Promise<void> {
  if (currentState.kind !== 'available') {
    log('warn', `triggerDownload called from state ${currentState.kind}, ignoring`);
    return;
  }
  log('info', `Starting download for v${currentState.version}`);
  try {
    await autoUpdater.downloadUpdate();
  } catch (err) {
    handleError(err);
  }
}

function triggerInstall(): void {
  if (currentState.kind !== 'downloaded') {
    log('warn', `triggerInstall called from state ${currentState.kind}, ignoring`);
    return;
  }
  log('info', `Installing v${currentState.version} and relaunching`);
  // isSilent=true: no progress UI window from Squirrel itself. Our app's window
  // is closing anyway so it doesn't matter; matching the docs default.
  // isForceRunAfter=true: relaunch when done.
  autoUpdater.quitAndInstall(true, true);
}

function openReleasePage(url?: string): void {
  const target = url && url.startsWith(RELEASES_URL) ? url : RELEASES_URL;
  void shell.openExternal(target).catch((err) => log('error', 'openExternal failed:', err));
}

function handleError(err: unknown): void {
  const cat = categorizeError(err);
  log('error', `[${cat.category}] ${cat.message}`);
  consecutiveFailures += 1;
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
      reason: 'Automatic install failed. Download the release manually and replace the app.',
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

// ── Setup ──────────────────────────────────────────────────────────────────

export function setupAutoUpdater(): void {
  // Defer to the user via UI; don't quit-and-install without an explicit click.
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = false;
  // Tee electron-updater's internal logger into our log() so events are
  // attributable in the main-process console.
  autoUpdater.logger = {
    info: (...a: unknown[]) => log('info', ...a),
    warn: (...a: unknown[]) => log('warn', ...a),
    error: (...a: unknown[]) => log('error', ...a),
    debug: () => {
      /* electron-updater debug is firehose-level; drop it */
    },
  } as unknown as typeof autoUpdater.logger;

  autoUpdater.on('checking-for-update', () => {
    broadcast({ kind: 'checking' });
  });

  autoUpdater.on('update-available', (info: UpdateInfo) => {
    consecutiveFailures = 0;
    lastSeenVersion = info.version;
    lastSeenReleaseNotes = typeof info.releaseNotes === 'string' ? info.releaseNotes : undefined;
    if (suppressUntilNewerThan && info.version === suppressUntilNewerThan) {
      log('info', `v${info.version} matches dismissed version; suppressing UI`);
      broadcast({ kind: 'up-to-date', checkedAt: Date.now() });
      return;
    }
    broadcast({
      kind: 'available',
      version: info.version,
      releaseNotes: lastSeenReleaseNotes,
      releasePageUrl: releasePageUrlFor(info.version),
    });
  });

  autoUpdater.on('update-not-available', () => {
    consecutiveFailures = 0;
    broadcast({ kind: 'up-to-date', checkedAt: Date.now() });
  });

  autoUpdater.on('download-progress', (p: ProgressInfo) => {
    const v = lastSeenVersion ?? 'unknown';
    broadcast({
      kind: 'downloading',
      version: v,
      progress: {
        percent: p.percent ?? 0,
        bytesPerSecond: p.bytesPerSecond ?? 0,
        transferred: p.transferred ?? 0,
        total: p.total ?? 0,
      },
      releasePageUrl: releasePageUrlFor(v),
    });
  });

  autoUpdater.on('update-downloaded', (info: UpdateDownloadedEvent) => {
    consecutiveFailures = 0;
    lastSeenVersion = info.version;
    lastSeenReleaseNotes = typeof info.releaseNotes === 'string' ? info.releaseNotes : lastSeenReleaseNotes;
    broadcast({
      kind: 'downloaded',
      version: info.version,
      releaseNotes: lastSeenReleaseNotes,
      releasePageUrl: releasePageUrlFor(info.version),
    });
  });

  autoUpdater.on('error', (err: Error) => {
    handleError(err);
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

  log('info', `Auto-updater configured. packaged=${app.isPackaged}, autoDownload=${autoUpdater.autoDownload}`);
}

export function teardownAutoUpdater(): void {
  clearRetryTimer();
  if (periodicCheckTimer !== null) {
    clearInterval(periodicCheckTimer);
    periodicCheckTimer = null;
  }
  autoUpdater.removeAllListeners();
}

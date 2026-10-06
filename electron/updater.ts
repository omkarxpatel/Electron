import { BrowserWindow, app, ipcMain, powerMonitor, shell } from 'electron';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  applyStagedUpdate,
  discardStagedUpdate,
  downloadUpdate,
  fetchLatestUpdate,
  findReplaceableBundle,
  invalidateUpdateCache,
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

/** The "Install updates automatically" preference. Its own file for the same
 *  reason notch.json is its own file: losing a user's update policy to some
 *  unrelated file's invalidation would be a baffling bug to track down. */
const PREFS_FILE_NAME = 'update-prefs.json';

/** What an unattended install applied, written before we quit to apply it and
 *  read back by the next launch so it can say what changed. It has to be on
 *  disk because the process that knew is the one being replaced. */
const APPLIED_FILE_NAME = 'update-applied.json';

/* ── Silent delivery ──
 *
 * A release marked `silent` in its CHANGELOG heading installs without asking.
 * The point is that the user never has to find a moment for it, so we have to
 * find one for them, and the bar for "now is fine" is high: restarting the app
 * out from under someone mid-song would be far worse than a dialog.
 *
 * Two moments qualify. The first is quit, which needs no logic — the staged
 * update is applied by the existing `will-quit` handler. The second is the
 * machine being genuinely unattended, which is what the poll below watches
 * for, because an app that is never quit would otherwise never update.
 */

/** No keyboard or mouse for this long. `powerMonitor` reports real input
 *  idleness, which is a far better signal than our own window state: it means
 *  nobody is at the machine, so a restart is invisible rather than merely
 *  well-timed. */
const IDLE_INSTALL_SECONDS = 10 * 60;

/** How often to re-check that. A minute is far below the idle threshold, so
 *  the install lands within a minute of the machine going quiet. */
const IDLE_POLL_INTERVAL_MS = 60_000;

/* A check is one conditional GET of latest-mac.yml, and when nothing has
 * moved GitHub answers 304 with a zero-byte body — measured, see the ETag
 * note in updateInstaller.ts. At that price the cadence is not worth
 * rationing, and halving it halves how long someone keeps running a version
 * we already know has been superseded. */
const PERIODIC_CHECK_INTERVAL_MS = 30 * 60 * 1000;  // 30 min
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
  | {
      /** A newer version exists but the user asked not to be told about it.
       *  Distinct from 'up-to-date' because saying "Up to date" here is a
       *  lie — the update is deferred, not absent. The banner still stays
       *  hidden; only the Settings status tells the truth. */
      kind: 'skipped';
      version: string;
      checkedAt: number;
      releasePageUrl: string;
    }
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
// Set when the user picked "Install now" — the restart happens once the
// download lands, not at click time.
let installWhenDownloaded = false;

/** Set when a staged update arrived via the silent path, so the idle poll
 *  knows it is allowed to restart us. Never set for a prompted update: the
 *  user answered that question themselves and the answer wasn't "whenever". */
let silentInstallArmed = false;

/*
 * "Install updates automatically" — the user's standing answer.
 *
 * Off by default, and deliberately so. Turning it on is someone accepting
 * that the app may restart itself without asking, which is not a position to
 * inherit by never having formed one.
 *
 * On, it changes two things. Every release installs itself, not only the ones
 * the CHANGELOG marks `silent`: the user has opted out of being asked, so the
 * class stops deciding whether to prompt and goes back to only describing
 * what the release was. And the bar for "now is a fine moment" drops from an
 * unattended machine to simply nothing playing — they have already said a
 * restart is fine while they are working, so making them walk away from the
 * keyboard for ten minutes first would be answering a question they did not
 * ask.
 *
 * What it does NOT change is the audio check. Restarting out from under a
 * song is wrong whatever the user has agreed to, and that is the one
 * condition both paths share.
 */
let autoInstallEnabled = false;

/** Renderer's word on whether audio is actually playing through us. The one
 *  thing `powerMonitor` cannot see: someone listening with the window in the
 *  background is not idle, however long since they touched the keyboard. */
let audioActive = false;

let idlePollTimer: NodeJS.Timeout | null = null;

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

// ── Automatic-install preference ───────────────────────────────────────────

function prefsFilePath(): string {
  return join(app.getPath('userData'), PREFS_FILE_NAME);
}

/** Note `=== true`, not `!== false`. A missing, truncated or corrupt file has
 *  to mean "keep asking"; the failure that reads as a bug is an app that
 *  restarts itself because it could not parse its own preferences. */
function readAutoInstallPref(): boolean {
  try {
    const parsed: unknown = JSON.parse(readFileSync(prefsFilePath(), 'utf-8'));
    return (parsed as { autoInstall?: unknown } | null)?.autoInstall === true;
  } catch {
    return false;
  }
}

function writeAutoInstallPref(on: boolean): void {
  try {
    writeFileSync(prefsFilePath(), JSON.stringify({ autoInstall: on }), 'utf-8');
  } catch (err) {
    log('warn', 'could not persist the automatic-install preference:', err);
  }
}

// ── "What you were just updated to" ────────────────────────────────────────

/** Deliberately NOT a member of UpdateState. That union is mirrored in five
 *  places, and this is not a state of the update machine anyway — by the time
 *  it is read, the update it describes already happened, in a previous
 *  process. */
export interface JustInstalled {
  version: string;
  notes?: string;
}

function appliedFilePath(): string {
  return join(app.getPath('userData'), APPLIED_FILE_NAME);
}

function readAppliedRecord(): JustInstalled | null {
  try {
    const parsed = JSON.parse(readFileSync(appliedFilePath(), 'utf-8')) as {
      version?: unknown;
      notes?: unknown;
    } | null;
    const version = parsed?.version;
    if (typeof version !== 'string' || version.length === 0) return null;
    return { version, notes: typeof parsed?.notes === 'string' ? parsed.notes : undefined };
  } catch {
    return null;
  }
}

function writeAppliedRecord(record: JustInstalled): void {
  try {
    writeFileSync(appliedFilePath(), JSON.stringify(record), 'utf-8');
  } catch (err) {
    log('warn', 'could not record what was installed:', err);
  }
}

function clearAppliedRecord(): void {
  try {
    rmSync(appliedFilePath(), { force: true });
  } catch (err) {
    log('warn', 'could not clear the installed record:', err);
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
      broadcast({
        kind: 'skipped',
        version: update.version,
        checkedAt: Date.now(),
        releasePageUrl: releasePageUrlFor(update.version),
      });
      return;
    }

    pendingUpdate = update;

    // Pre-flight the swap BEFORE offering anything. An app on a read-only
    // volume or owned by another user can download all day and never install,
    // and the end of a 100 MB download is the worst moment to discover that.
    // A release we cannot install is still worth reporting, however it was
    // classified — silent means "you don't need to decide", not "say nothing".
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

    if (autoInstallEnabled || update.installClass === 'silent') {
      // Never restart the moment it lands — that is the one thing neither of
      // these may do. Both wait for a moment that costs the user nothing;
      // they only disagree on how quiet it has to be. See autoInstallEnabled.
      installWhenDownloaded = false;
      silentInstallArmed = true;
      log(
        'info',
        autoInstallEnabled
          ? `v${update.version} downloading without prompting (automatic updates are on)`
          : `v${update.version} is a silent release; downloading without prompting`,
      );
      await startDownload(update, target.bundlePath);
      return;
    }

    // The renderer owns the prompt from here — see src/components/
    // UpdateDialog.tsx. It used to be dialog.showMessageBox, which could not
    // show the release notes at all: a native alert takes a string, so the
    // notes had to live in a separate banner and got truncated there. Asking
    // in our own window means the question and what it's about are one thing.
    broadcast({
      kind: 'available',
      version: update.version,
      releaseNotes: update.notes,
      releasePageUrl: releasePageUrlFor(update.version),
    });
  } catch (err) {
    handleError(err);
  }
}

/**
 * Apply a staged update if nobody would notice.
 *
 * `audioActive` is checked whatever the user has agreed to, and is the
 * renderer's word rather than anything inferred here: `powerMonitor` sees an
 * untouched keyboard and calls that idle, which is exactly wrong for someone
 * listening through the notch HUD while working in another app.
 *
 * The keyboard-idle condition is the one automatic mode drops. For a `silent`
 * release the user was never asked, so the bar has to be a machine nobody is
 * sitting at. With automatic updates on they have answered, and the answer
 * was "whenever nothing is playing".
 */
function maybeApplyStagedUpdate(): void {
  if (!silentInstallArmed || stagedUpdate === null) return;
  if (audioActive) return;
  if (!autoInstallEnabled && powerMonitor.getSystemIdleTime() < IDLE_INSTALL_SECONDS) return;

  log(
    'info',
    autoInstallEnabled
      ? 'nothing playing; applying staged update now (automatic updates are on)'
      : 'machine idle and silent; applying staged update now',
  );
  silentInstallArmed = false;
  stopIdlePoll();
  triggerInstall();
}

function startIdlePoll(): void {
  if (idlePollTimer !== null) return;
  idlePollTimer = setInterval(maybeApplyStagedUpdate, IDLE_POLL_INTERVAL_MS);
}

function stopIdlePoll(): void {
  if (idlePollTimer === null) return;
  clearInterval(idlePollTimer);
  idlePollTimer = null;
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
    // Only now is there something for the idle poll to apply.
    if (silentInstallArmed) {
      // Recorded for the automatic path ONLY, and not merely because the
      // release was classed `silent`. A silent release is by definition one
      // where the user has nothing to decide and nothing to learn, so
      // announcing it afterwards would contradict the whole classification.
      // Automatic mode is the opposite case: it swallows releases that WOULD
      // have prompted, and saying what landed is what is owed in exchange.
      //
      // Written at stage time rather than at install time because the process
      // that knows what this release contains is the one about to be replaced.
      if (autoInstallEnabled) {
        writeAppliedRecord({ version: update.version, notes: update.notes });
      }
      startIdlePoll();
    }
    broadcast({
      kind: 'downloaded',
      version: update.version,
      releaseNotes: update.notes,
      releasePageUrl: releasePageUrlFor(update.version),
    });

    // The poll fires once a minute, and the moment may already be here. With
    // automatic updates on, waiting for the next tick is an arbitrary minute
    // of running the old version for no reason.
    if (silentInstallArmed) maybeApplyStagedUpdate();

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

/**
 * Download the pending update.
 *
 * `installNow` is the user's answer to "when", and it is passed in rather
 * than remembered: the native dialog used to set `installWhenDownloaded` as a
 * side effect, and with the asking moved into the renderer a stale value from
 * an earlier flow would decide whether we restart out from under them.
 */
async function triggerDownload(installNow: boolean): Promise<void> {
  if (currentState.kind !== 'available' || pendingUpdate === null) {
    log('warn', `triggerDownload called from state ${currentState.kind}, ignoring`);
    return;
  }
  installWhenDownloaded = installNow;
  log('info',
    `v${pendingUpdate.version} accepted (${installNow ? 'restart when ready' : 'install on quit'})`);
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
  // Don't retry against the cached channel file either. If this was a hash
  // mismatch because a release was re-published under the same version, the
  // cached answer is precisely the wrong one to try again with.
  invalidateUpdateCache();

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
  silentInstallArmed = false;
  stopIdlePoll();
  // Nothing was installed, so the next launch must not claim otherwise.
  clearAppliedRecord();
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

  // Read before the first check, which is 8s away. Main has to own this
  // preference rather than the renderer's settings blob for exactly that
  // reason: the decision can be needed before any window has reported in.
  autoInstallEnabled = readAutoInstallPref();
  log('info', `automatic updates are ${autoInstallEnabled ? 'on' : 'off'}`);

  // Reconcile what we recorded on the way out against what actually came up.
  // A record naming a version we are NOT running means the swap failed and
  // the helper rolled us back — and announcing an update that did not happen
  // is worse than announcing nothing.
  const applied = readAppliedRecord();
  if (applied !== null && applied.version !== app.getVersion()) {
    log('warn', `discarding install record for v${applied.version}; running v${app.getVersion()}`);
    clearAppliedRecord();
  }

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
  ipcMain.handle('update:download', (_e, installNow: unknown) =>
    triggerDownload(installNow === true),
  );
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
      broadcast({
        kind: 'skipped',
        version: suppressUntilNewerThan,
        checkedAt: Date.now(),
        releasePageUrl: releasePageUrlFor(suppressUntilNewerThan),
      });
    }
  });
  // The renderer is the only thing that knows whether sound is coming out of
  // us, and a silent restart must not interrupt it. Reported rather than
  // inferred: `powerMonitor` sees an untouched keyboard and calls that idle,
  // which is exactly wrong for someone listening via the notch HUD.
  ipcMain.on('update:set-activity', (_e, active: unknown) => {
    audioActive = active === true;
  });

  ipcMain.handle('update:get-auto-install', () => autoInstallEnabled);

  // Returns the value AFTER the write, so a toggle that failed to persist
  // snaps the switch back rather than lying about what will happen.
  ipcMain.handle('update:set-auto-install', (_e, on: unknown) => {
    autoInstallEnabled = on === true;
    writeAutoInstallPref(autoInstallEnabled);
    log('info', `automatic updates turned ${autoInstallEnabled ? 'on' : 'off'}`);
    // Something may already be staged and waiting on a bar that just moved.
    if (autoInstallEnabled) maybeApplyStagedUpdate();
    return readAutoInstallPref();
  });

  /** What the last unattended install applied, or null. Guarded on the
   *  running version a second time: the file is only meaningful if the swap
   *  it describes actually took. */
  ipcMain.handle('update:get-just-installed', (): JustInstalled | null => {
    const record = readAppliedRecord();
    return record !== null && record.version === app.getVersion() ? record : null;
  });

  ipcMain.handle('update:acknowledge-installed', () => {
    clearAppliedRecord();
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
  stopIdlePoll();
  if (periodicCheckTimer !== null) {
    clearInterval(periodicCheckTimer);
    periodicCheckTimer = null;
  }
  // Deliberately does not touch `stagedUpdate`: main.ts calls this on
  // `before-quit`, and the staged update has to survive until `will-quit`.
}

import {
  app,
  BrowserWindow,
  Menu,
  nativeImage,
  systemPreferences,
  ipcMain,
  shell,
  session,
  desktopCapturer,
  Tray,
} from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import { execFile, execSync } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
// `isPackagedBuild` rather than `app.isPackaged`: productName is "Electron",
// so the shipped binary is basename "electron" and Electron computes
// isPackaged as permanently false in every release. See updater.ts.
import { isPackagedBuild, setupAutoUpdater, teardownAutoUpdater } from './updater';
import { renderSpeech } from './speech';
import {
  getSinkVolumeState,
  onSinkVolumeChange,
  pinSinkToUnity,
  restoreSink,
  restoreSinkOnQuit,
  restoreStalePin,
  type SinkVolumeState,
} from './deviceVolume';
import {
  declineTest,
  recordCalibration,
  resolveProfile,
  setTier,
  type Calibration,
  type QualityTier,
  type RendererInfo,
} from './deviceProfile';
import { readSpotifyRootlist } from './spotifyFolders';
import {
  initNotch,
  isNotchEnabled,
  notchActivationPolicyChanged,
  setNotchEnabled,
  shutdownNotch,
  type NotchCommand,
} from './notchWindow';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const REPO_URL = 'https://github.com/omkarxpatel/Electron';
const ISSUES_URL = `${REPO_URL}/issues`;
const RELEASES_URL = `${REPO_URL}/releases`;

let win: BrowserWindow | null = null;
let authServer: http.Server | null = null;
let tray: Tray | null = null;

/** Mirror of the renderer's now-playing state, pushed over IPC. Drives the
 *  tray menu's labels and Play/Pause wording while the window is hidden. */
let nowPlaying: { title: string; artist: string; isPlaying: boolean } | null = null;

/**
 * Whether this launch should stay invisible. Two sources:
 *   - `wasOpenedAtLogin` — macOS launched us from the login item.
 *   - `--hidden` argv — what we register the login item with, and a usable
 *     manual override (`open -a Electron --args --hidden`).
 *
 * `openAsHidden` is deliberately not used: macOS has ignored it since
 * Ventura, so relying on it would silently show the window at every login.
 */
function shouldStartHidden(): boolean {
  if (process.argv.includes('--hidden')) return true;
  if (process.platform !== 'darwin') return false;
  try {
    return app.getLoginItemSettings().wasOpenedAtLogin;
  } catch {
    return false;
  }
}

/**
 * On startup, kill any older main-process Electron instances belonging to
 * THIS repo's node_modules. "New launch wins" — solves the dev-mode pile-up
 * where vite-plugin-electron HMR sometimes spawns the new Electron child
 * before the previous one has fully exited, and stale main processes
 * accumulate. Also gives the user an easy escape hatch in production: if
 * a previous run somehow zombied (rare), the next launch just cleans it up.
 *
 * Matching:
 *   - Only the main binary at `.../Contents/MacOS/Electron` from THIS repo's
 *     node_modules. Helpers (`.../Contents/Frameworks/...`) are excluded so
 *     we don't accidentally kill THIS instance's own helper processes.
 *   - Excludes the current process via `selfPid` filter.
 *
 * Lifecycle:
 *   - SIGTERM first so the victim has a chance to run before-quit handlers
 *     (close auth server, drain audio context). Brief 300 ms wait.
 *   - SIGKILL any stragglers that didn't exit in time.
 *
 * macOS only — on other platforms there's no pile-up issue to solve.
 */
function killStaleInstances(): void {
  if (process.platform !== 'darwin') return;
  // Pattern points at the main binary specifically. The pgrep -f flag
  // matches against the full argv, so we're matching by binary path, not
  // process name.
  const pattern = 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron';
  let pgrepOut: string;
  try {
    pgrepOut = execSync(`pgrep -f "${pattern}"`, { encoding: 'utf8' });
  } catch {
    // pgrep exits non-zero when there are zero matches; that's the
    // expected normal case (no zombies, nothing to clean up).
    return;
  }
  const selfPid = process.pid;
  const pids = pgrepOut
    .split('\n')
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isInteger(n) && n > 0 && n !== selfPid);
  if (pids.length === 0) return;
  console.log(`[main] cleaning up ${pids.length} stale Electron instance(s): ${pids.join(', ')}`);
  const list = pids.join(' ');
  try {
    // Single shell pipeline: SIGTERM, sleep 0.3s, SIGKILL stragglers.
    // `2>/dev/null` swallows "no such process" errors (race-safe). Final
    // `true` ensures the pipeline doesn't fail the parent `execSync` if
    // the final kill returns non-zero.
    execSync(
      `kill -TERM ${list} 2>/dev/null; sleep 0.3; kill -KILL ${list} 2>/dev/null; true`,
      { stdio: 'ignore' },
    );
  } catch (err) {
    console.warn('[main] kill-stale pipeline returned non-zero (ok if all already exited):', err);
  }
}

// Run BEFORE requesting the lock — killing the previous lock-holder is what
// frees the lock so our request can succeed.
killStaleInstances();

/**
 * Single-instance lock. Belt-and-braces on top of killStaleInstances():
 * even if somehow another process is alive and we didn't kill it (race,
 * permission denied, etc.), the lock guarantees we won't have two visible
 * windows at once.
 */
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  // Re-launching the app while it's already running in the menu bar should
  // surface the window rather than doing nothing.
  app.on('second-instance', () => {
    void showWindow();
  });
}

/**
 * When true, the next display-media capture uses `loopbackWithMute` — macOS
 * captures the system mix AND silences those sources at the speakers so our
 * own processed playback isn't doubled.
 *
 * The renderer flips this via the `system-audio:set-mute` IPC channel
 * whenever Live (playthrough) is toggled while system-audio capture is the
 * active source.
 */
let systemAudioMuted = false;

/**
 * Show the window, bringing the dock icon back with it.
 *
 * The dock icon is deliberately tied to window visibility rather than hidden
 * for good. An app with no dock icon is an macOS "accessory" — it gets no
 * menu bar, which would take the Edit menu with it, and with it cut / copy /
 * paste in every text field (the Spotify Client ID box, the search input).
 * Showing the dock icon whenever a window is on screen keeps the standard
 * menu and its shortcuts; hiding it on the way out keeps the app invisible
 * while it sits in the menu bar.
 */
/**
 * Dock icon visible iff the window is up. The notch HUD does NOT get a vote,
 * and that is the whole point of this comment.
 *
 * It used to: the dock icon was dropped for as long as the HUD was enabled,
 * and since the HUD is on by default that meant the app was an accessory from
 * the first launch onwards. An accessory app owns no menu bar, so the band at
 * the top of the screen sat empty whenever this app was frontmost — no Apple
 * menu, no File / Edit / View, and with the Edit menu gone, no Cmd+X / C / V
 * in the Spotify Client ID box or the search field. Nothing logs this; the
 * menu bar is simply blank, which reads as the OS glitching rather than as
 * something we did.
 *
 * What it bought: since macOS 10.14 a window may only float over ANOTHER
 * app's FULLSCREEN Space if the process is an accessory
 * (`kProcessTransformToUIElementApplication`, i.e. `app.dock.hide()`). So the
 * HUD now reaches a fullscreen Space only while our window is hidden — which
 * is the state the HUD is actually for. With the window open, the panel stops
 * at the edge of a fullscreen Space and isn't drawn there.
 *
 * That is the right way round: a blank menu bar is broken all the time, a HUD
 * missing from a fullscreen Space is missing in the one case where the window
 * it belongs to is already on screen.
 */
function syncDockVisibility(): void {
  if (process.platform !== 'darwin' || !app.dock) return;
  const wantDock = !!win && !win.isDestroyed() && win.isVisible();
  if (wantDock) {
    void app.dock.show().catch(() => {
      // Non-fatal — the window is up either way, we just keep the old state.
    });
  } else {
    app.dock.hide();
  }
  notchActivationPolicyChanged();
}

async function showWindow(): Promise<void> {
  if (!win || win.isDestroyed()) {
    createWindow();
    return;
  }
  if (win.isMinimized()) win.restore();
  if (!win.isVisible()) win.show();
  syncDockVisibility();
  // An accessory app has no dock icon to click and no Cmd+Tab entry, so
  // nothing else will bring this forward — win.focus() alone leaves it
  // behind whatever the user was in.
  app.focus({ steal: true });
  win.focus();
}

/** Hide the window and drop the dock icon, leaving only the tray. The
 *  renderer keeps running: audio, the EQ and Spotify polling all continue,
 *  which is the whole point of hiding rather than quitting. */
function hideWindow(): void {
  if (win && !win.isDestroyed() && win.isVisible()) win.hide();
  syncDockVisibility();
}

/* ─── Notch HUD ─── */

/** Its own file rather than a key in perf-profile.json: that file is
 *  invalidated whenever the draw path's cost characteristics change, and
 *  losing the user's HUD preference to a visualizer optimisation would be a
 *  baffling bug to track down. */
function notchPrefPath(): string {
  return path.join(app.getPath('userData'), 'notch.json');
}

function readNotchPref(): boolean {
  try {
    const raw = JSON.parse(fs.readFileSync(notchPrefPath(), 'utf8')) as { enabled?: unknown };
    return raw.enabled !== false;
  } catch {
    // No file yet, or unreadable. On by default — it is the feature.
    return true;
  }
}

function writeNotchPref(enabled: boolean): void {
  try {
    fs.writeFileSync(notchPrefPath(), JSON.stringify({ enabled }), 'utf8');
  } catch (err) {
    // A HUD that forgets its setting is worth less than a crashed app.
    console.error('[main] could not persist notch preference', err);
  }
}

function toggleNotch(enabled: boolean): void {
  setNotchEnabled(enabled);
  writeNotchPref(enabled);
  syncDockVisibility();
  refreshTray();
  // Settings has the same switch. Without this the two disagree the moment
  // either one is used — the same trap `app-event:login-item` already covers.
  win?.webContents.send('app-event:notch-enabled', enabled);
}

/**
 * Notch panel → main renderer. Same reasoning as `sendTransport`: the panel
 * has no Spotify session, the renderer does.
 */
function sendNotchCommand(cmd: NotchCommand): void {
  // Handled here, not in the renderer: showing the window is main's job and
  // the renderer has no way to raise itself.
  if (cmd.kind === 'activate') {
    void showWindow();
    return;
  }
  if (!win || win.isDestroyed()) return;
  win.webContents.send('notch:command', cmd);
}

/* ─── Tray ─── */

function trayIconPath(): string {
  // `trayTemplate.png` + `@2x` ship via build.extraResources in prod; in dev
  // they're read straight out of the repo. The `Template` suffix is what makes
  // macOS tint the glyph for light / dark / clicked menu-bar states.
  return isPackagedBuild()
    ? path.join(process.resourcesPath, 'tray', 'trayTemplate.png')
    : path.join(__dirname, '..', 'build', 'tray', 'trayTemplate.png');
}

/** Trim a track / artist name to something a menu can show on one line. */
function ellipsize(text: string, max = 38): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function sendTransport(action: 'toggle' | 'next' | 'previous'): void {
  // No renderer means no Spotify session to command — show the window so the
  // user can see why nothing happened rather than failing silently.
  if (!win || win.isDestroyed()) {
    void showWindow();
    return;
  }
  win.webContents.send('app-event:transport', action);
}

function setLaunchAtLogin(enabled: boolean): void {
  app.setLoginItemSettings({
    openAtLogin: enabled,
    // Our own flag rather than `openAsHidden`, which macOS ignores since
    // Ventura. Read back by shouldStartHidden().
    args: enabled ? ['--hidden'] : [],
  });
  refreshTray();
  win?.webContents.send('app-event:login-item', enabled);
}

function isLaunchAtLoginEnabled(): boolean {
  try {
    return app.getLoginItemSettings().openAtLogin;
  } catch {
    return false;
  }
}

function buildTrayMenu(): Electron.Menu {
  const np = nowPlaying;
  const items: Electron.MenuItemConstructorOptions[] = [];

  if (np && np.title) {
    items.push({ label: ellipsize(np.title), enabled: false });
    if (np.artist) items.push({ label: ellipsize(np.artist), enabled: false });
    items.push({ type: 'separator' });
  }

  items.push(
    { label: np?.isPlaying ? 'Pause' : 'Play', click: () => sendTransport('toggle') },
    { label: 'Next Track', click: () => sendTransport('next') },
    { label: 'Previous Track', click: () => sendTransport('previous') },
    { type: 'separator' },
    { label: 'Show Window', click: () => void showWindow() },
    {
      label: 'Launch at Login',
      type: 'checkbox',
      checked: isLaunchAtLoginEnabled(),
      click: (item) => setLaunchAtLogin(item.checked),
    },
    {
      label: 'Notch HUD',
      type: 'checkbox',
      checked: isNotchEnabled(),
      click: (item) => toggleNotch(item.checked),
    },
    { type: 'separator' },
    {
      // Accelerator here is display-only (tray menus don't register global
      // keys); the working Cmd+Q is the app menu's `role: 'quit'`.
      label: `Quit ${app.name}`,
      accelerator: 'Command+Q',
      click: () => app.quit(),
    },
  );

  return Menu.buildFromTemplate(items);
}

function refreshTray(): void {
  if (!tray || tray.isDestroyed()) return;
  tray.setContextMenu(buildTrayMenu());
  tray.setToolTip(
    nowPlaying?.title
      ? `${nowPlaying.title} — ${nowPlaying.artist}`
      : `${app.name} — nothing playing`,
  );
}

function createTray(): void {
  const image = nativeImage.createFromPath(trayIconPath());
  if (image.isEmpty()) {
    // Missing or unreadable asset. A tray with an empty image renders as an
    // invisible, unclickable gap in the menu bar — worse than no tray, since
    // a hidden window would then be unreachable. Skip it and leave the dock
    // icon permanently on so the app stays usable.
    console.error(`[main] tray icon missing at ${trayIconPath()} — tray disabled`);
    return;
  }
  image.setTemplateImage(true);
  tray = new Tray(image);
  // Left-click opens the same menu as right-click. A bare left-click that
  // toggled the window would fight the menu on a trackpad.
  tray.on('click', () => tray?.popUpContextMenu());
  refreshTray();
}

/**
 * Window chrome, per platform. The app draws its own title area (ChromeBar)
 * everywhere, so what differs is where the OS puts its window controls.
 *
 *  - macOS: 'hiddenInset' drops the title bar but keeps the traffic lights,
 *    nudged inward so they sit inside our chrome. `.topbar` reserves 70px on
 *    the LEFT for them.
 *  - Windows: 'hiddenInset' is simply ignored, which would leave a native
 *    title bar stacked above our chrome. 'hidden' removes it, and
 *    `titleBarOverlay` paints the native minimize/maximize/close buttons over
 *    our chrome on the RIGHT. The overlay is not optional: with a plain
 *    'hidden' title bar and no overlay the window would have no close button.
 *    Height is left unset so it follows the system caption height.
 *  - Anything else: leave the default frame in place.
 */
function titleBarOptions(): Partial<Electron.BrowserWindowConstructorOptions> {
  if (process.platform === 'darwin') return { titleBarStyle: 'hiddenInset' };
  if (process.platform === 'win32') {
    return {
      titleBarStyle: 'hidden',
      titleBarOverlay: { color: '#0a0a0a', symbolColor: '#e5e5e5' },
    };
  }
  return {};
}

function createWindow(startHidden = false) {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 640,
    minHeight: 420,
    ...titleBarOptions(),
    backgroundColor: '#0a0a0a',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.once('ready-to-show', () => {
    if (startHidden) {
      // Never shown at all on a login launch. Cheaper and safer than
      // show-then-hide: the window never gets a visible GPU surface, and
      // the user sees no flash.
      if (process.platform === 'darwin' && app.dock) app.dock.hide();
      return;
    }
    win?.show();
  });

  /**
   * X-button quits the app outright — window, notch HUD and all.
   *
   * This used to hide the window and leave the app in the menu bar. With the
   * notch HUD that read as the app refusing to close: the window vanished and
   * a panel belonging to it stayed on screen, over every Space, with no
   * obvious way to get rid of it.
   *
   * Staying resident is still available and now has to be asked for, which is
   * the honest way round: Settings → "Hide to menu bar", or simply switching
   * to another app. Both keep the HUD alive, which is what it is for.
   *
   * Older history worth keeping: hide-on-close once left the visualizer
   * worker's OffscreenCanvas holding its GPU surface and the window came back
   * black. The renderer now pauses that worker on `visibilitychange` (see
   * WaveformVisualizer's `active` gate), so the hidden path is safe — it is
   * simply no longer what X does.
   */
  win.on('close', () => app.quit());

  // Block renderer-initiated new windows. The only legitimate "open externally"
  // path is the allowlisted `shell:open-external` IPC handler.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  // Block in-renderer navigation to anywhere other than our app shell. If the
  // renderer tries to navigate (e.g. via a stray <a href> or some malicious
  // injection), route it through the allowlisted external-open path instead.
  const allowedPrefix = process.env.VITE_DEV_SERVER_URL ?? 'file://';
  win.webContents.on('will-navigate', (e, url) => {
    if (url.startsWith(allowedPrefix)) return;
    e.preventDefault();
    if (isAllowedExternalUrl(url)) void shell.openExternal(url);
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    win.loadURL(process.env.VITE_DEV_SERVER_URL);
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    win.loadFile(path.join(__dirname, '../dist/index.html'));
  }
}

/**
 * Wait for the Spotify OAuth callback on 127.0.0.1:8888. Resolves with the
 * authorization code (and the state we round-tripped through). The HTTP
 * server is one-shot — it accepts the first matching callback then closes.
 *
 * If a request comes in that doesn't match the expected state we reject —
 * defends against CSRF on a public loopback port.
 */
function awaitSpotifyAuthCallback(expectedState: string, timeoutMs: number): Promise<{ code: string }> {
  return new Promise((resolve, reject) => {
    if (authServer) {
      authServer.close();
      authServer = null;
    }

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Spotify auth timed out — no callback received'));
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timer);
      if (authServer) {
        authServer.close();
        authServer = null;
      }
    };

    authServer = http.createServer((req, res) => {
      if (!req.url) return;
      const url = new URL(req.url, 'http://127.0.0.1:8888');
      if (url.pathname !== '/callback') {
        res.writeHead(404).end();
        return;
      }

      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      const error = url.searchParams.get('error');

      if (error) {
        respond(res, '#ff6b6b', 'Authorization denied', `Spotify said: ${error}`);
        cleanup();
        reject(new Error(`Spotify auth error: ${error}`));
        return;
      }

      if (!code || state !== expectedState) {
        respond(res, '#ff6b6b', 'Authorization failed', 'State mismatch or missing code.');
        cleanup();
        reject(new Error('Invalid Spotify callback (state mismatch or missing code)'));
        return;
      }

      respond(res, '#1DB954', 'Connected to Spotify ✓', 'You can close this tab and return to the app.');
      cleanup();
      resolve({ code });
    });

    authServer.on('error', (err) => {
      cleanup();
      reject(err);
    });

    authServer.listen(8888, '127.0.0.1');
  });
}

function respond(res: http.ServerResponse, accent: string, title: string, sub: string) {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html>
<html><head><title>${title}</title>
<style>
  html,body{margin:0;height:100%;background:#0a0a0a;color:#e8e8e8;font-family:-apple-system,system-ui,sans-serif}
  body{display:flex;align-items:center;justify-content:center}
  .card{text-align:center;padding:40px 56px;border-radius:14px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08)}
  h1{margin:0 0 8px;font-size:18px;color:${accent}}
  p{margin:0;color:rgba(255,255,255,0.55);font-size:13px}
</style>
</head><body><div class="card"><h1>${title}</h1><p>${sub}</p></div></body></html>`);
}

ipcMain.handle('spotify-auth:listen', async (_event, expectedState: string) => {
  return awaitSpotifyAuthCallback(expectedState, 5 * 60 * 1000); // 5-min cap
});

ipcMain.handle('spotify-auth:cancel', () => {
  if (authServer) {
    authServer.close();
    authServer = null;
  }
});

/**
 * Allowlist for `openExternal`. Without this, a renderer XSS becomes an
 * "open anything" primitive — including `file:`, custom schemes, and any
 * https URL. The renderer only legitimately opens Spotify auth / dashboard
 * URLs, so restrict to those hosts.
 */
function isAllowedExternalUrl(url: string): boolean {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return false; }
  if (parsed.protocol !== 'https:') return false;
  if (parsed.host === 'accounts.spotify.com' || parsed.host === 'developer.spotify.com') return true;
  /*
   * This project's repo, and nothing else on GitHub, so the allowlist never
   * becomes a generic open-anything primitive.
   *
   * It used to permit only `/releases`, which quietly broke both feedback
   * buttons in Settings: they build `/issues/new?...`, the handler threw
   * "Refusing to open disallowed URL", and the renderer discarded the
   * rejection with `void`. The buttons did nothing at all, with no error
   * anywhere the user or the console would show it.
   *
   * Derived from REPO_URL rather than written out again — two copies of the
   * repo path is how the previous version came to disagree with the URLs the
   * app actually builds.
   *
   * Matched as an exact path or a path prefix ending in "/", never a bare
   * `startsWith`: `/omkarxpatel/ElectronEvil` would satisfy that.
   */
  const repoPath = new URL(REPO_URL).pathname.replace(/\/$/, '');
  if (
    parsed.host === 'github.com' &&
    (parsed.pathname === repoPath || parsed.pathname.startsWith(`${repoPath}/`))
  ) {
    return true;
  }
  return false;
}

ipcMain.on('app:version', (event) => {
  // Sync IPC at preload-init time so the renderer can read window.api.app.version
  // as a plain string instead of an async getter.
  event.returnValue = app.getVersion();
});

const execFileAsync = promisify(execFile);

/** `open` should return almost immediately; this only guards a wedged call. */
const SPOTIFY_LAUNCH_TIMEOUT_MS = 10000;

/**
 * Start the Spotify desktop client without ever showing it.
 *
 * This app is a control surface: every transport call commands some other
 * Spotify Connect device, so with Spotify not running there is nothing to
 * command and the user has to go open it by hand — the exact trip the app
 * exists to avoid.
 *
 * `-g` keeps focus on our window and `-j` starts Spotify hidden, so it comes
 * up as a background process that never takes over the screen. Neither flag
 * needs Accessibility permission. Hiding an *already visible* Spotify would
 * need System Events and a TCC prompt, which is why this covers the launch
 * case only.
 */
ipcMain.handle('spotify-app:launch-hidden', async (): Promise<{ ok: boolean; reason?: string }> => {
  if (process.platform !== 'darwin') return { ok: false, reason: 'unsupported' };
  try {
    await execFileAsync('open', ['-gj', '-a', 'Spotify'], {
      timeout: SPOTIFY_LAUNCH_TIMEOUT_MS,
    });
    return { ok: true };
  } catch (err) {
    // `open` exits non-zero when there's no such app. Separating that from a
    // generic failure lets the renderer say "Spotify isn't installed" rather
    // than something the user can't act on.
    const notInstalled = /Unable to find application/i.test(String(err));
    return { ok: false, reason: notInstalled ? 'not-installed' : 'failed' };
  }
});

/**
 * Playlist folders, read out of the Spotify desktop client's own cache.
 *
 * The Web API has no folder field and the internal rootlist endpoint refuses
 * third-party tokens, so this local cache is the only source there is. It
 * resolves to `unavailable` rather than rejecting — see spotifyFolders.ts.
 */
ipcMain.handle('spotify-folders:read', () => readSpotifyRootlist());

// The DJ's commentary, rendered to a buffer rather than spoken to the default
// output device. See electron/speech.ts — in Live mode the default device is
// BlackHole, so anything spoken there is captured by our own tap and folded
// into the key, tempo and loudness we record for whatever is playing.
ipcMain.handle('speech:render', (_event, text: unknown, voice: unknown) =>
  renderSpeech(text, voice),
);

ipcMain.handle('shell:open-external', async (_event, url: string) => {
  if (typeof url !== 'string' || !isAllowedExternalUrl(url)) {
    throw new Error(`Refusing to open disallowed URL`);
  }
  await shell.openExternal(url);
});

/**
 * Register a display-media request handler so the renderer can use
 * `navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })`
 * to capture *system audio* on macOS without any virtual audio device
 * (no BlackHole, no eqMac). The magic value is `audio: 'loopback'` — it
 * tells Electron to wire the OS audio mix directly into the stream.
 *
 * On first use macOS will prompt the user for Screen Recording permission
 * (System Settings → Privacy & Security → Screen Recording). The video
 * track from the request is dropped in the renderer — we only want audio.
 */
function registerDisplayMediaHandler(): void {
  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    try {
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: 0, height: 0 },
        fetchWindowIcons: false,
      });
      if (sources.length === 0) {
        callback({});
        return;
      }
      // 'loopback' = system audio captured, speakers continue to play normally
      // 'loopbackWithMute' = system audio captured AND speakers silenced for
      //                     the captured sources (use when WE will play the
      //                     processed audio back).
      // Our own process is excluded from the loopback either way, so we
      //   can play back through speakers without feedback.
      const audioMode: 'loopback' | 'loopbackWithMute' = systemAudioMuted
        ? 'loopbackWithMute'
        : 'loopback';
      callback({ video: sources[0], audio: audioMode });
    } catch (err) {
      console.error('display-media handler failed:', err);
      callback({});
    }
  });
}

ipcMain.handle('system-audio:set-mute', (_event, mute: boolean) => {
  systemAudioMuted = !!mute;
});

/**
 * Output-sink volume pinning. See electron/deviceVolume.ts — in short, the
 * macOS slider can only reach the DEFAULT output device, so once system audio
 * is routed through BlackHole the device we actually play out of is stuck at
 * whatever level it happened to hold, capping how loud the app can get.
 */
ipcMain.handle('sink-volume:pin', (_event, deviceLabel: unknown) =>
  pinSinkToUnity(typeof deviceLabel === 'string' ? deviceLabel : ''),
);

ipcMain.handle('sink-volume:restore', () => restoreSink());

ipcMain.on('sink-volume:get-state', (event) => {
  event.returnValue = getSinkVolumeState();
});

/**
 * Renderer → main now-playing mirror. The renderer is the only thing holding
 * a Spotify session, so the tray can't read playback itself; it gets told.
 * Coerced and length-capped here because this crosses the IPC boundary and
 * ends up as menu-item labels.
 */
ipcMain.on('tray:now-playing', (_event, payload: unknown) => {
  if (!payload || typeof payload !== 'object') {
    nowPlaying = null;
    refreshTray();
    return;
  }
  const p = payload as Record<string, unknown>;
  const title = typeof p.title === 'string' ? p.title.slice(0, 120) : '';
  const artist = typeof p.artist === 'string' ? p.artist.slice(0, 120) : '';
  nowPlaying = title ? { title, artist, isPlaying: p.isPlaying === true } : null;
  refreshTray();
});

ipcMain.handle('notch:get-enabled', () => isNotchEnabled());

ipcMain.handle('notch:set-enabled', (_event, enabled: unknown) => {
  toggleNotch(enabled === true);
  return isNotchEnabled();
});

ipcMain.handle('login-item:get', () => isLaunchAtLoginEnabled());

ipcMain.handle('login-item:set', (_event, enabled: unknown) => {
  setLaunchAtLogin(enabled === true);
  return isLaunchAtLoginEnabled();
});

/** Lets the renderer hide to the menu bar (used by the Settings toggle's
 *  companion action and anything else that wants to tuck the app away). */
ipcMain.handle('window:hide', () => {
  hideWindow();
});

// ── Device performance profile ─────────────────────────────────────────────
// Driven from the renderer rather than gathered at startup, deliberately:
// app.getGPUFeatureStatus() reports software rasterisation for everything
// until a window has finished loading, so resolving this at `whenReady()`
// would pin every user to the lowest tier. The renderer invoking us is proof
// that a window is up. See electron/deviceProfile.ts.
ipcMain.handle('device-profile:resolve', (_event, info: RendererInfo) => resolveProfile(info));

ipcMain.handle('device-profile:set-tier', (_event, tier: QualityTier) => setTier(tier));

ipcMain.handle('device-profile:decline-test', (_event, token: string) => declineTest(token));

ipcMain.handle(
  'device-profile:record-calibration',
  (_event, tier: QualityTier, calibration: Calibration) => recordCalibration(tier, calibration),
);

/**
 * Native About panel content. Triggered by the app-menu "About …" item.
 * macOS renders this with the app icon, app name, version, and our copyright /
 * credits / homepage links — feels like a real macOS app rather than an
 * Electron shell.
 */
function setupAboutPanel(): void {
  app.setAboutPanelOptions({
    applicationName: 'Electron',
    applicationVersion: app.getVersion(),
    copyright: 'Copyright © 2026 Omkar Patel',
    credits: 'Built with Electron, React, Web Audio API.\nSpotify integration via PKCE OAuth.\nLyrics from lrclib.net and lyrics.ovh.',
    website: REPO_URL,
    iconPath: isPackagedBuild()
      ? path.join(process.resourcesPath, 'icon.icns')
      : path.join(__dirname, '..', 'build', 'icon.png'),
  });
}

/**
 * Build and install the application menu. macOS expects the standard
 * App / Edit / View / Window / Help structure; without this users are
 * stuck with Electron's default which is missing Edit shortcuts (cut/
 * copy/paste don't work in text inputs), no Quit accelerator on the
 * app menu, and no Help-menu entry pointing at the project.
 */
function buildAppMenu(): void {
  const isMac = process.platform === 'darwin';
  const template: Electron.MenuItemConstructorOptions[] = [
    // App menu — only shown on macOS. Includes About / Hide / Quit by default
    // via `role: 'appMenu'`. We override the default About item with our own
    // (which opens the native About panel configured above).
    ...(isMac
      ? ([{
          label: app.name,
          submenu: [
            { role: 'about' },
            { type: 'separator' },
            {
              // Standard macOS shortcut for app preferences; fires an IPC
              // event to the renderer which opens the Settings drawer.
              label: 'Settings…',
              accelerator: 'CmdOrCtrl+,',
              click: () => win?.webContents.send('app-event:preferences'),
            },
            { type: 'separator' },
            { role: 'services' },
            { type: 'separator' },
            { role: 'hide' },
            { role: 'hideOthers' },
            { role: 'unhide' },
            { type: 'separator' },
            { role: 'quit' },
          ],
        }] as Electron.MenuItemConstructorOptions[])
      : []),

    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },

    {
      label: 'View',
      submenu: [
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        // Reload + Force Reload are dev-only — they reset all renderer state
        // including Spotify auth, AI tick, audio context. Useful when iterating
        // on the dev server; destructive in production.
        ...(!isPackagedBuild()
          ? ([
              { type: 'separator' },
              { role: 'reload' },
              { role: 'forceReload' },
            ] as Electron.MenuItemConstructorOptions[])
          : []),
        // Developer Tools stays available in packaged builds. Standard for
        // OSS Electron apps (Slack, Discord, Signal all ship with it). Lets
        // power users inspect production behavior, clear localStorage for
        // debug purposes (e.g. forcing an update re-check), and report
        // issues with real console errors attached. Not a security risk —
        // the renderer is already locked down via CSP + contextIsolation.
        { type: 'separator' },
        { role: 'toggleDevTools' },
      ],
    },

    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        ...(isMac
          ? ([
              { type: 'separator' },
              { role: 'front' },
              { type: 'separator' },
              { role: 'window' },
            ] as Electron.MenuItemConstructorOptions[])
          : []),
      ],
    },

    {
      role: 'help',
      submenu: [
        {
          label: 'Project on GitHub',
          click: () => void shell.openExternal(REPO_URL),
        },
        {
          label: 'Report an Issue',
          click: () => void shell.openExternal(ISSUES_URL),
        },
        {
          label: 'Check for Updates',
          click: () => void shell.openExternal(RELEASES_URL),
        },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/**
 * Right-click-dock context menu. macOS shows these items below the
 * default "Options / Show in Finder / Quit" entries when the user
 * right-clicks (or two-finger-clicks, or long-clicks) the dock icon.
 * Doesn't need renderer IPC — Show/Hide operate on the window directly.
 */
function buildDockMenu(): void {
  if (process.platform !== 'darwin' || !app.dock) return;
  app.dock.setMenu(Menu.buildFromTemplate([
    {
      label: `Show ${app.name}`,
      click: () => void showWindow(),
    },
    {
      label: `Hide ${app.name}`,
      click: () => hideWindow(),
    },
  ]));
}

app.whenReady().then(async () => {
  if (process.platform === 'darwin') {
    try {
      await systemPreferences.askForMediaAccess('microphone');
    } catch {
      // user can grant later via System Settings → Privacy & Security → Microphone
    }
  }

  const startHidden = shouldStartHidden();
  // Before the window exists, so a login launch never flashes a dock icon.
  if (startHidden && process.platform === 'darwin' && app.dock) app.dock.hide();

  setupAboutPanel();
  buildAppMenu();
  buildDockMenu();
  registerDisplayMediaHandler();
  createTray();
  createWindow(startHidden);
  // After createWindow: the panel replays its last state on load, and the
  // only thing that can produce that state is the renderer we just created.
  initNotch(sendNotchCommand);
  setNotchEnabled(readNotchPref());
  syncDockVisibility();
  setupAutoUpdater();

  // A pin file surviving from a previous run means we died holding someone's
  // output device at 100%. Undo it before anything else can play through it.
  void restoreStalePin();
  onSinkVolumeChange((next: SinkVolumeState) => {
    if (win && !win.isDestroyed()) {
      win.webContents.send('sink-volume:state', next);
    }
  });

  // Clicking the dock icon (or Cmd+Tabbing back) on macOS. If we still have
  // a window object, just show it (preserves all state). If somehow the
  // window was destroyed, recreate.
  app.on('activate', () => {
    void showWindow();
  });
});

app.on('before-quit', () => {
  // Cmd+Q, the App menu's Quit, the tray's Quit and a logout-initiated
  // shutdown all arrive here.
  //
  // Notch first, before anything slower: it floats above other Spaces, so a
  // panel left behind is the most visible part of a quit still in progress.
  shutdownNotch();
  if (authServer) {
    authServer.close();
    authServer = null;
  }
  teardownAutoUpdater();
  // Synchronous-ish: before-quit gives us no chance to await, so this spawns
  // the helper detached rather than leaving the device pinned at 100%.
  restoreSinkOnQuit();
});

app.on('window-all-closed', () => {
  // On macOS the tray keeps the app alive with no window — that's the whole
  // point of the menu-bar mode, and this only fires if the window was
  // genuinely destroyed (a crash, or a real quit) rather than hidden.
  // Elsewhere there's no tray story, so last window closed = quit.
  if (process.platform !== 'darwin') app.quit();
});

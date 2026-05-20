import { app, BrowserWindow, Menu, systemPreferences, ipcMain, shell, session, desktopCapturer } from 'electron';
import path from 'node:path';
import http from 'node:http';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const REPO_URL = 'https://github.com/omkarxpatel/Spotify-Visualizer-Modifier';
const ISSUES_URL = `${REPO_URL}/issues`;
const RELEASES_URL = `${REPO_URL}/releases`;

let win: BrowserWindow | null = null;
let authServer: http.Server | null = null;

/**
 * Tracks whether the user has initiated an actual quit (Cmd+Q, app menu).
 * Set in `before-quit`, read in the BrowserWindow `close` handler so we can
 * tell "user closed the window" (which should hide) from "user is quitting
 * the app" (which should let the close go through).
 */
let quitting = false;

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
  app.on('second-instance', () => {
    if (!win || win.isDestroyed()) {
      createWindow();
      return;
    }
    if (win.isMinimized()) win.restore();
    if (!win.isVisible()) win.show();
    win.focus();
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

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 640,
    minHeight: 420,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0a0a0a',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.once('ready-to-show', () => win?.show());

  // macOS pattern: clicking the red close button hides the window instead of
  // destroying it. This preserves all app state (audio context, AI tick,
  // Spotify polling, settings) and matches how Mail / Music / Photos / every
  // first-party Apple app behaves. The user quits via Cmd+Q, which flips
  // the `quitting` flag (see `before-quit`) and lets the close go through.
  //
  // IMPORTANT: only enable hide-on-close in the PACKAGED (production) app.
  // In dev mode, vite-plugin-electron restarts the main process on file
  // changes; if our close handler intercepts and hides, the old hidden
  // window never goes away and the new electron process spawns a fresh
  // one alongside. The single-instance lock above mitigates this, but
  // it's simpler and less surprising for dev to just let close = quit.
  win.on('close', (e) => {
    if (quitting || process.platform !== 'darwin' || !app.isPackaged) return;
    e.preventDefault();
    win?.hide();
  });

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
  // GitHub URLs needed by the update checker — release pages + DMG download
  // links. Scope to this project's repo only so the allowlist doesn't double
  // as a generic GitHub-anywhere primitive.
  if (
    parsed.host === 'github.com' &&
    parsed.pathname.startsWith('/omkarxpatel/Spotify-Visualizer-Modifier/releases')
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
 * Native About panel content. Triggered by the app-menu "About …" item.
 * macOS renders this with the app icon, app name, version, and our copyright /
 * credits / homepage links — feels like a real macOS app rather than an
 * Electron shell.
 */
function setupAboutPanel(): void {
  app.setAboutPanelOptions({
    applicationName: 'Audio Visualizer & Modifier',
    applicationVersion: app.getVersion(),
    copyright: 'Copyright © 2026 Omkar Patel',
    credits: 'Built with Electron, React, Web Audio API.\nSpotify integration via PKCE OAuth.\nLyrics from lrclib.net and lyrics.ovh.',
    website: REPO_URL,
    iconPath: app.isPackaged
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
        // DevTools only in dev builds — not exposed in the shipped DMG.
        ...(!app.isPackaged
          ? ([
              { type: 'separator' },
              { role: 'reload' },
              { role: 'forceReload' },
              { role: 'toggleDevTools' },
            ] as Electron.MenuItemConstructorOptions[])
          : []),
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
      label: 'Show Audio Visualizer',
      click: () => {
        if (!win || win.isDestroyed()) {
          createWindow();
          return;
        }
        if (!win.isVisible()) win.show();
        win.focus();
      },
    },
    {
      label: 'Hide Audio Visualizer',
      click: () => {
        if (win && !win.isDestroyed() && win.isVisible()) win.hide();
      },
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

  setupAboutPanel();
  buildAppMenu();
  buildDockMenu();
  registerDisplayMediaHandler();
  createWindow();

  // Clicking the dock icon (or Cmd+Tabbing back) on macOS. If we still have
  // a window object, just show it (preserves all state). If somehow the
  // window was destroyed, recreate.
  app.on('activate', () => {
    if (win && !win.isDestroyed()) {
      if (!win.isVisible()) win.show();
      win.focus();
      return;
    }
    createWindow();
  });
});

app.on('before-quit', () => {
  quitting = true;
  if (authServer) {
    authServer.close();
    authServer = null;
  }
});

app.on('window-all-closed', () => {
  // On macOS this fires only after `before-quit` (because we hide instead of
  // close), so it's effectively the very-last cleanup hook. On non-darwin
  // closing the last window quits the app — standard cross-platform pattern.
  if (process.platform !== 'darwin') app.quit();
});

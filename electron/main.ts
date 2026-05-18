import { app, BrowserWindow, systemPreferences, ipcMain, shell, session, desktopCapturer } from 'electron';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let win: BrowserWindow | null = null;
let authServer: http.Server | null = null;

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
  return parsed.host === 'accounts.spotify.com' || parsed.host === 'developer.spotify.com';
}

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

app.whenReady().then(async () => {
  if (process.platform === 'darwin') {
    try {
      await systemPreferences.askForMediaAccess('microphone');
    } catch {
      // user can grant later via System Settings → Privacy & Security → Microphone
    }
  }

  registerDisplayMediaHandler();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (authServer) {
    authServer.close();
    authServer = null;
  }
  if (process.platform !== 'darwin') app.quit();
});

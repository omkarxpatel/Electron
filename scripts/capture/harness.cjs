/*
 * Electron main process for `npm run capture`.
 *
 * Deliberately NOT the app's own main.ts. Two reasons: main.ts's
 * killStaleInstances() SIGTERMs every Electron under node_modules, which
 * would take down whatever dev instance the user has running; and the real
 * main process owns a tray, an updater and a single-instance lock that a
 * screenshot run has no business touching.
 *
 * So this is a minimal host that serves the same renderer, stubs the IPC the
 * preload expects, and captures windows with webContents.capturePage() —
 * which reads the window's own buffer and therefore needs no Screen
 * Recording permission and can never catch anything else on screen.
 */

const { app, BrowserWindow, ipcMain, nativeImage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const cfg = JSON.parse(process.argv[process.argv.length - 1]);
const { stageDir, preload, outDir, scenes, appVersion } = cfg;

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// Scenes are captured one window at a time, so destroying a window leaves
// zero open — and Electron's DEFAULT window-all-closed behaviour is to quit.
// That killed the run between the last capture and writing its results: every
// PNG landed on disk and the caller was told nothing had been produced.
app.on('window-all-closed', () => {});

// ── IPC stubs ─────────────────────────────────────────────────────────────
// The preload runs before any window script and calls sendSync immediately,
// so this has to be registered before the first load, not on demand.
ipcMain.on('app:version', (e) => {
  e.returnValue = appVersion;
});
// The updater's preload also reads its state synchronously at startup.
ipcMain.on('update:get-state', (e) => {
  e.returnValue = { kind: 'idle' };
});
// Sink-volume pinning reads its state synchronously at startup too. A
// capture must never touch the real machine's audio devices, so this reports
// 'idle' and the pin notice stays out of every screenshot.
ipcMain.on('sink-volume:get-state', (e) => {
  e.returnValue = { kind: 'idle' };
});
// Everything else: accept and return nothing. The renderer treats a rejected
// or empty bridge call as "feature unavailable" and renders its default,
// which for the quality tier is full quality — exactly what we want in a
// screenshot.
const INVOKE = [
  'device-profile:resolve', 'device-profile:set-tier', 'device-profile:decline-test',
  'device-profile:record-calibration', 'notch:get-enabled', 'notch:set-enabled',
  'login-item:get', 'login-item:set', 'shell:open-external', 'window:hide',
  'spotify-auth:listen', 'spotify-auth:cancel', 'system-audio:set-mute',
  'spotify-app:launch-hidden', 'update:check', 'update:state', 'update:install',
  'update:open-fallback', 'update:dismiss-version',
  'sink-volume:pin', 'sink-volume:restore',
];
for (const ch of INVOKE) ipcMain.handle(ch, () => null);
for (const ch of ['tray:now-playing', 'notch:state', 'notch:command', 'update:set-activity']) {
  ipcMain.on(ch, () => {});
}

// ── Helpers ───────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Synchronous. console.log is buffered and app.quit() exits before the
 *  buffer flushes, which silently ate both the results and the reason a
 *  scene failed — the two things a capture run exists to tell you. */
const say = (msg) => process.stderr.write(`${msg}\n`);

function makeWindow(width, height, visible = false) {
  const w = new BrowserWindow({
    width,
    height,
    // Clips need the window composited or captureStream() produces a track
    // that never delivers a frame. Parked far off-screen so it is still
    // invisible to whoever is at the machine.
    show: visible,
    ...(visible ? { x: -4000, y: -4000 } : {}),
    frame: false,
    backgroundColor: '#0a0a0a',
    webPreferences: {
      preload,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // The window is never visible, and an occluded/hidden renderer has its
      // rAF clamped to zero — which would capture a frozen visualiser.
      backgroundThrottling: false,
    },
  });
  // A blank capture is almost always a renderer exception, and without this
  // the run just reports "never became ready" with no cause.
  w.webContents.on('console-message', (_e, level, msg) => {
    if (level >= 2) say(`[capture] renderer: ${msg.slice(0, 300)}`);
  });
  w.webContents.on('did-fail-load', (_e, code, desc, url) =>
    say(`[capture] load failed ${code} ${desc} ${url}`));
  return w;
}

async function waitForApp(win, timeoutMs = 15000) {
  const started = Date.now();
  for (;;) {
    const ok = await win.webContents
      .executeJavaScript('!!(window.__cap && window.__cap.ready())')
      .catch(() => false);
    if (ok) return true;
    if (Date.now() - started > timeoutMs) return false;
    await sleep(200);
  }
}

/*
 * Clips are recorded INSIDE the renderer, off the visualiser's own canvas.
 *
 * The obvious approach — capturePage in a loop — cannot produce usable video.
 * Measured against the real app: 110 frames took 14.8s, i.e. 7 fps, because
 * each capture waits on a compositor that is already busy drawing. Encoding
 * 7 fps of samples at any higher rate is what made the first clip look
 * laggy: choppy from the sample rate, and sped up on top of it.
 *
 * canvas.captureStream() taps the canvas directly and runs in real time, so
 * six seconds of wall clock gives six seconds of smooth video. It works even
 * though the app transfers that canvas to a worker, which was the one thing
 * worth checking first.
 *
 * The trade-off is that it records the canvas and nothing else — no
 * surrounding chrome. For a visualiser clip that is the subject anyway.
 */
async function recordCanvas(win, scene) {
  const { seconds = 6, fps = 30, selector = 'canvas', bitrate = 2_600_000 } = scene.clip;
  const res = await win.webContents.executeJavaScript(`(async () => {
    // Largest canvas: the app also has the EQ curve and the wave strip, and
    // the visualiser is always the biggest of them.
    const c = [...document.querySelectorAll(${JSON.stringify(selector)})]
      .sort((a, b) => b.width * b.height - a.width * a.height)[0];
    if (!c) throw new Error('no canvas matched ${selector}');
    const stream = c.captureStream(${fps});
    if (!stream.getVideoTracks().length) throw new Error('canvas stream has no video track');
    const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
      ? 'video/webm;codecs=vp9' : 'video/webm';
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: ${bitrate} });
    const chunks = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    const stopped = new Promise((r) => (rec.onstop = r));
    rec.start();
    await new Promise((r) => setTimeout(r, ${seconds * 1000}));
    rec.stop();
    await stopped;
    const bytes = new Uint8Array(await new Blob(chunks, { type: 'video/webm' }).arrayBuffer());
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return { b64: btoa(bin), w: c.width, h: c.height };
  })()`);

  if (!res || !res.b64) throw new Error('recorder returned no data');
  const file = path.join(outDir, `${scene.name}.webm`);
  fs.writeFileSync(file, Buffer.from(res.b64, 'base64'));
  say(`[capture] ${scene.name}: ${seconds}s of ${res.w}x${res.h} canvas at ${fps} fps`);
  return { name: scene.name, file, width: res.w, height: res.h, bytes: fs.statSync(file).size };
}

async function shoot(win, name, scale) {
  let img = await win.webContents.capturePage();
  if (scale && scale !== 1) {
    const s = img.getSize();
    img = img.resize({ width: Math.round(s.width * scale), quality: 'best' });
  }
  const file = path.join(outDir, `${name}.png`);
  fs.writeFileSync(file, img.toPNG());
  const { width, height } = img.getSize();
  return { name, file, width, height, bytes: fs.statSync(file).size };
}

// ── Run ───────────────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const results = [];

  for (const scene of scenes) {
   // Per-scene isolation: one broken scene must not cost the whole run.
   let win = null;
   try {
    win = makeWindow(scene.width, scene.height, !!scene.clip);
    const page = scene.page === 'notch' ? 'notch.html' : 'index.html';
    // Each scene starts from empty storage so a previous scene's seeded
    // settings cannot leak into it.
    await win.webContents.session.clearStorageData({ storages: ['localstorage'] });
    await win.loadFile(path.join(stageDir, page), {
      query: { cap: Buffer.from(JSON.stringify(scene.capture || {})).toString('base64') },
    });

    if (page === 'index.html') {
      const ok = await waitForApp(win);
      if (!ok) {
        say(`[capture] ${scene.name}: app never became ready`);
        win.destroy();
        continue;
      }
    }

    // Windows that are normally driven by the main process — the notch panel
    // has no session of its own and renders nothing until it is told what is
    // playing.
    for (const [channel, payload] of scene.send || []) {
      win.webContents.send(channel, payload);
    }

    if (scene.prepare) {
      const r = await win.webContents.executeJavaScript(scene.prepare).catch((e) => {
        say(`[capture] ${scene.name}: prepare threw — ${e.message}`);
        return null;
      });
      // A selector that matched nothing is the most likely scene bug, and it
      // otherwise shows up as a correct-looking screenshot of the wrong view.
      if (r === false) say(`[capture] ${scene.name}: prepare returned false (selector matched nothing)`);
    }

    await sleep(scene.settleMs ?? 2500);
    if (scene.clip) {
      results.push(await recordCanvas(win, scene));
    } else {
      results.push(await shoot(win, scene.name, scene.scale));
    }
    say(`[capture] ${scene.name}: ok`);
   } catch (err) {
    say(`[capture] ${scene.name}: FAILED — ${err && err.stack ? err.stack.split('\n')[0] : err}`);
   } finally {
    if (win && !win.isDestroyed()) win.destroy();
   }
   await sleep(120);
  }

  // A file, not stdout: survives the quit, and lets the caller read results
  // even when Electron has written noise all over the console.
  fs.writeFileSync(path.join(outDir, '_results.json'), JSON.stringify(results, null, 1));
  app.quit();
});

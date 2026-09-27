#!/usr/bin/env node
/*
 * npm run capture — screenshots of the real app, taken by the app itself.
 *
 * Renders into an offscreen window and reads that window's own buffer with
 * webContents.capturePage(). Nothing else on the display can end up in the
 * output, and macOS Screen Recording permission is never involved.
 *
 * The renderer is unmodified. A shim injected ahead of the app bundle
 * replaces getUserMedia/enumerateDevices with a synthesised stream, so the
 * whole audio chain — EQ, analysers, meters, visualiser — runs on real
 * signal with no microphone, no BlackHole and no Spotify account, and
 * without reading the user's own settings.
 *
 *   npm run capture              all scenes
 *   npm run capture -- --only hero,eq
 *   npm run capture -- --no-build        reuse the existing dist/
 *   npm run capture -- --out docs/media
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const has = (name) => argv.includes(`--${name}`);

const outDir = resolve(root, flag('out', 'docs/media'));
const only = flag('only', null)?.split(',').map((s) => s.trim());

// ── Scenes ────────────────────────────────────────────────────────────────
// `settings` is merged into av.settings.v3 before the app's first render, so
// each scene opens already in the right state — no clicking, no transitions
// to wait out.

// Artwork for the notch scenes. SVG is fine HERE specifically: the panel is
// told its accent colour over IPC and never samples the image, so the canvas
// tainting that rules SVG out in fixtures.js does not apply. Generating it
// here keeps the scene self-contained.
const NOTCH_ART =
  'data:image/svg+xml,' +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="320">
      <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#5aa9e6"/><stop offset="1" stop-color="#16263f"/>
      </linearGradient></defs>
      <rect width="320" height="320" fill="url(#g)"/>
      <g fill="none" stroke="#fff" stroke-opacity=".26">
        <circle cx="128" cy="150" r="52" stroke-width="18"/>
        <circle cx="180" cy="196" r="88" stroke-width="26"/>
        <circle cx="96" cy="112" r="124" stroke-width="14"/>
      </g>
    </svg>`.replace(/\s+/g, ' '),
  );

const SCENES = [
  {
    name: 'hero',
    width: 1440, height: 900, scale: 1,
    capture: {
      // Bars in the banner: it is a thin strip, and a line-based style there
      // reads as a flat streak rather than a visualiser.
      settings: { waveformStyle: 'bars', palette: 'aurora', glow: 0.6, sensitivity: 1.6, barWidth: 5, barGap: 2 },
      playlistId: 'pl1',
    },
    settleMs: 3200,
  },
  {
    name: 'visuals-only',
    width: 1440, height: 900,
    // No album auto-tint here: the fixture artwork is a dark gradient, so
    // tinting from it drains the palette to near-black and the visualiser
    // disappears into the background.
    capture: { settings: { waveformStyle: 'particles', palette: 'aurora', glow: 0.65, sensitivity: 1.7, particleDensity: 1, particleSize: 1.1 } },
    // `immersive` is deliberately never persisted as true — booting into a
    // chrome-less window with no visible way out is a trap — so it has to be
    // toggled through the UI like a user would.
    prepare: `window.__cap.click('[aria-label="Visuals only"]')`,
    settleMs: 4000,
  },
  {
    // Motion, for the site. WebM because Chromium can encode it with no
    // external tool; a GIF for the README needs ffmpeg (see the header).
    name: 'visuals-only-clip',
    // Smaller than the stills on purpose. The canvas backing store is this
    // times devicePixelRatio, and the renderer could only push ~12 fps of
    // particles across 2560x1424 — the clip was smooth-speed but choppy.
    width: 820, height: 512,
    capture: { settings: { waveformStyle: 'particles', palette: 'aurora', glow: 0.65, sensitivity: 1.7 } },
    prepare: `window.__cap.click('[aria-label="Visuals only"]')`,
    settleMs: 3500,
    clip: { seconds: 6, fps: 30, bitrate: 1_700_000 },
  },
  {
    name: 'visualizer-bars',
    width: 1440, height: 900,
    capture: { settings: { waveformStyle: 'bars', palette: 'ember', sensitivity: 1.6, glow: 0.6 } },
    settleMs: 2600,
  },
  {
    name: 'visualizer-radial',
    width: 1440, height: 900,
    capture: { settings: { waveformStyle: 'radial', palette: 'cyberpunk', sensitivity: 1.6, glow: 0.6 } },
    settleMs: 2600,
  },
  {
    name: 'visualizer-silk',
    width: 1440, height: 900,
    capture: { settings: { waveformStyle: 'silk', palette: 'ocean', sensitivity: 1.8, glow: 0.6 } },
    settleMs: 3000,
  },
  {
    name: 'notch-expanded',
    page: 'notch', width: 600, height: 212,
    send: [
      ['notch:metrics', { menuBarHeight: 32 }],
      ['notch:state', {
        title: 'Paper Lanterns',
        artist: 'Violet Hours',
        artUrl: NOTCH_ART,
        accent: '#5aa9e6',
        ambient: '#2b4a7a',
        isPlaying: true,
        progressMs: 96000,
        durationMs: 202000,
        shuffle: true,
        saved: true,
        lyrics: [
          { time: 0, text: 'Turn the dial until the static clears' },
          { time: 88, text: 'We were never going anywhere in particular' },
        ],
      }],
      ['notch:expanded', true],
    ],
    settleMs: 1200,
  },
  {
    name: 'notch-idle',
    page: 'notch', width: 600, height: 212,
    send: [
      ['notch:metrics', { menuBarHeight: 32 }],
      ['notch:state', {
        title: 'Paper Lanterns', artist: 'Violet Hours', artUrl: NOTCH_ART,
        accent: '#5aa9e6', ambient: '#2b4a7a', isPlaying: true,
        progressMs: 96000, durationMs: 202000, shuffle: true, saved: true, lyrics: null,
      }],
      ['notch:expanded', false],
    ],
    settleMs: 900,
  },
];

// ── Build ─────────────────────────────────────────────────────────────────

if (!has('no-build')) {
  console.log('• building renderer…');
  execFileSync('npx', ['vite', 'build'], { cwd: root, stdio: 'inherit' });
}
if (!existsSync(join(root, 'dist', 'index.html'))) {
  console.error('dist/index.html missing — run without --no-build');
  process.exit(1);
}

// ── Stage ─────────────────────────────────────────────────────────────────
// A copy, so the shim never ends up in a shipped build.

const stage = join(os.tmpdir(), `av-capture-${process.pid}`);
rmSync(stage, { recursive: true, force: true });
cpSync(join(root, 'dist'), stage, { recursive: true });
cpSync(join(root, 'scripts/capture/shim.js'), join(stage, 'capture-shim.js'));
cpSync(join(root, 'scripts/capture/fixtures.js'), join(stage, 'capture-fixtures.js'));

for (const page of ['index.html', 'notch.html']) {
  const file = join(stage, page);
  if (!existsSync(file)) continue;
  let html = readFileSync(file, 'utf8');
  // Classic script, placed before the module bundle: modules are deferred, so
  // this is guaranteed to run first and patch the APIs before any app code.
  html = html.replace(
    '<script type="module"',
    '<script src="./capture-shim.js"></script>\n' +
      '    <script src="./capture-fixtures.js"></script>\n' +
      '    <script type="module"',
  );
  writeFileSync(file, html);
}

// ── Run ───────────────────────────────────────────────────────────────────

const scenes = SCENES.filter((s) => !only || only.includes(s.name));
if (!scenes.length) {
  console.error(`no scenes matched --only ${only?.join(',')}`);
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

console.log(`• capturing ${scenes.length} scene(s) → ${outDir}`);
const res = spawnSync(
  join(root, 'node_modules/.bin/electron'),
  [
    join(root, 'scripts/capture/harness.cjs'),
    `--user-data-dir=${join(stage, 'udd')}`,
    JSON.stringify({
      stageDir: stage,
      preload: join(root, 'dist-electron/preload.js'),
      outDir,
      appVersion: pkg.version,
      scenes,
    }),
  ],
  {
    cwd: root,
    // ELECTRON_RUN_AS_NODE leaks in from VSCode terminals and turns Electron
    // into plain Node, which fails with a bare `bad option:`.
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
    encoding: 'utf8',
  },
);

// Electron's own chatter, not ours.
const noise = /^\[\d+:|Autofill|Security Warning|electronjs\.org|consult|once the app|^Policy|^\s+this app|^\s*$/;
const keep = (out) => out.split('\n').filter((l) => !noise.test(l));

const stdout = keep(res.stdout || '');
const stderr = keep(res.stderr || '');
let shot = [];
const resultsFile = join(outDir, '_results.json');
try { shot = JSON.parse(readFileSync(resultsFile, 'utf8')); } catch { /* harness wrote none */ }
rmSync(resultsFile, { force: true });

for (const s of shot) {
  console.log(`  ✓ ${s.name.padEnd(20)} ${s.width}x${s.height}  ${(s.bytes / 1024).toFixed(0)} kB`);
}
// Clip sample rates are worth seeing on every run, not only on failure:
// encoding at the wrong rate is invisible in the file listing and obvious
// only once someone watches it.
for (const l of stderr.filter((l) => l.includes(' fps'))) console.log(`    ${l.replace('[capture] ', '')}`);

const missing = scenes.filter((s) => !shot.some((r) => r.name === s.name));
if (missing.length) {
  // A scene that produced nothing has to say why. Silent partial success is
  // the failure mode that wastes the most time here.
  console.error(`\n  ✗ ${missing.length} scene(s) produced nothing: ${missing.map((m) => m.name).join(', ')}`);
  const detail = [...stdout, ...stderr];
  if (detail.length) console.error(detail.map((l) => `    ${l}`).join('\n'));
}

rmSync(stage, { recursive: true, force: true });
process.exit(res.status ?? 0);

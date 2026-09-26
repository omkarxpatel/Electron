#!/usr/bin/env node
/**
 * Regression check for the adaptive-quality system: the frame-cap arithmetic
 * in `src/state/quality.ts`, and capability detection plus the persisted
 * performance profile in `electron/deviceProfile.ts`.
 *
 * There is no test suite in this repo and `npm run typecheck` can't tell you
 * that a stored profile failed to invalidate. Every failure this guards is
 * silent by construction — nothing errors, the app just runs at the wrong
 * quality tier forever:
 *
 *   - `app.getGPUFeatureStatus()` reports `disabled_software` for everything
 *     until a window has loaded. Read it a moment too early and every machine
 *     on earth is classified as having no GPU and pinned to the lowest tier.
 *     Verified on an M5 that benchmarks at 120 fps: software at `whenReady()`,
 *     `enabled` 188 ms later. This is why the check below loads a window first.
 *   - a stored measurement must not outlive the draw code it measured. The
 *     batching work that took radial from 17 fps to 120 would otherwise leave
 *     every existing user on the tier their old numbers justified.
 *   - declining the test must be scoped to the *instance* of the reason. Keyed
 *     to the category instead, one refusal silences the prompt for every future
 *     update — which is how a machine ends up never being re-measured.
 *
 * Unlike check-enhancer.mjs this needs a real Electron process (GPU status,
 * screen metrics and powerMonitor don't exist under plain node), so it bundles
 * the module and drives it inside one.
 *
 *   npm run check:quality
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const electronBin = join(
  repoRoot,
  'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron',
);
const esbuild = join(repoRoot, 'node_modules/.bin/esbuild');

const work = mkdtempSync(join(tmpdir(), 'av-profile-check-'));

/** The assertions, run inside Electron against the real module. */
const PROBE = `
const { app, BrowserWindow } = require('electron');
const dp = require(${JSON.stringify(join(work, 'deviceProfile.cjs'))});
const fs = require('fs'); const path = require('path');
const results = [];
const check = (n, c, d) => results.push({ n, ok: !!c, d: d === undefined ? '' : String(d) });

app.whenReady().then(async () => {
  // Load a window before touching GPU status — see the header.
  const win = new BrowserWindow({ show: false });
  await win.loadURL('data:text/html,<body>x</body>');

  const info = (rev) => ({ glRenderer: 'test-renderer', glVendor: 'test', drawRevision: rev });
  const file = path.join(app.getPath('userData'), 'perf-profile.json');
  if (fs.existsSync(file)) fs.unlinkSync(file);

  const a = dp.resolveProfile(info(2));
  check('first run offers the system test', a.prompt.kind === 'offer' && a.prompt.trigger === 'first-run', a.prompt.trigger);
  check('GPU status read after window load reports acceleration', a.capability.canvasAccelerated === true);
  check('display refresh is a whole number', Number.isInteger(a.capability.primary.refreshHz), a.capability.primary.refreshHz);
  check('a fresh profile starts as heuristic', a.profile.source === 'heuristic');
  check('profile is written to userData', fs.existsSync(file));

  const b = dp.resolveProfile(info(2));
  check('an unchanged machine is not re-prompted', b.prompt.kind === 'none', b.prompt.kind);
  check('an unchanged profile is reused verbatim', b.profile.observedAt === a.profile.observedAt);

  const cal = { probes: [{ style: 'radial', tier: 'high', fps: 118 }], ranAt: new Date().toISOString(), durationMs: 21000 };
  const rec = dp.recordCalibration('high', cal);
  check('a completed system test persists', rec.persisted === true && rec.profile.source === 'measured');
  const c = dp.resolveProfile(info(2));
  check('a measured tier survives reload', c.profile.tier === 'high' && c.profile.calibration !== null);
  check('a measured profile stops prompting', c.prompt.kind === 'none');

  const d = dp.resolveProfile(info(3));
  check('a drawRevision bump re-prompts', d.prompt.kind === 'offer' && d.prompt.trigger === 'draw-revision', d.prompt.trigger);
  check('a drawRevision bump discards the stale measurement', d.profile.calibration === null);
  check('and drops the profile back off "measured"', d.profile.source === 'heuristic', d.profile.source);

  dp.declineTest(d.prompt.token);
  check('declining suppresses that revision', dp.resolveProfile(info(3)).prompt.kind === 'none');
  const e = dp.resolveProfile(info(4));
  check('a NEW revision still gets to ask', e.prompt.kind === 'offer', e.prompt.kind);
  check('the declined revision stays declined', dp.resolveProfile(info(3)).prompt.kind === 'none');

  dp.resolveProfile(info(4));
  dp.setTier('low');
  const f = dp.resolveProfile(info(5));
  check('a user-chosen tier outranks invalidation', f.profile.tier === 'low' && f.profile.source === 'user', f.profile.tier + '/' + f.profile.source);

  process.stdout.write('__RESULTS__' + JSON.stringify(results) + '\\n');
  app.exit(0);
});
`;

/** Same probe, run with --disable-gpu: software raster must force Low. */
const PROBE_NOGPU = `
const { app, BrowserWindow } = require('electron');
const dp = require(${JSON.stringify(join(work, 'deviceProfile.cjs'))});
const fs = require('fs'); const path = require('path');
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false });
  await win.loadURL('data:text/html,<body>x</body>');
  const file = path.join(app.getPath('userData'), 'perf-profile.json');
  if (fs.existsSync(file)) fs.unlinkSync(file);
  const r = dp.resolveProfile({ glRenderer: 'SwiftShader', glVendor: 'Google', drawRevision: 2 });
  process.stdout.write('__RESULTS__' + JSON.stringify([
    { n: 'software rasterisation is detected', ok: r.capability.canvasAccelerated === false, d: '' },
    { n: 'a software-raster machine is pinned to Low', ok: r.profile.tier === 'low', d: r.profile.tier },
  ]) + '\\n');
  app.exit(0);
});
`;

function runProbe(source, name, extraArgs) {
  const file = join(work, name);
  writeFileSync(file, source, 'utf-8');
  const out = execFileSync(
    electronBin,
    [file, `--user-data-dir=${join(work, name + '-udd')}`, ...extraArgs],
    { encoding: 'utf-8', env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined }, stdio: ['ignore', 'pipe', 'ignore'] },
  );
  const line = out.split('\n').find((l) => l.startsWith('__RESULTS__'));
  if (!line) throw new Error(`${name}: probe produced no results`);
  return JSON.parse(line.slice('__RESULTS__'.length));
}

let failures = 0;
function report(results) {
  for (const r of results) {
    if (r.ok) {
      console.log(`  ok    ${r.n}${r.d ? `  (${r.d})` : ''}`);
    } else {
      failures++;
      console.log(`  FAIL  ${r.n}${r.d ? `  (${r.d})` : ''}`);
    }
  }
}

/**
 * Frame cap. Pure arithmetic, but an off-by-a-millisecond here halves the
 * frame rate and is indistinguishable from a slow machine: requiring the full
 * interval rejects the vsync that lands exactly on the boundary, so a 30 Hz
 * cap on a 60 Hz panel silently delivers 20.
 */
async function checkFrameCap() {
  const bundle = join(work, 'quality.mjs');
  execFileSync(
    esbuild,
    [
      join(repoRoot, 'src/state/quality.ts'),
      '--bundle',
      '--format=esm',
      '--platform=node',
      // react is bundled in rather than external: the output lands in a temp
      // dir, where a bare 'react' specifier has no node_modules to resolve
      // against. Nothing here calls a hook, so pulling it in is inert.
      `--outfile=${bundle}`,
      '--log-level=warning',
    ],
    { stdio: 'inherit' },
  );
  const { frameDue, TIER_KNOBS } = await import(pathToFileURL(bundle).href);

  /** Count frames a cap would actually deliver over one second of vsyncs. */
  const delivered = (displayHz, capHz) => {
    let last = -Infinity;
    let sent = 0;
    for (let i = 0; i < displayHz; i++) {
      const now = (i * 1000) / displayHz;
      if (frameDue(now, last, capHz)) {
        sent++;
        last = now;
      }
    }
    return sent;
  };

  const cases = [
    [120, 60, 60],
    [120, 30, 30],
    [60, 30, 30],
    [60, 60, 60],
    [120, null, 120],
    [60, null, 60],
    // A cap above the refresh rate can't invent frames, and must not throttle.
    [60, 120, 60],
  ];
  const results = [];
  for (const [displayHz, capHz, want] of cases) {
    const got = delivered(displayHz, capHz);
    results.push({
      n: `${displayHz} Hz display, cap ${capHz ?? 'none'} -> ${want} fps`,
      ok: got === want,
      d: got === want ? '' : `got ${got}`,
    });
  }
  results.push({
    n: 'tier caps never exceed what the tier claims',
    ok: TIER_KNOBS.low.frameCapHz === 30 && TIER_KNOBS.balanced.frameCapHz === 60 && TIER_KNOBS.high.frameCapHz === null,
    d: '',
  });
  return results;
}

try {
  console.log('\nFrame cap');
  report(await checkFrameCap());

  execFileSync(
    esbuild,
    [
      join(repoRoot, 'electron/deviceProfile.ts'),
      '--bundle',
      '--format=cjs',
      '--platform=node',
      '--external:electron',
      `--outfile=${join(work, 'deviceProfile.cjs')}`,
      '--log-level=warning',
    ],
    { stdio: 'inherit' },
  );

  console.log('\nCapability detection and profile lifecycle');
  report(runProbe(PROBE, 'probe.js', []));

  console.log('\nSoftware rasterisation');
  report(runProbe(PROBE_NOGPU, 'probe-nogpu.js', ['--disable-gpu']));
} finally {
  rmSync(work, { recursive: true, force: true });
}

console.log(
  failures === 0
    ? '\nAll adaptive-quality checks passed.\n'
    : `\n${failures} adaptive-quality check(s) FAILED.\n`,
);
process.exit(failures === 0 ? 0 : 1);

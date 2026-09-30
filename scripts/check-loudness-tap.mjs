#!/usr/bin/env node
/**
 * Regression check for the BS.1770 worklet tap in `src/audio/loudnessTap.ts`.
 *
 * `check:enhancer` already proves the loudness MATH is right — it drives
 * `loudness.ts` against the EBU Tech 3341 tones under plain node. What it
 * cannot prove is that the number ever arrives: the tap does its filtering
 * inside an AudioWorklet, and a worklet whose output reaches nothing is not
 * guaranteed to be scheduled at all. The app connects the tap's output to
 * the limiter purely to keep it in the pulled graph, and that mitigation
 * shipped unverified in 1.4.13.
 *
 * The failure it guards is silent by construction. If the worklet is never
 * pulled, no quarters arrive, integrated loudness stays -Infinity, track
 * memory records no loudness, and level matching does nothing at all —
 * forever, with nothing logged and nothing to notice.
 *
 * So this reproduces the app's graph SHAPE, renders a known tone through it,
 * and asserts the tap agrees with `measureIntegratedLufs` on the same audio.
 * That compares the worklet path against the already-verified reference
 * rather than against a number typed in here.
 *
 * Unlike check-enhancer this needs a renderer: AudioContext and AudioWorklet
 * do not exist under node. It uses an OfflineAudioContext rather than a live
 * one — deterministic, faster than real time, and it does not care whether
 * the machine running it has an output device or an autoplay policy. Offline
 * rendering pulls strictly from the destination, so it is a stricter test of
 * "is this node scheduled" than real time would be.
 *
 *   npm run check:loudness-tap
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const electronBin = join(
  repoRoot,
  'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron',
);
const esbuild = join(repoRoot, 'node_modules/.bin/esbuild');

const work = mkdtempSync(join(tmpdir(), 'av-loudness-tap-'));

/** Re-export both halves so the page can compare the worklet path against
 *  the reference implementation it is supposed to agree with. */
writeFileSync(
  join(work, 'entry.ts'),
  `export { createLoudnessTap } from ${JSON.stringify(join(repoRoot, 'src/audio/loudnessTap'))};\n` +
    `export { measureIntegratedLufs } from ${JSON.stringify(join(repoRoot, 'src/audio/loudness'))};\n`,
  'utf-8',
);

execFileSync(
  esbuild,
  [
    join(work, 'entry.ts'),
    '--bundle',
    '--format=esm',
    '--platform=browser',
    `--outfile=${join(work, 'tap.js')}`,
  ],
  { stdio: ['ignore', 'ignore', 'inherit'] },
);

/**
 * The page. Builds the app's graph shape around the tap, renders a tone
 * through it, and reports what the worklet measured.
 */
writeFileSync(
  join(work, 'probe.html'),
  `<!doctype html><meta charset="utf-8"><body>
<script type="module">
import { createLoudnessTap, measureIntegratedLufs } from './tap.js';

/** EBU Tech 3341 states its tones by peak amplitude, not RMS — same helper
 *  as check-enhancer, so the two checks are describing the same signal. */
function sine(seconds, dbfsPeak, rate, hz = 1000) {
  const amp = Math.pow(10, dbfsPeak / 20);
  const n = Math.round(seconds * rate);
  const ch = new Float32Array(n);
  for (let i = 0; i < n; i++) ch[i] = amp * Math.sin((2 * Math.PI * hz * i) / rate);
  return ch;
}

/** Wait for the worklet's port messages to drain. Offline rendering resolves
 *  when the AUDIO is done; the quarters it posted are still crossing to the
 *  main thread behind it. */
async function settle(meter) {
  let last = -Infinity;
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 25));
    const now = meter.integratedLufs();
    if (Number.isFinite(now) && now === last) return now;
    last = now;
  }
  return last;
}

/**
 * @param connectOutput mirrors the app's mitigation: whether the tap's
 *   output is connected onward to keep it in the pulled graph.
 */
async function measureThroughWorklet(seconds, dbfs, rate, connectOutput) {
  const ctx = new OfflineAudioContext({
    numberOfChannels: 2,
    length: Math.round(seconds * rate),
    sampleRate: rate,
  });
  const tap = await createLoudnessTap(ctx);
  if (!tap) return { lufs: null, reason: 'createLoudnessTap returned null' };

  const ch = sine(seconds, dbfs, rate);
  const buf = ctx.createBuffer(2, ch.length, rate);
  buf.copyToChannel(ch, 0);
  buf.copyToChannel(ch, 1);
  const src = ctx.createBufferSource();
  src.buffer = buf;

  // The app's shape: the tap hangs off inputGain, upstream of everything,
  // and its output is connected onward only to keep it scheduled.
  const inputGain = ctx.createGain();
  const limiter = ctx.createGain();
  src.connect(inputGain);
  inputGain.connect(tap.node);
  if (connectOutput) tap.node.connect(limiter);
  inputGain.connect(limiter);
  limiter.connect(ctx.destination);

  src.start();
  await ctx.startRendering();
  const lufs = await settle(tap.meter);
  return { lufs, reason: '' };
}

window.__run = async () => {
  const results = [];
  const check = (n, ok, d) => results.push({ n, ok: !!ok, d: d === undefined ? '' : String(d) });
  const rate = 48000;
  const seconds = 20;
  const dbfs = -23;

  try {
    const ref = measureIntegratedLufs([sine(seconds, dbfs, rate), sine(seconds, dbfs, rate)], rate);

    const wired = await measureThroughWorklet(seconds, dbfs, rate, true);
    check(
      'the worklet is scheduled and quarters arrive',
      Number.isFinite(wired.lufs),
      wired.lufs === null ? wired.reason : wired.lufs.toFixed(2) + ' LUFS',
    );
    // EBU's own tolerance. The worklet and the reference run the same filter
    // design over the same samples, so anything outside this is a wiring or
    // block-boundary bug, not arithmetic.
    check(
      'the worklet path agrees with the offline reference',
      Number.isFinite(wired.lufs) && Math.abs(wired.lufs - ref) <= 0.1,
      'worklet ' + Number(wired.lufs).toFixed(2) + ' vs reference ' + ref.toFixed(2) + ' LUFS',
    );
    check(
      'and both land on the tone that was fed in',
      Number.isFinite(wired.lufs) && Math.abs(wired.lufs - dbfs) <= 0.1,
      Number(wired.lufs).toFixed(2) + ' LUFS for a ' + dbfs + ' dBFS tone',
    );

    // Whether the output connection is load-bearing or belt-and-braces. Not
    // a pass/fail — it records which, so the next person to touch the wiring
    // knows whether they can drop it.
    const bare = await measureThroughWorklet(seconds, dbfs, rate, false);
    check(
      'the output connection is documented as necessary or not',
      true,
      Number.isFinite(bare.lufs)
        ? 'also works unconnected (' + bare.lufs.toFixed(2) + ') — the connection is belt-and-braces'
        : 'REQUIRED: unconnected, no quarters arrive at all',
    );
  } catch (e) {
    check('probe ran without throwing', false, String((e && e.stack) || e));
  }
  return results;
};
</script></body>`,
  'utf-8',
);

const PROBE = `
const { app, BrowserWindow } = require('electron');
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  await win.loadFile(${JSON.stringify(join(work, 'probe.html'))});
  let results;
  try {
    results = await win.webContents.executeJavaScript('window.__run()');
  } catch (e) {
    results = [{ n: 'the probe page loaded and ran', ok: false, d: String(e) }];
  }
  process.stdout.write('__RESULTS__' + JSON.stringify(results) + '\\n');
  app.exit(0);
});
`;

const probeFile = join(work, 'probe.cjs');
writeFileSync(probeFile, PROBE, 'utf-8');

let results;
try {
  const out = execFileSync(
    electronBin,
    [probeFile, `--user-data-dir=${join(work, 'udd')}`],
    {
      encoding: 'utf-8',
      env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 120_000,
    },
  );
  const line = out.split('\n').find((l) => l.startsWith('__RESULTS__'));
  if (!line) throw new Error('probe produced no results');
  results = JSON.parse(line.slice('__RESULTS__'.length));
} finally {
  rmSync(work, { recursive: true, force: true });
}

console.log('\nBS.1770 worklet tap');
let failures = 0;
for (const r of results) {
  if (!r.ok) failures++;
  console.log(`  ${r.ok ? 'ok  ' : 'FAIL'}  ${r.n}${r.d ? `  (${r.d})` : ''}`);
}
console.log(
  failures === 0
    ? '\nWorklet tap checks passed.\n'
    : `\n${failures} worklet tap check(s) FAILED.\n`,
);
process.exit(failures === 0 ? 0 : 1);

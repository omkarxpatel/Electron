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
 * @param playthrough whether anything reaches ctx.destination at all. The
 *   app only connects its output when Live is on, and this check used to
 *   connect unconditionally — so every case it ran was the Live-on topology
 *   and it could not see a graph that stops being pulled when Live is off.
 */
async function measureThroughWorklet(seconds, dbfs, rate, connectOutput, playthrough = true) {
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
  if (playthrough) limiter.connect(ctx.destination);

  src.start();
  await ctx.startRendering();
  const lufs = await settle(tap.meter);
  return { lufs, reason: '' };
}

/**
 * The app's ACTUAL topology, not just the tap's corner of it.
 *
 * measureThroughWorklet above proves the tap agrees with the reference,
 * but it builds a two-node graph that always reaches the destination. The
 * app's graph is longer and its destination connection is conditional:
 *
 *     limiter ─┬─→ analyser → duckGain → masterGain ─→ destination
 *              │                                        (Live only)
 *              └─→ splitter ─→ analyserL        (leaves, no outputs)
 *                          └─→ analyserR
 *
 * Two things fall out of that shape, and this function measures both:
 *
 *   - analyserL/analyserR have NO output connections, so Blink adds them
 *     to its automatic-pull list. They keep the splitter, the limiter and
 *     everything upstream — including the tap — being processed even with
 *     nothing connected to the destination.
 *   - the main analyser IS connected onward (to duckGain), which
 *     disqualifies it from that same list. Its only route to being processed
 *     is masterGain → destination, which exists only when Live is on.
 *
 * So with Live off the taps keep working and the visualiser's analyser goes
 * flat. Returns the analyser's peak deviation from the 128 midpoint, which is
 * 0 for a graph that was never pulled.
 */
async function measureAppGraph(seconds, dbfs, rate, playthrough) {
  const ctx = new OfflineAudioContext({
    numberOfChannels: 2,
    length: Math.round(seconds * rate),
    sampleRate: rate,
  });
  const tap = await createLoudnessTap(ctx);

  const ch = sine(seconds, dbfs, rate);
  const buf = ctx.createBuffer(2, ch.length, rate);
  buf.copyToChannel(ch, 0);
  buf.copyToChannel(ch, 1);
  const src = ctx.createBufferSource();
  src.buffer = buf;

  const inputGain = ctx.createGain();
  const preamp = ctx.createGain();
  const limiter = ctx.createDynamicsCompressor();
  const analyser = ctx.createAnalyser();
  const splitter = ctx.createChannelSplitter(2);
  const analyserL = ctx.createAnalyser();
  const analyserR = ctx.createAnalyser();
  const duckGain = ctx.createGain();
  const masterGain = ctx.createGain();

  src.connect(inputGain);
  inputGain.connect(preamp);
  preamp.connect(limiter);
  if (tap) {
    inputGain.connect(tap.node);
    tap.node.connect(limiter);
  }
  limiter.connect(analyser);
  limiter.connect(splitter);
  splitter.connect(analyserL, 0, 0);
  splitter.connect(analyserR, 1, 0);
  analyser.connect(duckGain);
  duckGain.connect(masterGain);
  // Mirrors useAudioEngine: a gain-0 node wired to the destination
  // unconditionally, so the graph is pulled whether or not Live is on. If
  // that node is ever removed from the app, remove it here too and this
  // check goes red again — which is the point of modelling it rather than
  // asserting the invariant against a graph the app does not build.
  const silentSink = ctx.createGain();
  silentSink.gain.value = 0;
  masterGain.connect(silentSink);
  silentSink.connect(ctx.destination);
  if (playthrough) masterGain.connect(ctx.destination);

  src.start();
  const rendered = await ctx.startRendering();

  // What actually reached the speakers. The silent sink exists to make the
  // graph be PROCESSED, not to make it audible, so with Live off this must
  // be digital silence. Getting that wrong is not a cosmetic bug: system
  // output is routed through BlackHole so the app can capture it, and audio
  // leaking out of a visualize-only session is a feedback loop.
  let outputPeak = 0;
  for (let c = 0; c < rendered.numberOfChannels; c++) {
    const data = rendered.getChannelData(c);
    for (let i = 0; i < data.length; i++) {
      const v = Math.abs(data[i]);
      if (v > outputPeak) outputPeak = v;
    }
  }

  const bytes = new Uint8Array(analyser.fftSize);
  analyser.getByteTimeDomainData(bytes);
  let analyserPeak = 0;
  for (let i = 0; i < bytes.length; i++) {
    const d = Math.abs(bytes[i] - 128);
    if (d > analyserPeak) analyserPeak = d;
  }

  const leafBytes = new Uint8Array(analyserL.fftSize);
  analyserL.getByteTimeDomainData(leafBytes);
  let leafPeak = 0;
  for (let i = 0; i < leafBytes.length; i++) {
    const d = Math.abs(leafBytes[i] - 128);
    if (d > leafPeak) leafPeak = d;
  }

  const lufs = tap ? await settle(tap.meter) : null;
  return { analyserPeak, leafPeak, lufs, outputPeak };
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

    // ── Live off ───────────────────────────────────────────────────────
    // Everything above renders into a graph that reaches the destination.
    // The app only connects its output when Live (playthrough) is on, and
    // that is the stored default for a fresh install — so the cases below
    // are the ones a new user actually runs.

    // Diagnostic, not pass/fail. This is the tap ALONE with no destination
    // and no analysers — not a shape the app ever builds. It is here to
    // record what the tap's survival actually rests on: with Live off and
    // nothing auto-pulled, it measures nothing at all. In the app it keeps
    // working, and the next check shows what saves it.
    const offTap = await measureThroughWorklet(seconds, dbfs, rate, true, false);
    check(
      'with no destination AND no analysers, the tap is not pulled',
      true,
      Number.isFinite(offTap.lufs)
        ? 'still measured ' + offTap.lufs.toFixed(2)
        : 'nothing arrives — so the tap depends on something else keeping the graph pulled',
    );

    const liveOn = await measureAppGraph(seconds, dbfs, rate, true);
    const liveOff = await measureAppGraph(seconds, dbfs, rate, false);

    check(
      'in the app graph with Live ON, the visualiser analyser sees audio',
      liveOn.analyserPeak > 0,
      'peak deviation from midpoint: ' + liveOn.analyserPeak,
    );

    // The one this file exists for now. analyser.connect(duckGain) takes
    // the analyser off Blink's automatic-pull list, and with Live off there
    // is no other route to the destination — so it is never processed and
    // every byte reads back as the 128 midpoint. The visualiser draws a
    // flat line, the EQ halo never fills and the meters read nothing.
    check(
      'in the app graph with Live OFF, the visualiser analyser still sees audio',
      liveOff.analyserPeak > 0,
      liveOff.analyserPeak > 0
        ? 'peak deviation from midpoint: ' + liveOff.analyserPeak
        : 'FLAT — analyser read back as a constant 128, the graph was never pulled',
    );

    // Contrast, and the reason the bug survived: the stereo analysers have
    // no output connections, so they ARE auto-pulled and keep working. That
    // is also what keeps the loudness and onset taps alive with Live off,
    // which is why no measurement noticed anything was wrong.
    check(
      'the leaf analysers are auto-pulled and work either way',
      liveOff.leafPeak > 0,
      'Live-off leaf peak: ' + liveOff.leafPeak + ' (vs main analyser ' + liveOff.analyserPeak + ')',
    );

    // In the app's real shape the tap DOES survive Live off — the leaf
    // analysers above keep the limiter and everything upstream of it being
    // processed. That is load-bearing and accidental: give either leaf an
    // output connection and it leaves the auto-pull list, the graph stops
    // being pulled with Live off, and loudness silently becomes -Infinity
    // forever. This assertion is what would catch that.
    // The other half of the silent-sink fix, and the one with teeth. Making
    // the graph always-pulled must not make it always-audible.
    check(
      'with Live OFF, nothing reaches the destination',
      liveOff.outputPeak === 0,
      liveOff.outputPeak === 0
        ? 'digital silence (peak 0)'
        : 'LEAKING AUDIO — destination peak ' + liveOff.outputPeak.toFixed(6),
    );
    check(
      'with Live ON, audio does reach the destination',
      liveOn.outputPeak > 0,
      'destination peak ' + liveOn.outputPeak.toFixed(4),
    );

    check(
      'in the app graph with Live OFF, the loudness tap still measures',
      Number.isFinite(liveOff.lufs),
      Number.isFinite(liveOff.lufs)
        ? liveOff.lufs.toFixed(2) + ' LUFS (kept alive by the leaf analysers)'
        : 'no quarters arrive — the leaf analysers are no longer pulling the graph',
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

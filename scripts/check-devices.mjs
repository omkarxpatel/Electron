#!/usr/bin/env node
/**
 * Regression check for audio devices leaving and coming back.
 *
 * Covers `src/audio/useDeviceReturn.ts` and its two users: the input watchdog
 * in `useAudioSource`, and the output picker in `OutputDeviceSelector`. The
 * output-side re-apply in `useAudioEngine` is the same hook with a one-line
 * callback, so it is covered by the first section. Also
 * `src/audio/useCaptureStall.ts`, for the case neither of those can see: a
 * capture that stays live and unmuted while delivering silence.
 *
 * Every failure here is silent by construction, which is why it is worth a
 * check of its own. Nothing errors when a device-return listener is never
 * attached, fires twice, or fires for a device that never left — the app
 * just stays quiet after AirPods reconnect, or rebuilds its whole audio graph
 * every time someone plugs in an unrelated mic, or glitches the output on
 * every devicechange on the machine. And none of it can be seen without
 * physically unplugging hardware, which is slow, needs the hardware, and is
 * not something to do while someone is listening.
 *
 * So this scripts the device list instead. The real hooks and the real picker
 * are bundled and mounted in a hidden Electron window, with enumerateDevices
 * and getUserMedia answered from a list the test controls and `devicechange`
 * dispatched by hand. Nothing in what is mounted creates an AudioContext and
 * nothing opens a microphone, and the window is muted regardless — it is safe
 * to run with music playing.
 *
 * What this cannot tell you is what Chromium does to a live AudioContext
 * whose setSinkId device is removed: reroute to the default output, or go
 * silent. That needs the real hardware, and in this app's own setup the
 * default output is BlackHole — the device being captured — so it is the
 * first thing to check by hand. See audit/REMEDIATION-PLAN.md, Wave 7.
 *
 *   npm run check:devices
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const electronBin = join(repoRoot, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');
const esbuild = join(repoRoot, 'node_modules/.bin/esbuild');
const work = mkdtempSync(join(tmpdir(), 'av-devices-'));

// React by absolute path: the entry is written to a temp dir with no
// node_modules beside it, and esbuild resolves a bare import relative to the
// file that makes it. The modules under test import 'react' from inside the
// repo, which resolves to this same file — so there is still exactly one copy,
// which hooks require.
writeFileSync(
  join(work, 'entry.ts'),
  `export * as React from ${JSON.stringify(join(repoRoot, 'node_modules/react'))};\n` +
    `export { createRoot } from ${JSON.stringify(join(repoRoot, 'node_modules/react-dom/client'))};\n` +
    `export { useDeviceReturn } from ${JSON.stringify(join(repoRoot, 'src/audio/useDeviceReturn'))};\n` +
    `export { useAudioSource } from ${JSON.stringify(join(repoRoot, 'src/audio/useAudioSource'))};\n` +
    `export { useCaptureStall } from ${JSON.stringify(join(repoRoot, 'src/audio/useCaptureStall'))};\n` +
    `export { OutputDeviceSelector } from ${JSON.stringify(join(repoRoot, 'src/components/OutputDeviceSelector'))};\n`,
  'utf-8',
);

execFileSync(
  esbuild,
  [
    join(work, 'entry.ts'),
    '--bundle',
    '--format=esm',
    '--platform=browser',
    '--jsx=automatic',
    '--define:process.env.NODE_ENV="development"',
    `--outfile=${join(work, 'devices.js')}`,
  ],
  { cwd: repoRoot, stdio: ['ignore', 'ignore', 'inherit'] },
);

writeFileSync(
  join(work, 'probe.html'),
  `<!doctype html><meta charset="utf-8"><body><div id="root"></div>
<script type="module">
import { React, createRoot, useDeviceReturn, useAudioSource, useCaptureStall, OutputDeviceSelector } from './devices.js';

const h = React.createElement;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Long enough for an effect, an enumeration and a re-render to land. */
const settle = () => sleep(30);

// ── Scripted devices ───────────────────────────────────────────────────
// The real MediaDevices object stays in place so that it is still a real
// EventTarget and 'devicechange' dispatches the way the browser does it; only
// the two methods that would touch hardware are replaced.

const md = navigator.mediaDevices;
let listing = [];
let enumerateDelayMs = 0;
let enumerateCalls = 0;
const gumCalls = [];

/** Per-call delays, consumed in order; falls back to enumerateDelayMs. Lets a
 *  test make one enumeration slower than the next, so they land out of order. */
let enumerateDelays = [];
md.enumerateDevices = async () => {
  enumerateCalls++;
  // Snapshot at call time, like the real thing: a listing describes the
  // moment it was asked for, not the moment it is delivered. Reading the
  // list on delivery would make a slow, stale enumeration impossible to
  // represent — and that is the exact case the hook's guard exists for.
  const snapshot = listing.map((d) => ({ ...d }));
  const delay = enumerateDelays.length ? enumerateDelays.shift() : enumerateDelayMs;
  if (delay) await sleep(delay);
  return snapshot;
};

function fakeTrack() {
  const t = new EventTarget();
  t.kind = 'audio';
  t.readyState = 'live';
  t.muted = false;
  // Per spec stop() does NOT fire 'ended'; the hook relies on that.
  t.stop = () => { t.readyState = 'ended'; };
  return t;
}

/** Reject this many of the next requests even though the device IS listed.
 *  macOS after an idle spell: the device never left, but re-opening it fails
 *  for a few seconds while CoreAudio catches up. */
let gumFailures = 0;

md.getUserMedia = async (constraints) => {
  const id = constraints?.audio?.deviceId?.exact;
  gumCalls.push(id);
  if (!listing.some((d) => d.kind === 'audioinput' && d.deviceId === id)) {
    throw new DOMException('Requested device not found', 'NotFoundError');
  }
  if (gumFailures > 0) {
    gumFailures -= 1;
    throw new DOMException('Could not start audio source', 'NotReadableError');
  }
  const track = fakeTrack();
  return {
    getAudioTracks: () => [track],
    getVideoTracks: () => [],
    getTracks: () => [track],
    __track: track,
  };
};

const fire = () => md.dispatchEvent(new Event('devicechange'));
const dev = (kind, deviceId, label) => ({ kind, deviceId, label, groupId: 'g-' + deviceId });
const MIC = dev('audioinput', 'mic-1', 'USB Mic');
const OTHER_MIC = dev('audioinput', 'mic-2', 'Another Mic');
const PODS = dev('audiooutput', 'pods-1', 'AirPods');
const SPEAKERS = dev('audiooutput', 'spk-1', 'MacBook Pro Speakers');
const without = (d) => listing.filter((x) => x.deviceId !== d.deviceId);

function reset() {
  listing = [];
  enumerateDelayMs = 0;
  enumerateDelays = [];
  enumerateCalls = 0;
  gumCalls.length = 0;
  gumFailures = 0;
  localStorage.clear();
}

let root = null;
function mount(element) {
  const container = document.getElementById('root');
  root?.unmount();
  root = createRoot(container);
  root.render(element);
}
/**
 * Mount, then wait until the component has asked for its first listing, then
 * let the answer land. A fixed sleep is not enough: the first render of a
 * component in a development React bundle took ~150 ms here, so a 30 ms wait
 * asserted on a component that had not run its effect yet — which also makes
 * "it did not fire" checks pass for the wrong reason.
 */
async function mountListed(element, timeoutMs = 3000) {
  const before = enumerateCalls;
  mount(element);
  const t0 = performance.now();
  while (enumerateCalls === before) {
    if (performance.now() - t0 > timeoutMs) throw new Error('component never listed devices');
    await sleep(5);
  }
  await settle();
}
function unmount() {
  root?.unmount();
  root = null;
}

window.__run = async () => {
  const results = [];
  const check = (n, ok, d) => results.push({ n, ok: !!ok, d: d === undefined ? '' : String(d) });
  const section = (s) => results.push({ section: s });

  try {
    // ── useDeviceReturn ──────────────────────────────────────────────────
    section('useDeviceReturn');
    let calls = 0;
    function ReturnProbe({ kind, id }) {
      useDeviceReturn(kind, id, () => { calls++; });
      return null;
    }

    reset(); calls = 0;
    listing = [PODS];
    await mountListed(h(ReturnProbe, { kind: 'audiooutput', id: PODS.deviceId }));
    check('a device present from the start is not treated as a return', calls === 0, calls + ' calls');

    listing = without(PODS); fire(); await settle();
    listing = [...listing, PODS]; fire(); await settle();
    check('a device that leaves and comes back fires exactly once', calls === 1, calls + ' calls');

    listing = [...listing, OTHER_MIC]; fire(); await settle();
    check('an unrelated device arriving does not fire', calls === 1,
      calls + ' calls — this is the case that would glitch the output on every plug-in');

    reset(); calls = 0;
    listing = [];
    await mountListed(h(ReturnProbe, { kind: 'audiooutput', id: PODS.deviceId }));
    listing = [PODS]; fire(); await settle();
    check('absent at launch, connected later, counts as a return', calls === 1, calls + ' calls');

    reset(); calls = 0;
    listing = [PODS];
    mount(h(ReturnProbe, { kind: 'audiooutput', id: PODS.deviceId }));
    await settle();
    listing = []; fire(); await settle();
    listing = [PODS];
    // A Bluetooth reconnect sends several of these close together.
    fire(); fire(); fire();
    await settle();
    check('a burst of devicechange events on return fires once, not once each', calls === 1, calls + ' calls');

    /* Out of order. A listing asked for while the device was still gone
     * arrives AFTER a fresher one that found it back. Acting on it would flip
     * the device back to "gone", and the next event would announce a second
     * return that never happened — a second setSinkId glitch, or a second
     * graph rebuild. The guard keeps only the newest listing. */
    reset(); calls = 0;
    listing = [];
    await mountListed(h(ReturnProbe, { kind: 'audiooutput', id: PODS.deviceId }));
    enumerateDelays = [80, 0];
    fire();                                   // slow, snapshots "gone"
    listing = [PODS]; fire();                 // fast, snapshots "back" — lands first
    await sleep(140);                         // let the stale one land too
    fire(); await settle();                   // an ordinary later event
    check('a stale listing that lands late does not cause a second return', calls === 1, calls + ' calls');

    reset(); calls = 0;
    listing = [PODS];
    mount(h(ReturnProbe, { kind: 'audiooutput', id: PODS.deviceId }));
    await settle();
    listing = []; fire(); await settle();
    enumerateDelayMs = 60;
    listing = [PODS]; fire();
    unmount();
    await sleep(120);
    check('no callback after unmount, even with an enumeration still in flight', calls === 0, calls + ' calls');

    reset(); calls = 0;
    mount(h(ReturnProbe, { kind: 'audiooutput', id: null }));
    await settle();
    fire(); await settle();
    check('with nothing chosen it neither enumerates nor fires', enumerateCalls === 0 && calls === 0,
      enumerateCalls + ' enumerations, ' + calls + ' calls');

    reset(); calls = 0;
    listing = [PODS, SPEAKERS];
    mount(h(ReturnProbe, { kind: 'audiooutput', id: PODS.deviceId }));
    await settle();
    mount(h(ReturnProbe, { kind: 'audiooutput', id: SPEAKERS.deviceId }));
    await settle();
    listing = [SPEAKERS]; fire(); await settle();
    listing = [SPEAKERS, PODS]; fire(); await settle();
    check('a device that is no longer the choice does not fire when it returns', calls === 0, calls + ' calls');

    reset(); calls = 0;
    listing = [PODS];
    mount(h(React.StrictMode, null, h(ReturnProbe, { kind: 'audiooutput', id: PODS.deviceId })));
    await settle();
    listing = []; fire(); await settle();
    listing = [PODS]; fire(); await settle();
    check('under StrictMode the double mount still fires exactly once', calls === 1, calls + ' calls');
    unmount();

    // ── useAudioSource ───────────────────────────────────────────────────
    section('Input recovery');
    let src = null;
    function SourceProbe() {
      src = useAudioSource();
      return null;
    }
    const liveTrack = () => src?.stream?.getAudioTracks()[0] ?? null;

    reset();
    listing = [MIC, SPEAKERS];
    mount(h(SourceProbe));
    await settle();
    await src.useDevice(MIC.deviceId);
    await settle();
    check('the chosen input is acquired', liveTrack()?.readyState === 'live' && gumCalls.length === 1,
      gumCalls.length + ' getUserMedia calls');

    // The device leaves: it drops out of the list and its track ends.
    listing = [SPEAKERS];
    const goneTrack = liveTrack();
    goneTrack.readyState = 'ended';
    goneTrack.dispatchEvent(new Event('ended'));
    fire();
    await settle();
    check('a device that has gone is not retried', gumCalls.length === 1,
      gumCalls.length + ' getUserMedia calls — every extra one was a spent recovery that could not succeed');
    check('and the message says it disconnected, not that it stopped responding',
      /disconnected/.test(src.error ?? '') && !/stopped responding/.test(src.error ?? ''), src.error);
    check('the choice is kept, so it can be found again', src.deviceId === MIC.deviceId && src.mode === 'device',
      src.mode + ' / ' + src.deviceId);

    // It comes back.
    listing = [SPEAKERS, MIC];
    fire();
    await settle();
    await settle();
    check('when it returns it is re-acquired, by the same deviceId',
      gumCalls.length === 2 && gumCalls[1] === MIC.deviceId, JSON.stringify(gumCalls));
    check('and the new stream is live', liveTrack() !== goneTrack && liveTrack()?.readyState === 'live',
      liveTrack()?.readyState);
    check('and the disconnected message is cleared', src.error === null, src.error);

    // A blip: the list drops it and re-adds it while capture carries on.
    const before = gumCalls.length;
    listing = [SPEAKERS]; fire(); await settle();
    listing = [SPEAKERS, MIC]; fire(); await settle();
    check('a blip that leaves the track live does not rebuild the input', gumCalls.length === before,
      (gumCalls.length - before) + ' extra getUserMedia calls');

    // The track dies in place with the device still listed: the original
    // watchdog's job, which must still work.
    const inPlace = liveTrack();
    inPlace.readyState = 'ended';
    inPlace.dispatchEvent(new Event('ended'));
    await settle();
    await settle();
    check('a track that dies in place with its device present is still recovered',
      gumCalls.length === before + 1 && gumCalls.at(-1) === MIC.deviceId, JSON.stringify(gumCalls));

    /* Each case below starts on a fresh hook. The attempt counter only
     * resets after ten healthy seconds, so a case that inherited it from the
     * one above would be waiting out the previous test's backoff and proving
     * nothing about its own. */
    const freshSource = async () => {
      unmount();
      reset();
      listing = [MIC, SPEAKERS];
      mount(h(SourceProbe));
      await settle();
      await src.useDevice(MIC.deviceId);
      await settle();
    };

    /* The request itself failing while the device is still listed. This is
     * what macOS does after an idle spell, and it was the dead end: a
     * rejected getUserMedia swaps no stream, so the watchdog effect never
     * re-ran, the three attempts went in a burst over about a second, and
     * the user was told to pick the device again by hand. */
    await freshSource();
    gumFailures = 2;
    const stalled = liveTrack();
    stalled.readyState = 'ended';
    stalled.dispatchEvent(new Event('ended'));
    await sleep(600);
    check('a failed re-acquire does not give up', !/could not be reconnected/.test(src.error ?? ''),
      src.error);
    check('and says it is reconnecting while it works', /reconnecting/i.test(src.error ?? ''), src.error);

    // Two failures then a success: attempts land at 0 ms, 1 s and 3 s.
    await sleep(4200);
    check('it keeps trying until the device answers',
      gumCalls.length === 4 && liveTrack()?.readyState === 'live',
      (gumCalls.length - 1) + ' recovery attempts, track ' + liveTrack()?.readyState);
    check('and the error clears once it is back', src.error === null, src.error);

    // Backing off matters as much as persisting: the old code spent its whole
    // budget in about a second, which is less time than the device needs.
    await freshSource();
    gumFailures = 99;
    const wedged = liveTrack();
    wedged.readyState = 'ended';
    wedged.dispatchEvent(new Event('ended'));
    await sleep(1500);
    const burst = gumCalls.length - 1;
    check('a wedged device is retried on a backoff, not in a loop', burst >= 1 && burst <= 2,
      burst + ' attempts in 1.5 s');

    /* Coming back to the app spends an attempt out of turn, because by then
     * the next one is seconds away and this is exactly when someone is
     * sitting looking at the error waiting for it to clear. */
    const beforeFocus = gumCalls.length;
    gumFailures = 0;
    window.dispatchEvent(new Event('focus'));
    await sleep(300);
    check('returning to the app retries straight away',
      gumCalls.length > beforeFocus && liveTrack()?.readyState === 'live',
      (gumCalls.length - beforeFocus) + ' attempts on focus, track ' + liveTrack()?.readyState);
    unmount();

    /* ── useCaptureStall ──────────────────────────────────────────────────
     *
     * The gap the two watchdogs above cannot see: a track that stays 'live'
     * and unmuted while delivering digital silence. Nothing fires, so the
     * input had to be picked again by hand. Every case here is about the
     * TWO conditions that keep the cure from being worse than the disease —
     * it must not rebuild the graph because the music is paused, and it must
     * not rebuild it because an unrelated device was plugged in.
     */
    section('Silent capture');
    let probeLevel = 0;
    // fftSize 4 so a sample is four values; the real one reads an analyser.
    const PROBE = { fftSize: 4, getFloatTimeDomainData: (a) => a.fill(probeLevel) };
    function StallProbe({ noProbe }) {
      src = useAudioSource();
      useCaptureStall({
        probe: noProbe ? null : PROBE,
        stream: src.stream,
        deviceId: src.mode === 'device' ? src.deviceId : null,
        reacquire: src.useDevice,
      });
      return null;
    }
    const freshStall = async (noProbe) => {
      unmount();
      reset();
      listing = [MIC, SPEAKERS];
      mount(h(StallProbe, { noProbe }));
      await settle();
      await src.useDevice(MIC.deviceId);
      await settle();
    };
    /** SETTLE_MS + PROBE_INTERVAL_MS * PROBE_SAMPLES, plus slack. */
    const stallWait = () => sleep(2600);
    let n = 0;

    await freshStall();
    probeLevel = 0;
    n = gumCalls.length;
    fire(); await stallWait();
    check('a capture left silent by a device change is re-acquired',
      gumCalls.length === n + 1 && gumCalls.at(-1) === MIC.deviceId, JSON.stringify(gumCalls));

    await freshStall();
    probeLevel = 0.2;
    n = gumCalls.length;
    fire(); await stallWait();
    check('a capture that is still passing audio is left alone', gumCalls.length === n,
      (gumCalls.length - n) + ' rebuilds — each one is an audible glitch for nothing');

    await freshStall();
    probeLevel = 0;
    n = gumCalls.length;
    await stallWait();
    check('silence with no device change does nothing — paused music is silent too',
      gumCalls.length === n, (gumCalls.length - n) + ' rebuilds while merely quiet');

    await freshStall();
    probeLevel = 0;
    n = gumCalls.length;
    fire(); fire(); fire(); await stallWait();
    check('a burst of device changes re-acquires once, not once each',
      gumCalls.length === n + 1, (gumCalls.length - n) + ' re-acquires');

    await freshStall();
    probeLevel = 0;
    listing = [SPEAKERS];
    n = gumCalls.length;
    fire(); await stallWait();
    check('a device that has actually left is not re-opened here — that is useDeviceReturn',
      gumCalls.length === n, (gumCalls.length - n) + ' attempts that could only reject');

    await freshStall();
    probeLevel = 0;
    liveTrack().muted = true;
    n = gumCalls.length;
    fire(); await stallWait();
    check('a track that admits it is muted is left to the other watchdog',
      gumCalls.length === n, (gumCalls.length - n) + ' recoveries racing the backoff');

    await freshStall(true);
    probeLevel = 0;
    n = gumCalls.length;
    fire(); await stallWait();
    check('with no analyser to read, silence cannot be proven and nothing fires',
      gumCalls.length === n, (gumCalls.length - n) + ' re-acquires on no evidence');

    await freshStall();
    probeLevel = 0;
    n = gumCalls.length;
    fire();
    await sleep(1400);   // past the settle, mid-probe
    unmount();
    await sleep(1400);
    check('no re-acquire after unmount with a probe in flight', gumCalls.length === n,
      (gumCalls.length - n) + ' calls after unmount');
    unmount();

    // ── OutputDeviceSelector ─────────────────────────────────────────────
    section('Output picker');
    const SINK_IDLE = { kind: 'idle' };
    const pickerLabel = () =>
      document.querySelector('.audio-source-selector .source-btn > span:not(.source-icon):not(.caret)')
        ?.textContent ?? null;
    const picker = (outputDeviceId) =>
      h(OutputDeviceSelector, { outputDeviceId, onSelect: () => {}, sinkVolume: SINK_IDLE, inputDeviceId: null });

    reset();
    listing = [MIC, PODS, SPEAKERS];
    await mountListed(picker(PODS.deviceId));
    check('a connected choice shows its own name', pickerLabel() === 'AirPods', pickerLabel());

    listing = [MIC, SPEAKERS]; fire(); await settle();
    check('a choice that disconnects says so, by name', pickerLabel() === 'AirPods — disconnected', pickerLabel());
    check('rather than claiming the system default', pickerLabel() !== 'System default', pickerLabel());

    document.querySelector('.audio-source-selector .source-btn').click();
    await settle();
    const row = [...document.querySelectorAll('.source-dropdown .source-row')]
      .find((b) => (b.textContent ?? '').includes('disconnected'));
    check('the open menu shows it as the choice, and not pickable', !!row && row.disabled && row.classList.contains('is-active'),
      row ? 'disabled=' + row.disabled : 'no row');

    listing = [MIC, PODS, SPEAKERS]; fire(); await settle();
    check('and it goes back to its own name when it reconnects', pickerLabel() === 'AirPods', pickerLabel());
    unmount();

    reset();
    listing = [MIC, SPEAKERS];
    await mountListed(picker(PODS.deviceId));
    check('a choice that was never seen this session still reads as disconnected',
      pickerLabel() === 'Saved output — disconnected', pickerLabel());
    unmount();

    reset();
    listing = [MIC, PODS, SPEAKERS];
    enumerateDelayMs = 80;
    mount(picker(PODS.deviceId));
    await sleep(10);
    const early = pickerLabel();
    check('before the first listing lands it claims nothing either way',
      early !== null && !/disconnected/.test(early) && early !== 'System default', early);
    await sleep(120);
    check('and settles on the name once it does', pickerLabel() === 'AirPods', pickerLabel());
    unmount();

    reset();
    listing = [MIC, SPEAKERS];
    await mountListed(picker(null));
    check('with nothing chosen it still reads as the system default', pickerLabel() === 'System default', pickerLabel());
    unmount();
  } catch (e) {
    check('probe ran without throwing', false, String((e && e.stack) || e));
  }
  return results;
};
</script></body>`,
  'utf-8',
);

writeFileSync(
  join(work, 'probe.cjs'),
  `
const { app, BrowserWindow } = require('electron');
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false });
  // Nothing mounted here makes a sound, but this check exists so it can be
  // run while someone is listening to something else. Belt and braces.
  win.webContents.setAudioMuted(true);
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
`,
  'utf-8',
);

let results;
try {
  const out = execFileSync(electronBin, [join(work, 'probe.cjs'), `--user-data-dir=${join(work, 'udd')}`], {
    encoding: 'utf-8',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 120_000,
  });
  const line = out.split('\n').find((l) => l.startsWith('__RESULTS__'));
  if (!line) throw new Error('probe produced no results');
  results = JSON.parse(line.slice('__RESULTS__'.length));
} finally {
  rmSync(work, { recursive: true, force: true });
}

let failures = 0;
for (const r of results) {
  if (r.section) {
    console.log(`\n${r.section}`);
    continue;
  }
  if (!r.ok) failures++;
  console.log(`  ${r.ok ? 'ok  ' : 'FAIL'}  ${r.n}${r.d ? `  (${r.d})` : ''}`);
}
console.log(failures === 0 ? '\nAll device checks passed.\n' : `\n${failures} device check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);

#!/usr/bin/env node
/**
 * Regression check for output-sink volume pinning (`electron/deviceVolume.ts`)
 * and the CoreAudio helper it drives (`build/helpers/avvolume.swift`).
 *
 * This guards the one path in the app that can leave the MACHINE in a bad
 * state rather than just the app. Pinning means we raised someone's output
 * device to 100%; if the restore logic is wrong they plug in headphones later
 * and get blasted. Nothing errors when it breaks — the volume is simply wrong
 * forever — so typecheck cannot see any of it.
 *
 * Specifically:
 *   - the original volume must reach disk BEFORE the device is touched, or a
 *     crash in between strands the device at unity with nothing to restore.
 *   - re-pinning a device we already hold must not overwrite the saved
 *     original with our own 1.0, which would lose the user's value for good.
 *   - a stale pin file must only be honoured if the device is still sitting at
 *     the value we set. If the user has since moved it themselves, their
 *     choice is newer and restoring over it is the second bug.
 *   - the quit-time restore must not throw the record away before it knows the
 *     helper worked. execFile reports a failed spawn or a non-zero exit
 *     asynchronously, so deleting the record beside that call rather than
 *     inside it loses the user's volume at the exact moment the device was NOT
 *     put back — restoreStalePin() finds nothing next launch and the device
 *     stays at 100% forever.
 *   - a quit landing mid-pin must be ordered against it. Two helper
 *     invocations racing the same device decide the user's volume by luck, and
 *     if the pin's `set … 1` happens to land last the device is stranded at
 *     unity with the record already gone.
 *
 * Those last two are driven against a STUB helper, not the real one. The
 * failure being reproduced is "the helper did not do its job", and there is no
 * reason to point that at someone's speakers.
 *
 * Needs a real Electron (app.getPath('userData')) and a real audio device, so
 * it drives the module inside one. It borrows MacBook Pro Speakers, which is
 * idle and not the default output, and puts the volume back on the way out.
 *
 *   npm run check:sink-volume
 */

import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const electronBin = join(repoRoot, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');
const esbuild = join(repoRoot, 'node_modules/.bin/esbuild');
const realHelper = join(repoRoot, 'build/helpers/avvolume');

const DEVICE = 'MacBook Pro Speakers';

const work = mkdtempSync(join(tmpdir(), 'av-sink-volume-check-'));
// deviceVolume.ts resolves the helper at `__dirname/../build/helpers/avvolume`
// in a dev build, so mirror that shape inside the work dir.
mkdirSync(join(work, 'run'), { recursive: true });
mkdirSync(join(work, 'build/helpers'), { recursive: true });
cpSync(realHelper, join(work, 'build/helpers/avvolume'));

function helper(...args) {
  return JSON.parse(execFileSync(realHelper, args, { encoding: 'utf8' }));
}

// ── Stub helpers for the quit path ─────────────────────────────────────────
// The quit-time cases are about what happens when the helper misbehaves or is
// still running. Both are things a real device cannot be asked to do on cue,
// and neither is worth aiming at real speakers, so they get a stand-in binary
// swapped into the path deviceVolume.ts resolves. The device name is fake too:
// even a stub that somehow reached CoreAudio would find nothing to move.
const stubDir = join(work, 'stubs');
mkdirSync(stubDir, { recursive: true });
const STUB_DEVICE = 'Stub Output Device';
const setLogPath = join(work, 'stub-set-log.txt');

// Each stub drops a marker the moment it starts. execFile() returns long before
// libuv actually execs the binary, so without waiting for one of these the
// previous case's spawn can still be in the air when the next stub is swapped
// in — it then runs the WRONG stub and writes a phantom call into the next
// case's log. Observed, not theorised.
const markerFailing = join(work, 'marker-failing');
const markerWorking = join(work, 'marker-working');

// A helper that cannot do its job — a missing binary, the wrong architecture,
// a device that refuses the write. All of them look like this from Node.
writeFileSync(join(stubDir, 'failing'), `#!/bin/sh
: > ${JSON.stringify(markerFailing)}
echo "avvolume: simulated failure" >&2
exit 1
`, { mode: 0o755 });

// A helper that works, so "keep the record on failure" cannot be implemented
// as "never clear the record" — that would re-restore a device nobody touched
// on every launch, forever.
writeFileSync(join(stubDir, 'working'), `#!/bin/sh
: > ${JSON.stringify(markerWorking)}
echo '{}'
`, { mode: 0o755 });

// A helper that answers a pin, and makes the pin's own `set … 1` slow. That is
// the race made reproducible: a quit landing mid-pin spawns a second write to
// the same device, and each call logs on completion, so the log's last line is
// the value the device would really have been left at.
writeFileSync(join(stubDir, 'ordered'), `#!/bin/sh
case "$1" in
  get) echo '{"name":"${STUB_DEVICE}","uid":"stub-sink","hasVolumeControl":true,"volume":0.4}' ;;
  default) echo '{"name":"Stub Slider","uid":"stub-slider","hasVolumeControl":true,"volume":0.8}' ;;
  set)
    if [ "$3" = "1" ]; then sleep 0.6; fi
    echo "$3" >> ${JSON.stringify(setLogPath)}
    echo '{}'
    ;;
esac
`, { mode: 0o755 });

const originalVolume = helper('get', DEVICE).volume;
if (typeof originalVolume !== 'number') {
  console.error(`cannot run: "${DEVICE}" has no readable volume`);
  process.exit(1);
}

// Pinning now also moves the device the volume slider is attached to, so this
// check borrows that one as well and has to hand both back.
const slider = helper('default');
const originalSlider = slider.volume;

const harness = `
const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const dv = require(${JSON.stringify(join(work, 'run/deviceVolume.cjs'))});
const { execFileSync } = require('child_process');

const HELPER = ${JSON.stringify(realHelper)};
const DEVICE = ${JSON.stringify(DEVICE)};
const SLIDER = ${JSON.stringify(slider.name || '')};
// The path deviceVolume.ts actually resolves (__dirname/../build/helpers), so
// swapping this file is how the stub helpers get in front of the module.
const MODULE_HELPER = ${JSON.stringify(join(work, 'build/helpers/avvolume'))};
const STUB_DIR = ${JSON.stringify(join(work, 'stubs'))};
const STUB_DEVICE = ${JSON.stringify(STUB_DEVICE)};
const SET_LOG = ${JSON.stringify(setLogPath)};
const MARKER_FAILING = ${JSON.stringify(markerFailing)};
const MARKER_WORKING = ${JSON.stringify(markerWorking)};
const results = [];
const near = (a, b) => Math.abs(a - b) < 0.02;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (pred, ms) => {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (pred()) return true; await sleep(10); }
  return pred();
};
const read = () => JSON.parse(execFileSync(HELPER, ['get', DEVICE], { encoding: 'utf8' })).volume;
const write = (v) => execFileSync(HELPER, ['set', DEVICE, String(v)]);
const readSlider = () => JSON.parse(execFileSync(HELPER, ['get', SLIDER], { encoding: 'utf8' })).volume;
const writeSlider = (v) => execFileSync(HELPER, ['set', SLIDER, String(v)]);
const pinFile = () => path.join(app.getPath('userData'), 'sink-volume-pin.json');
const readPin = () => { try { return JSON.parse(fs.readFileSync(pinFile(), 'utf8')); } catch { return null; } };
const ok = (name, pass, detail) => results.push({ name, pass, detail });

app.whenReady().then(async () => {
  try {
    // ── pin raises the device and records where it came from ──
    write(0.4);
    writeSlider(1);
    let state = await dv.pinSinkToUnity(DEVICE);
    ok('pin raises the sink to unity', near(read(), 1), 'device at ' + read());
    ok('pin reports the original volume', state.kind === 'pinned' && near(state.originalVolume, 0.4),
       JSON.stringify(state));
    ok('pin writes the original to disk', readPin() && near(readPin().originalVolume, 0.4),
       JSON.stringify(readPin()));

    // ── the pin must touch the SINK and nothing else ──
    // An earlier version also turned the slider device down to offset the
    // raise. It had no way back, so every launch re-applied the subtraction
    // and walked the system volume to near-silence: with a sink at 37% it put
    // BlackHole at 12%. One device in, one device out.
    ok('pin leaves the slider device alone', near(readSlider(), 1),
       'slider at ' + readSlider());

    // ── re-pinning must not clobber the saved original with our own 1.0 ──
    await dv.pinSinkToUnity(DEVICE);
    ok('re-pinning keeps the first saved original', near(readPin().originalVolume, 0.4),
       JSON.stringify(readPin()));

    // ── restore ──
    await dv.restoreSink();
    ok('restore returns the device to its original', near(read(), 0.4), 'device at ' + read());
    ok('restore clears the pin file', readPin() === null);
    ok('restore leaves state idle', dv.getSinkVolumeState().kind === 'idle');
    ok('restore leaves the slider device alone', near(readSlider(), 1),
       'slider at ' + readSlider());

    // ── pin/restore must be a round trip, or repeated launches drift ──
    // This is the regression that shipped: each cycle has to land exactly
    // where the previous one started, for both devices.
    write(0.4);
    writeSlider(0.8);
    for (let i = 0; i < 3; i++) {
      await dv.pinSinkToUnity(DEVICE);
      await dv.restoreSink();
    }
    ok('three pin/restore cycles leave the sink where they found it',
       near(read(), 0.4), 'sink at ' + read());
    ok('three pin/restore cycles leave the slider where they found it',
       near(readSlider(), 0.8), 'slider at ' + readSlider());

    // ── a device already at unity is left alone ──
    write(1);
    state = await dv.pinSinkToUnity(DEVICE);
    ok('a sink already at unity reports already-unity', state.kind === 'already-unity',
       JSON.stringify(state));
    ok('and writes no pin file', readPin() === null);

    // ── crash recovery: device still where we left it, so put it back ──
    write(1);
    fs.writeFileSync(pinFile(), JSON.stringify({
      deviceName: DEVICE, originalVolume: 0.3, pinnedTo: 1, pinnedAt: new Date().toISOString(),
    }));
    await dv.restoreStalePin();
    ok('a stale pin is undone on startup', near(read(), 0.3), 'device at ' + read());
    ok('and the stale record is cleared', readPin() === null);

    // ── crash recovery: user has since moved it, so leave their value alone ──
    write(0.65);
    fs.writeFileSync(pinFile(), JSON.stringify({
      deviceName: DEVICE, originalVolume: 0.3, pinnedTo: 1, pinnedAt: new Date().toISOString(),
    }));
    await dv.restoreStalePin();
    ok('a sink the user has since changed is not overwritten', near(read(), 0.65),
       'device at ' + read());
    ok('but the obsolete record is dropped', readPin() === null);

    // ── a sink the slider already reaches needs no pin at all ──
    await dv.restoreSink();
    state = await dv.pinSinkToUnity(SLIDER);
    ok('pinning the device the slider already controls is a no-op',
       state.kind === 'idle', JSON.stringify(state));
    ok('and writes no pin file', readPin() === null);

    // ── a device that does not exist ──
    state = await dv.pinSinkToUnity('Definitely Not A Device');
    ok('an unknown device reports an error', state.kind === 'error', JSON.stringify(state));
    ok('and writes no pin file', readPin() === null);

    // ── the quit path, from here down, against a stub helper ──
    // Everything below drives restoreSinkOnQuit(), which main.ts calls from
    // before-quit. Nothing here touches a real device: the helper the module
    // resolves is replaced, and the device named in the records is invented.

    // Unlink before copying: a helper spawned by the previous case may still be
    // executing this path, and writing through it would truncate the script out
    // from under a running shell.
    const useStub = (name) => {
      try { fs.unlinkSync(MODULE_HELPER); } catch {}
      fs.copyFileSync(path.join(STUB_DIR, name), MODULE_HELPER);
      fs.chmodSync(MODULE_HELPER, 0o755);
    };
    const exists = (p) => { try { fs.statSync(p); return true; } catch { return false; } };
    const clear = (p) => { try { fs.unlinkSync(p); } catch {} };
    const writeStubPin = () => fs.writeFileSync(pinFile(), JSON.stringify({
      deviceName: STUB_DEVICE, originalVolume: 0.4, pinnedTo: 1, pinnedAt: new Date().toISOString(),
    }));
    const setLog = () => {
      try { return fs.readFileSync(SET_LOG, 'utf8').split('\\n').filter(Boolean); } catch { return []; }
    };

    await dv.restoreSink();

    // A quit-restore whose helper fails has NOT put the device back, so the
    // record is the only thing standing between the user and speakers left at
    // 100%. execFile hands that failure to a callback, asynchronously, long
    // after the surrounding try/catch has returned — so clearing the record
    // next to the call rather than inside it deletes it on exactly the runs
    // where it was still needed, and restoreStalePin() has nothing to find.
    useStub('failing');
    clear(MARKER_FAILING);
    writeStubPin();
    dv.restoreSinkOnQuit();
    await waitFor(() => exists(MARKER_FAILING), 2000); // the helper has really run, and really failed
    ok('a quit-restore whose helper fails keeps the record for next launch',
       readPin() !== null, 'pin file is ' + JSON.stringify(readPin()));

    // And the cure must not be "never clear it". A record left behind after a
    // restore that worked makes every launch undo a device nobody touched.
    useStub('working');
    clear(MARKER_WORKING);
    writeStubPin();
    dv.restoreSinkOnQuit();
    const cleared = await waitFor(() => readPin() === null, 2000);
    await waitFor(() => exists(MARKER_WORKING), 2000);
    ok('a quit-restore whose helper works clears the record',
       cleared, 'pin file is ' + JSON.stringify(readPin()));

    // Every other entry point goes through serialize(); restoreSinkOnQuit does
    // not. Quit while a pin is still setting the device and two writes to the
    // same device are in flight with nothing ordering them — the user's volume
    // is decided by which process happens to finish last. Here the pin is made
    // the slow one, which is the direction that hurts: its set-to-unity lands
    // after the restore and the device is stranded at 100%.
    useStub('ordered');
    clear(SET_LOG);
    const pinning = dv.pinSinkToUnity(STUB_DEVICE);
    await waitFor(() => readPin() !== null, 2000); // record on disk = the set is in flight
    dv.restoreSinkOnQuit();
    await pinning;
    await waitFor(() => setLog().length >= 2, 3000);
    ok('a quit landing mid-pin is ordered after it',
       setLog()[setLog().length - 1] === '0.4',
       'helper set calls, in order: ' + (setLog().join(' -> ') || '(none)'));

    await dv.restoreSink();
    clear(MODULE_HELPER);
    fs.copyFileSync(${JSON.stringify(realHelper)}, MODULE_HELPER);
  } catch (err) {
    results.push({ name: 'harness threw', pass: false, detail: String(err && err.stack || err) });
  }
  fs.writeFileSync(${JSON.stringify(join(work, 'results.json'))}, JSON.stringify(results));
  app.exit(0);
});
`;

let failed = 0;
try {
  execFileSync(esbuild, [
    join(repoRoot, 'electron/deviceVolume.ts'),
    '--bundle', '--platform=node', '--format=cjs', '--external:electron',
    `--outfile=${join(work, 'run/deviceVolume.cjs')}`,
  ], { stdio: 'pipe' });

  writeFileSync(join(work, 'harness.js'), harness);
  writeFileSync(join(work, 'package.json'), JSON.stringify({ name: 'check', main: 'harness.js' }));

  execFileSync(electronBin, [work, `--user-data-dir=${join(work, 'udd')}`], {
    stdio: 'pipe',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
  });

  const results = JSON.parse(execFileSync('cat', [join(work, 'results.json')], { encoding: 'utf8' }));
  console.log('\nOutput-sink volume pinning\n');
  for (const r of results) {
    console.log(`  ${r.pass ? 'ok  ' : 'FAIL'}    ${r.name}${r.detail && !r.pass ? `  (${r.detail})` : ''}`);
    if (!r.pass) failed++;
  }
} finally {
  // Always hand the device back, even if the assertions blew up halfway.
  try {
    execFileSync(realHelper, ['set', DEVICE, String(originalVolume)]);
    console.log(`\nrestored ${DEVICE} to ${originalVolume}`);
    if (typeof originalSlider === 'number' && slider.name) {
      execFileSync(realHelper, ['set', slider.name, String(originalSlider)]);
      console.log(`restored ${slider.name} to ${originalSlider}`);
    }
  } catch (err) {
    console.error('COULD NOT RESTORE a device volume:', err.message);
    failed++;
  }
  rmSync(work, { recursive: true, force: true });
}

if (failed) {
  console.error(`\n${failed} sink-volume check(s) failed.`);
  process.exit(1);
}
console.log('\nAll sink-volume checks passed.');

#!/usr/bin/env node
/**
 * Regression check for the main window's presence (`electron/windowPresence.ts`).
 *
 * Presence decides whether the renderer draws at all. Its failures are silent
 * by construction: get "away" wrong one way and a covered window burns two
 * cores drawing for nobody, which is the bug it exists to fix; get it wrong
 * the other way and the visuals freeze in front of someone watching them.
 * Neither throws.
 *
 * So this drives the real module inside a real Electron (powerMonitor and
 * process.pid have to be genuine), against a scripted window and a STUB
 * avwindow helper standing in for the window server. Nothing here creates a
 * window or touches the display. The real helper's verdicts are a separate
 * question: they were checked by hand against real covered and uncovered
 * windows, and `avwindow watch` is read-only.
 *
 * Asserts:
 *   - focus, blur, hide, show, minimize, restore and a locked screen each land
 *     on the right state;
 *   - the helper runs only while the window is shown but unfocused, with the
 *     window's number and this process's pid, and stops when that ends;
 *   - covered and not-on-screen verdicts mean away, and a visible one undoes
 *     them;
 *   - a helper that cannot start, or dies, is given up rather than respawned
 *     on every focus change, and presence falls back to the window's events.
 *
 *   npm run check:presence
 */

import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const electronBin = join(repoRoot, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');
const esbuild = join(repoRoot, 'node_modules/.bin/esbuild');

const work = mkdtempSync(join(tmpdir(), 'av-presence-check-'));
// windowPresence.ts resolves the helper at `__dirname/../build/helpers/avwindow`
// in a dev build, so mirror that shape inside the work dir.
mkdirSync(join(work, 'run'), { recursive: true });
mkdirSync(join(work, 'build/helpers'), { recursive: true });
const stub = join(work, 'build/helpers/avwindow');
const spawnLog = join(work, 'spawn-log.txt');
const verdictFile = join(work, 'verdict.txt');

// The stand-in for the window server: logs how it was started, then repeats
// whatever verdict the harness last wrote, until its stdin closes. stdin is
// duplicated first because bash gives a backgrounded command /dev/null for
// stdin, which would end the stub the moment it started.
writeFileSync(stub, `#!/bin/bash
echo "start $*" >> ${JSON.stringify(spawnLog)}
exec 3<&0
( while read -r _ <&3; do :; done; echo "stop" >> ${JSON.stringify(spawnLog)}; kill $$ ) &
last=""
while true; do
  v="$(cat ${JSON.stringify(verdictFile)} 2>/dev/null)"
  if [ "$v" != "$last" ]; then echo "$v"; last="$v"; fi
  sleep 0.05
done
`);
chmodSync(stub, 0o755);

const harness = `
const { app, powerMonitor } = require('electron');
const fs = require('fs');
const { EventEmitter } = require('events');
const wp = require(${JSON.stringify(join(work, 'run/windowPresence.cjs'))});
const STUB = ${JSON.stringify(stub)};
const SPAWN_LOG = ${JSON.stringify(spawnLog)};
const VERDICT = ${JSON.stringify(verdictFile)};
const results = [];
const ok = (name, pass, detail) => results.push({ name, pass, detail });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (pred, ms) => { const until = Date.now() + ms; while (Date.now() < until) { if (pred()) return true; await sleep(10); } return pred(); };
const log = () => { try { return fs.readFileSync(SPAWN_LOG, 'utf8').trim().split('\\n').filter(Boolean); } catch { return []; } };
const verdict = (visible, reason) => fs.writeFileSync(VERDICT, JSON.stringify({ visible, reason }));

// A window reduced to what the module reads, driven by hand.
class FakeWindow extends EventEmitter {
  constructor() { super(); this.visible = true; this.minimized = false; this.focused = true; this.destroyed = false; this.mediaId = 'window:4242:0'; }
  isVisible() { return this.visible; }
  isMinimized() { return this.minimized; }
  isFocused() { return this.focused; }
  isDestroyed() { return this.destroyed; }
  getMediaSourceId() { return this.mediaId; }
  set(fields, event) { Object.assign(this, fields); this.emit(event); }
}

app.whenReady().then(async () => {
  try {
    let current = null;
    wp.onWindowPresenceChange((p) => { current = p; });
    const now = () => JSON.stringify(wp.getWindowPresence());
    verdict(true, null);

    const win = new FakeWindow();
    wp.trackWindowPresence(win);
    ok('a focused window is focused', now() === '{"kind":"focused"}', now());
    ok('and starts no helper', log().length === 0, log().join(' | '));

    win.set({ focused: false }, 'blur');
    await waitFor(() => log().length >= 1, 2000);
    ok('blurred but on screen is background', now() === '{"kind":"background"}', now());
    ok('and starts the helper with the window number and this pid',
       log()[0] === 'start watch 4242 ' + process.pid, log().join(' | '));

    verdict(false, 'covered');
    ok('covered is away', await waitFor(() => now() === '{"kind":"away","reason":"covered"}', 2000), now());
    ok('and was announced', current && current.kind === 'away', JSON.stringify(current));
    verdict(true, null);
    ok('uncovered is background again', await waitFor(() => now() === '{"kind":"background"}', 2000), now());
    verdict(false, 'not-on-screen');
    ok('on another Space is away', await waitFor(() => now() === '{"kind":"away","reason":"not-on-screen"}', 2000), now());

    win.set({ focused: true }, 'focus');
    ok('focusing it again is focused', now() === '{"kind":"focused"}', now());
    ok('and stops the helper', await waitFor(() => log().includes('stop'), 2000), log().join(' | '));

    verdict(true, null);
    win.set({ visible: false }, 'hide');
    ok('hidden is away, hidden', now() === '{"kind":"away","reason":"hidden"}', now());
    win.set({ visible: true, focused: false }, 'show');
    await waitFor(() => log().filter((l) => l.startsWith('start')).length >= 2, 2000);
    ok('shown unfocused is background', now() === '{"kind":"background"}', now());
    win.set({ minimized: true }, 'minimize');
    ok('minimized is away, minimized', now() === '{"kind":"away","reason":"minimized"}', now());
    win.set({ minimized: false, focused: true }, 'restore');
    ok('restored and focused is focused', now() === '{"kind":"focused"}', now());

    powerMonitor.emit('lock-screen');
    ok('a locked screen is away, locked', now() === '{"kind":"away","reason":"locked"}', now());
    powerMonitor.emit('unlock-screen');
    ok('unlocking puts it back', now() === '{"kind":"focused"}', now());

    // A window with no usable number: nothing to ask, so background, no helper.
    const starts = () => log().filter((l) => l.startsWith('start')).length;
    const before = starts();
    win.mediaId = 'window:not-a-number:0';
    win.set({ focused: false }, 'blur');
    await sleep(300);
    ok('no window number means background and no helper', now() === '{"kind":"background"}' && starts() === before,
       now() + ' starts ' + before + ' -> ' + starts());
    win.mediaId = 'window:4242:0';
    win.set({ focused: true }, 'focus');

    // The helper dies on its own: give it up, keep drawing.
    fs.writeFileSync(STUB, '#!/bin/bash\\necho "start $*" >> ' + JSON.stringify(SPAWN_LOG) + '\\nexit 3\\n');
    const beforeDeath = starts();
    win.set({ focused: false }, 'blur');
    await sleep(600);
    for (let i = 0; i < 5; i++) { win.set({ focused: true }, 'focus'); win.set({ focused: false }, 'blur'); await sleep(60); }
    await sleep(300);
    ok('a helper that dies is not respawned on every focus change', starts() - beforeDeath === 1,
       (starts() - beforeDeath) + ' spawn(s) after the death');
    ok('and presence falls back to background', now() === '{"kind":"background"}', now());
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
    join(repoRoot, 'electron/windowPresence.ts'),
    '--bundle', '--platform=node', '--format=cjs', '--external:electron',
    `--outfile=${join(work, 'run/windowPresence.cjs')}`,
  ], { stdio: 'pipe' });
  writeFileSync(join(work, 'harness.js'), harness);
  writeFileSync(join(work, 'package.json'), JSON.stringify({ name: 'check', main: 'harness.js' }));
  execFileSync(electronBin, [work, `--user-data-dir=${join(work, 'udd')}`], {
    stdio: 'pipe',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
    timeout: 60_000,
  });
  const results = JSON.parse(readFileSync(join(work, 'results.json'), 'utf8'));
  console.log('\nWindow presence\n');
  for (const r of results) {
    console.log(`  ${r.pass ? 'ok  ' : 'FAIL'}    ${r.name}${r.detail && !r.pass ? `  (${r.detail})` : ''}`);
    if (!r.pass) failed++;
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

if (failed) {
  console.error(`\n${failed} presence check(s) failed.`);
  process.exit(1);
}
console.log('\nAll presence checks passed.');

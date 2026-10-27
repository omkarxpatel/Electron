/**
 * Keeps the app's output device at unity while Live is on.
 *
 * The problem this solves: the macOS volume slider only ever addresses the
 * DEFAULT output device. Once the user points system output at BlackHole so we
 * can tap it, the device we play out of via `setSinkId` stops being the default
 * — and nothing in the UI can reach its volume any more. It stays frozen at
 * whatever it held when the user switched away, and that frozen value is a hard
 * ceiling on how loud we can ever get. Total output is
 * `BlackHole_dB + sink_dB`, and the slider only moves the first term.
 *
 * Measured on a real machine: the slider spans ~64 dB on built-in speakers and
 * ~100 dB on Bluetooth, so a sink left at 20% is 50-80 dB down. That is the
 * "it never gets loud enough, and wherever I was when I switched becomes the
 * ceiling" report, exactly.
 *
 * So we pin the sink to 1.0 and let BlackHole's volume — which the slider DOES
 * control, and which genuinely attenuates the samples (measured: -11.97 dB at a
 * setting reporting -12.0) — stay the user's one real volume control.
 *
 * We deliberately do NOT compensate for BlackHole's attenuation in the audio
 * graph. Cancelling it out digitally would leave the slider connected to
 * nothing.
 *
 * ── The dangerous part ──
 * Pinning means we raised someone's output device to 100%. If we die before
 * restoring it, they switch back to those speakers later and get blasted. So
 * the original value is written to disk BEFORE the device is touched, and
 * recovered on next launch. `restoreStalePin` is called at startup for exactly
 * that reason.
 */

import { app } from 'electron';
import { execFile, execFileSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { promisify } from 'node:util';
import path from 'node:path';
import { isPackagedBuild } from './updater';

const execFileAsync = promisify(execFile);

const PIN_FILE_NAME = 'sink-volume-pin.json';

/** What we raise the sink to. Unity — the point is to stop the sink
 *  attenuating at all, so the slider's range is the whole range. */
const TARGET_SCALAR = 1;

/** Scalars are float32 round-trips, so compare with a tolerance rather than
 *  for equality. Also wide enough to absorb a device that quantises its
 *  volume to 1/16 steps, as several do. */
const SCALAR_EPSILON = 0.02;

/** Budget for the read-only probes (`get`, `default`), which stay async. */
const HELPER_TIMEOUT_MS = 4000;

/** Budget for a device WRITE. Writes run synchronously — see runHelperSync()
 *  for why — so this is how long the main thread can stall on a wedged
 *  helper, which is why it is far shorter than the probe budget. Measured on
 *  a real machine, a `set` returns in 100-180 ms; one that has not returned
 *  in 1.5 s is not going to. */
const WRITE_TIMEOUT_MS = 1500;

export type SinkVolumeState =
  | { kind: 'idle' }
  | { kind: 'pinned'; deviceName: string; originalVolume: number }
  /** The device works but was already at unity, so there was nothing to do.
   *  Tracked separately so the UI can say "nothing to fix" rather than
   *  implying we changed something. */
  | { kind: 'already-unity'; deviceName: string }
  /** Aggregate devices and some virtual drivers expose no volume control at
   *  all. Not an error — but the ceiling can't be lifted, so say so. */
  | { kind: 'unsupported'; deviceName: string; reason: string }
  | { kind: 'error'; deviceName: string; message: string };

interface PinRecord {
  deviceName: string;
  originalVolume: number;
  /** What we set it to, so a stale-pin restore can tell "still ours" from
   *  "the user has since changed it themselves". */
  pinnedTo: number;
  pinnedAt: string;
}

let state: SinkVolumeState = { kind: 'idle' };
let listener: ((state: SinkVolumeState) => void) | null = null;

/**
 * Pin and restore mutate one piece of global machine state through a child
 * process, so they must not interleave. The renderer switching sinks fires a
 * restore and a pin back to back, and if the restore's write landed after the
 * pin's read, the saved "original" would be our own 1.0 — the user's real
 * volume lost permanently.
 *
 * restoreSinkOnQuit() is the one caller that does NOT go through here, because
 * `before-quit` cannot await a promise. It is ordered against this queue by a
 * different mechanism: every device write in this file is synchronous, so the
 * event loop cannot deliver `before-quit` in the middle of one.
 */
let queue: Promise<unknown> = Promise.resolve();

/**
 * Bumped by restoreSinkOnQuit(). A pin that was suspended on one of its read
 * probes when the quit landed must not go on to raise a device afterwards:
 * the quit-time restore has already run and is not coming round again, so
 * that raise would be the last thing ever done to the device — and it would
 * write a fresh pin record over the one the quit just cleared, leaving the
 * app believing it holds a pin it has already handed back.
 */
let quitRestoreGeneration = 0;

function serialize<T>(operation: () => Promise<T>): Promise<T> {
  const next = queue.then(operation, operation);
  queue = next.catch(() => undefined);
  return next;
}

function setState(next: SinkVolumeState): void {
  state = next;
  listener?.(next);
}

export function getSinkVolumeState(): SinkVolumeState {
  return state;
}

export function onSinkVolumeChange(handler: (state: SinkVolumeState) => void): void {
  listener = handler;
}

// ── Helper process ─────────────────────────────────────────────────────────

function helperPath(): string {
  // Same split as trayIconPath(): extraResources in a shipped build, straight
  // out of the repo in dev. isPackagedBuild(), never app.isPackaged — see
  // updater.ts for why that check is permanently false here.
  return isPackagedBuild()
    ? path.join(process.resourcesPath, 'helpers', 'avvolume')
    : path.join(__dirname, '..', 'build', 'helpers', 'avvolume');
}

interface HelperResult {
  name?: string;
  uid?: string;
  hasVolumeControl?: boolean;
  volume?: number | null;
  error?: string;
}

async function runHelper(args: string[]): Promise<HelperResult> {
  try {
    const { stdout } = await execFileAsync(helperPath(), args, { timeout: HELPER_TIMEOUT_MS });
    return JSON.parse(stdout) as HelperResult;
  } catch (err) {
    // The helper reports failures as JSON on stdout with exit 1, so a non-zero
    // exit still carries a usable message. Anything else (missing binary, bad
    // architecture) lands in the catch-all below.
    const stdout = (err as { stdout?: string }).stdout;
    if (stdout) {
      try {
        return JSON.parse(stdout) as HelperResult;
      } catch {
        /* fall through */
      }
    }
    const message = err instanceof Error ? err.message : String(err);
    return { error: message };
  }
}

/**
 * The synchronous twin of runHelper(), used for every device WRITE.
 *
 * Blocking the main thread for a helper spawn buys an invariant that is
 * otherwise unobtainable here: `before-quit` arrives as a JS callback on the
 * event loop, so while a write holds that loop the quit cannot be delivered
 * in the middle of it. Without that, a quit landing mid-pin puts two writes
 * to the same device in flight with nothing ordering them, and if the pin's
 * `set … 1` happens to land last the device is stranded at 100%.
 *
 * The probes stay async: they decide things, they don't change them, so a
 * quit landing during one is harmless as long as the pin notices (it does —
 * see the generation check in pinSinkToUnityImpl).
 */
function runHelperSync(args: string[]): HelperResult {
  try {
    const stdout = execFileSync(helperPath(), args, {
      encoding: 'utf8',
      timeout: WRITE_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return JSON.parse(stdout) as HelperResult;
  } catch (err) {
    // Same split as runHelper(): the helper reports its own failures as JSON
    // on stdout with exit 1, so a non-zero exit still carries a message.
    const stdout = (err as { stdout?: string }).stdout;
    if (stdout) {
      try {
        return JSON.parse(stdout) as HelperResult;
      } catch {
        /* fall through */
      }
    }
    const message = err instanceof Error ? err.message : String(err);
    return { error: message };
  }
}

// ── Pin record persistence ─────────────────────────────────────────────────

function pinFilePath(): string {
  return path.join(app.getPath('userData'), PIN_FILE_NAME);
}

/**
 * Temp file, fsync, rename — because this record is the only way back from a
 * raised device. A plain writeFileSync can leave a zero-byte file if the
 * machine goes down mid-write, and readPinRecord() cannot tell that from
 * "nothing was pinned": JSON.parse('') throws, restoreStalePin() finds no
 * record, and the device stays at 100% with nobody left who knows it should
 * not be. After this the pin file is either the old content or the new one.
 *
 * Throws on failure, deliberately — see the caller.
 */
function writePinRecord(record: PinRecord): void {
  const target = pinFilePath();
  const temp = `${target}.tmp`;
  const fd = openSync(temp, 'w');
  try {
    writeFileSync(fd, JSON.stringify(record, null, 2), 'utf8');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, target);
}

function readPinRecord(): PinRecord | null {
  try {
    if (!existsSync(pinFilePath())) return null;
    const parsed = JSON.parse(readFileSync(pinFilePath(), 'utf8')) as Partial<PinRecord>;
    if (typeof parsed.deviceName !== 'string' || typeof parsed.originalVolume !== 'number') {
      return null;
    }
    return {
      deviceName: parsed.deviceName,
      originalVolume: parsed.originalVolume,
      pinnedTo: typeof parsed.pinnedTo === 'number' ? parsed.pinnedTo : TARGET_SCALAR,
      pinnedAt: typeof parsed.pinnedAt === 'string' ? parsed.pinnedAt : '',
    };
  } catch {
    return null;
  }
}

function clearPinRecord(): void {
  try {
    if (existsSync(pinFilePath())) unlinkSync(pinFilePath());
  } catch {
    /* A pin file we can't delete would re-restore next launch, which is the
     * safe direction to fail in. Not worth surfacing. */
  }
}

// ── Public operations ──────────────────────────────────────────────────────

/**
 * Raise `deviceLabel` to unity, remembering what it was.
 *
 * `deviceLabel` is the renderer's `enumerateDevices()` label, because that is
 * the only identifier it has — Chromium deviceIds are per-origin salted hashes
 * with no path back to a CoreAudio device. The helper matches on name and
 * tolerates Chromium's transport suffixes ("... (Built-in)").
 */
async function pinSinkToUnityImpl(deviceLabel: string): Promise<SinkVolumeState> {
  if (process.platform !== 'darwin') return state;
  if (!deviceLabel) return state;

  const generation = quitRestoreGeneration;

  // Re-pinning the device we already hold would overwrite the saved original
  // with our own 1.0, losing the user's value for good.
  if (state.kind === 'pinned' && state.deviceName === deviceLabel) return state;

  // Switching sinks: put the previous one back before taking the next.
  if (state.kind === 'pinned') await restoreSinkImpl();

  const sink = await runHelper(['get', deviceLabel]);
  if (sink.error) {
    setState({ kind: 'error', deviceName: deviceLabel, message: sink.error });
    return state;
  }
  const name = sink.name ?? deviceLabel;
  if (!sink.hasVolumeControl || typeof sink.volume !== 'number') {
    setState({
      kind: 'unsupported',
      deviceName: name,
      reason: 'this device has no software volume control',
    });
    return state;
  }

  // What the menu-bar slider is actually attached to. If that IS our sink,
  // the slider already reaches it and there is no ceiling to lift — this is
  // the ordinary "not using BlackHole" case, and it needs no message.
  const slider = await runHelper(['default']);
  if (!slider.error && slider.uid && slider.uid === sink.uid) {
    setState({ kind: 'idle' });
    return state;
  }

  if (sink.volume >= TARGET_SCALAR - SCALAR_EPSILON) {
    setState({ kind: 'already-unity', deviceName: name });
    return state;
  }

  /* ── Why we raise it and stop ──
   *
   * An earlier version also turned the slider device DOWN by the same number
   * of slider points, so the pin wasn't a loudness jump. That was wrong, and
   * wrong in the direction that matters: with a sink at 37% it drove BlackHole
   * from 75% to 12%, which on its measured ~64 dB taper is about -56 dB —
   * near silence. The app started almost inaudible, which is the very problem
   * this file exists to fix.
   *
   * The unit was the mistake. Slider points are only comparable between two
   * devices if their tapers are, and they are not: BlackHole spans ~64 dB
   * while a Bluetooth sink applies its own much gentler curve. dB would be the
   * right unit and is not available either, because Bluetooth devices report
   * nominal values (these AirPods claimed -0.0 dB at scalar 0.5). With no
   * honest unit, any compensation is guesswork, and guessing quiet is as bad
   * as guessing loud.
   *
   * So we touch exactly one device and always put it back. Raising the sink
   * does make things louder — that is the point, it is the cap being removed —
   * and the menu bar slider is right there, working over its full range, if
   * it went further than wanted. That adjustment then sticks, because the
   * slider's device is one we never touch.
   */

  // A quit landed while the probes above were in flight. restoreSinkOnQuit()
  // has already put any held device back and cannot wait for us, so raising
  // one now would strand it at unity as the app goes away — and overwrite the
  // record the quit just cleared.
  if (quitRestoreGeneration !== generation) return state;

  // Disk before device: if we crash between these two lines the worst case is
  // a restore of a value that was never changed, which is harmless. The other
  // order can strand the device at 100%.
  try {
    writePinRecord({
      deviceName: name,
      originalVolume: sink.volume,
      pinnedTo: TARGET_SCALAR,
      pinnedAt: new Date().toISOString(),
    });
  } catch (err) {
    // No record means no way back from the raise, so don't make the raise. A
    // sink left at its own volume is only a ceiling; a sink at unity with
    // nothing on disk is someone's speakers at 100% forever.
    const reason = err instanceof Error ? err.message : String(err);
    setState({
      kind: 'error',
      deviceName: name,
      message: `could not save the restore record: ${reason}`,
    });
    return state;
  }

  // Synchronous, and that is the point: with the write holding the event
  // loop, `before-quit` cannot be delivered between the record landing on
  // disk and the device reaching unity.
  const applied = runHelperSync(['set', name, String(TARGET_SCALAR)]);
  if (applied.error) {
    clearPinRecord();
    setState({ kind: 'error', deviceName: name, message: applied.error });
    return state;
  }

  setState({ kind: 'pinned', deviceName: name, originalVolume: sink.volume });
  return state;
}

/**
 * Put the sink back where we found it. Safe to call when nothing is pinned.
 *
 * One device in, one device out. That symmetry is what makes launching twice
 * behave like launching once — the version that also moved the slider device
 * had no way back, so every launch re-applied the same subtraction and walked
 * the system volume down to nothing.
 */
async function restoreSinkImpl(): Promise<void> {
  if (process.platform !== 'darwin') return;
  const record = state.kind === 'pinned'
    ? { deviceName: state.deviceName, originalVolume: state.originalVolume, pinnedTo: TARGET_SCALAR }
    : readPinRecord();
  if (!record) {
    setState({ kind: 'idle' });
    return;
  }
  // Same staleness rule as restoreStalePinImpl: only put the device back if
  // it is still sitting at the value we set. A user who has moved it since we
  // pinned it has made a newer choice than ours, and writing over it is the
  // second bug.
  const current = await runHelper(['get', record.deviceName]);
  if (current.error || typeof current.volume !== 'number') {
    // Device is gone (unplugged headphones, most likely). Keep the record so
    // a later launch can still undo it — leaving someone's headphones pinned
    // at 100% is exactly the outcome this whole file exists to prevent.
    setState({ kind: 'idle' });
    return;
  }
  if (Math.abs(current.volume - record.pinnedTo) <= SCALAR_EPSILON) {
    runHelperSync(['set', record.deviceName, String(record.originalVolume)]);
  }
  clearPinRecord();
  setState({ kind: 'idle' });
}

export function pinSinkToUnity(deviceLabel: string): Promise<SinkVolumeState> {
  return serialize(() => pinSinkToUnityImpl(deviceLabel));
}

export function restoreSink(): Promise<void> {
  return serialize(() => restoreSinkImpl());
}

/**
 * Startup recovery. A pin file present at launch means a previous run died
 * holding someone's output device at 100%.
 *
 * We only put it back if the device is still sitting at the value we set. If
 * the user has since moved it themselves, their choice is newer than ours and
 * overwriting it would be the second bug — so we drop the record and leave the
 * device alone.
 */
async function restoreStalePinImpl(): Promise<void> {
  if (process.platform !== 'darwin') return;
  const record = readPinRecord();
  if (!record) return;

  const current = await runHelper(['get', record.deviceName]);
  if (current.error || typeof current.volume !== 'number') {
    // Device is gone (unplugged headphones, most likely). Keep the record so
    // a later launch can still undo it — leaving someone's headphones pinned
    // at 100% is exactly the outcome this whole file exists to prevent.
    return;
  }
  if (Math.abs(current.volume - record.pinnedTo) > SCALAR_EPSILON) {
    clearPinRecord();
    return;
  }
  runHelperSync(['set', record.deviceName, String(record.originalVolume)]);
  clearPinRecord();
}

export function restoreStalePin(): Promise<void> {
  return serialize(() => restoreStalePinImpl());
}

/**
 * Fully synchronous restore for `before-quit`, which gives us no chance to
 * await. Two things make it safe, and both are load-bearing.
 *
 * ── It is ordered against an in-flight pin ──
 * This is the one entry point that cannot go through serialize(). It does not
 * need to: every device write in this file is synchronous, so the event loop
 * cannot deliver `before-quit` in the middle of one and there is never a
 * write to race. A pin suspended on one of its read probes is stopped by the
 * generation bump below before it can reach its own write. That also settles
 * who owns the pin record: at this point no pin is part-way through writing
 * one, so the record on disk belongs to a finished operation and is ours to
 * clear. The version that bypassed the queue cleared a record an in-flight
 * pin had just written, leaving state 'pinned' with nothing on disk and the
 * device at 100%.
 *
 * ── It only clears the record once the helper really worked ──
 * The version before this used execFile() with an empty callback and deleted
 * the record on the next line. execFile reports a failed spawn or a non-zero
 * exit asynchronously, into that callback, long after this function returned
 * — so the record was thrown away on exactly the runs where the device had
 * NOT been put back, and restoreStalePin() found nothing next launch.
 */
export function restoreSinkOnQuit(): void {
  if (process.platform !== 'darwin') return;
  quitRestoreGeneration++;
  const record = state.kind === 'pinned'
    ? { deviceName: state.deviceName, originalVolume: state.originalVolume }
    : readPinRecord();
  if (!record) return;
  const applied = runHelperSync(['set', record.deviceName, String(record.originalVolume)]);
  if (applied.error) {
    /* The device is still at unity and the record is the only thing that can
     * undo that, so it stays: restoreStalePin() picks it up next launch. */
    return;
  }
  clearPinRecord();
  state = { kind: 'idle' };
}

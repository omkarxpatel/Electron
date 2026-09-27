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
import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
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

const HELPER_TIMEOUT_MS = 4000;

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
 * volume lost permanently. Everything that touches a device goes through here.
 */
let queue: Promise<unknown> = Promise.resolve();

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

// ── Pin record persistence ─────────────────────────────────────────────────

function pinFilePath(): string {
  return path.join(app.getPath('userData'), PIN_FILE_NAME);
}

function writePinRecord(record: PinRecord): void {
  writeFileSync(pinFilePath(), JSON.stringify(record, null, 2), 'utf8');
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

  // Re-pinning the device we already hold would overwrite the saved original
  // with our own 1.0, losing the user's value for good.
  if (state.kind === 'pinned' && state.deviceName === deviceLabel) return state;

  // Switching sinks: put the previous one back before taking the next.
  if (state.kind === 'pinned') await restoreSinkImpl();

  const current = await runHelper(['get', deviceLabel]);
  if (current.error) {
    setState({ kind: 'error', deviceName: deviceLabel, message: current.error });
    return state;
  }
  const name = current.name ?? deviceLabel;
  if (!current.hasVolumeControl || typeof current.volume !== 'number') {
    setState({
      kind: 'unsupported',
      deviceName: name,
      reason: 'this device has no software volume control',
    });
    return state;
  }
  if (current.volume >= TARGET_SCALAR - SCALAR_EPSILON) {
    setState({ kind: 'already-unity', deviceName: name });
    return state;
  }

  // Disk before device: if we crash between these two lines the worst case is
  // a restore of a value that was never changed, which is harmless. The other
  // order can strand the device at 100%.
  writePinRecord({
    deviceName: name,
    originalVolume: current.volume,
    pinnedTo: TARGET_SCALAR,
    pinnedAt: new Date().toISOString(),
  });

  const applied = await runHelper(['set', name, String(TARGET_SCALAR)]);
  if (applied.error) {
    clearPinRecord();
    setState({ kind: 'error', deviceName: name, message: applied.error });
    return state;
  }

  setState({ kind: 'pinned', deviceName: name, originalVolume: current.volume });
  return state;
}

/** Put the pinned device back where we found it. Safe to call when nothing
 *  is pinned. */
async function restoreSinkImpl(): Promise<void> {
  if (process.platform !== 'darwin') return;
  const record = state.kind === 'pinned'
    ? { deviceName: state.deviceName, originalVolume: state.originalVolume, pinnedTo: TARGET_SCALAR }
    : readPinRecord();
  if (!record) {
    setState({ kind: 'idle' });
    return;
  }
  await runHelper(['set', record.deviceName, String(record.originalVolume)]);
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
  await runHelper(['set', record.deviceName, String(record.originalVolume)]);
  clearPinRecord();
}

export function restoreStalePin(): Promise<void> {
  return serialize(() => restoreStalePinImpl());
}

/** Synchronous best-effort restore for `before-quit`, where there is no time
 *  to await a promise. Spawns the helper detached and lets it outlive us. */
export function restoreSinkOnQuit(): void {
  if (process.platform !== 'darwin') return;
  const record = state.kind === 'pinned'
    ? { deviceName: state.deviceName, originalVolume: state.originalVolume }
    : readPinRecord();
  if (!record) return;
  try {
    execFile(helperPath(), ['set', record.deviceName, String(record.originalVolume)], () => {});
    clearPinRecord();
    state = { kind: 'idle' };
  } catch {
    /* Leaving the pin file behind is the right failure: restoreStalePin()
     * picks it up on the next launch. */
  }
}

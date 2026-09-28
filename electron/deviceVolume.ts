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

/** Never drive the slider device to silence while compensating. A muted menu
 *  bar reads as "the app broke my sound" even when the arithmetic was right. */
const COMPENSATION_FLOOR = 0.05;

const HELPER_TIMEOUT_MS = 4000;

export type SinkVolumeState =
  | { kind: 'idle' }
  | {
      kind: 'pinned';
      deviceName: string;
      originalVolume: number;
      /** The device the menu-bar slider controls, which we turned DOWN by the
       *  same amount we turned the sink up. Absent if no move was needed. */
      compensatedDevice?: string;
    }
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
  /** What we did to the slider device, recorded for the UI and for diagnosis.
   *  Deliberately NOT restored — see restoreSinkImpl(). */
  compensation?: { deviceName: string; originalVolume: number; setTo: number };
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

  /* ── Why we do not simply raise the sink and stop ──
   *
   * Raising the sink is a loudness jump the user did not ask for, delivered
   * to whatever is on their head. Observed: AirPods sitting at 50% while
   * BlackHole was at 100%, so pinning alone would have gone straight to full
   * scale in someone's ears.
   *
   * So the attenuation is MOVED rather than removed: the sink goes to unity
   * and the slider device comes down by the same number of slider points.
   * Total loudness is about what it was, the ceiling is gone, and the slider
   * ends up sitting roughly where the combined level was — which is also the
   * position the user expects to see.
   *
   * Slider points, not dB. dB would be exact, but only where it is reported
   * honestly, and Bluetooth devices do not report it honestly: these AirPods
   * report -0.0 dB while sitting at scalar 0.5. Both ends of this sum use the
   * same macOS slider metaphor, so points are the unit that is actually
   * comparable across them.
   */
  if (slider.error || !slider.hasVolumeControl || typeof slider.volume !== 'number') {
    setState({
      kind: 'unsupported',
      deviceName: name,
      reason:
        'the volume slider is attached to a device with no volume control, so ' +
        "raising this one would only make things suddenly louder",
    });
    return state;
  }

  const sliderName = slider.name ?? 'system output';
  const compensated = Math.min(
    TARGET_SCALAR,
    Math.max(COMPENSATION_FLOOR, slider.volume - (TARGET_SCALAR - sink.volume)),
  );

  // Disk before device: if we crash between these two lines the worst case is
  // a restore of a value that was never changed, which is harmless. The other
  // order can strand the device at 100%.
  writePinRecord({
    deviceName: name,
    originalVolume: sink.volume,
    pinnedTo: TARGET_SCALAR,
    pinnedAt: new Date().toISOString(),
    compensation: { deviceName: sliderName, originalVolume: slider.volume, setTo: compensated },
  });

  // Slider down BEFORE sink up, so the intermediate state is quieter than
  // where we started rather than louder.
  const lowered = await runHelper(['set', sliderName, String(compensated)]);
  if (lowered.error) {
    clearPinRecord();
    setState({ kind: 'error', deviceName: name, message: lowered.error });
    return state;
  }

  const applied = await runHelper(['set', name, String(TARGET_SCALAR)]);
  if (applied.error) {
    // Undo the compensating move so a failure leaves nothing behind.
    await runHelper(['set', sliderName, String(slider.volume)]);
    clearPinRecord();
    setState({ kind: 'error', deviceName: name, message: applied.error });
    return state;
  }

  setState({
    kind: 'pinned',
    deviceName: name,
    originalVolume: sink.volume,
    compensatedDevice: sliderName,
  });
  return state;
}

/**
 * Put the sink back where we found it. Safe to call when nothing is pinned.
 *
 * The compensating move on the slider device is deliberately NOT undone. That
 * device is the one the user's volume slider controls, so by the time Live
 * stops they have very likely been adjusting it — it is theirs now, and its
 * current position is what they have been listening at. Restoring it to our
 * remembered value would be both a surprise and, since the sink is dropping
 * back down at the same moment, a possible jump upward. Leaving it alone can
 * only ever be the quieter choice.
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

/**
 * Device capability detection + the persisted performance profile.
 *
 * Answers one question: how much visual work can THIS machine, driving THIS
 * display, actually do? The renderer uses the answer to pick a quality tier.
 *
 * Why this lives in main: half the useful signals (GPU feature status, thermal
 * state, power source, per-display refresh) only exist here, and the result is
 * a property of the machine rather than of the user, so it belongs in userData
 * next to the updater's skip file — not in the renderer's localStorage, which
 * is where user *preferences* live.
 *
 * See ADAPTIVE_QUALITY_PLAN.md for the full design.
 */

import { app, powerMonitor, screen } from 'electron';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';

const PROFILE_FILE_NAME = 'perf-profile.json';

/** Bump when the shape of the stored profile changes incompatibly. */
const SCHEMA = 1;

export type QualityTier = 'low' | 'balanced' | 'high';

/** Where the current tier came from. Ordered by how much we trust it. */
export type ProfileSource = 'heuristic' | 'measured' | 'user';

/**
 * Why we would offer the system test. Stored on decline so a refusal is
 * remembered per-reason — asking again after an update is fair, asking again
 * tomorrow for the same reason is nagging.
 */
export type TestTrigger = 'first-run' | 'draw-revision' | 'machine-changed' | 'display-changed';

/**
 * `token` scopes the refusal to this *instance* of the reason, not its
 * category. Declining the test for draw revision 3 must not silence it for
 * revision 4 — that's a different question about different code — and
 * declining for one external display must not silence it for the next one.
 * The renderer echoes the token back to `declineTest`.
 */
export type TestPrompt =
  | { kind: 'none' }
  | { kind: 'offer'; trigger: TestTrigger; token: string };

/** Facts the renderer must supply — main has no WebGL context of its own. */
export interface RendererInfo {
  glRenderer: string;
  glVendor: string | null;
  /** From src/visualizers/drawRevision.ts. Invalidates stale measurements. */
  drawRevision: number;
}

export interface DisplayInfo {
  width: number;
  height: number;
  scaleFactor: number;
  refreshHz: number;
  internal: boolean;
}

export interface Capability {
  arch: string;
  cpuModel: string;
  cpuCount: number;
  totalMemGB: number;
  glRenderer: string;
  glVendor: string | null;
  /** False means Chromium is software-rasterising the canvas. Decisive. */
  canvasAccelerated: boolean;
  primary: DisplayInfo;
  displayCount: number;
  /** Backing-store pixels the primary display has to push. */
  pixelsToPush: number;
  /** Live, never part of any key — see recordCalibration. */
  thermalState: string;
  onBattery: boolean;
}

export interface Calibration {
  /** Achieved fps per probe, at the tier the probe ran at. */
  probes: { style: string; tier: QualityTier; fps: number }[];
  ranAt: string;
  durationMs: number;
}

export interface DeviceProfile {
  schema: number;
  drawRevision: number;
  machineKey: string;
  displayKey: string;
  tier: QualityTier;
  source: ProfileSource;
  calibration: Calibration | null;
  declinedTestFor: string[];
  observedAt: string;
}

/** What the renderer actually receives. */
export interface ResolvedDeviceProfile {
  profile: DeviceProfile;
  capability: Capability;
  prompt: TestPrompt;
}

// ── Capability ─────────────────────────────────────────────────────────────

/**
 * `app.getGPUFeatureStatus()` reports `disabled_software` for everything until
 * the first BrowserWindow has finished loading — verified on an M5 that
 * benchmarks at 120 fps: `disabled_software` at `whenReady()`, `enabled`
 * 188 ms later once a window (even a hidden one) had loaded.
 *
 * Reading it too early would classify every machine as having no GPU and pin
 * every user to the lowest tier, silently. The same shape of bug as
 * `app.isPackaged` being permanently false.
 *
 * This is safe only because it is called from an IPC handler — the renderer
 * invoking us is itself proof that a window has loaded.
 */
function isCanvasAccelerated(): boolean {
  try {
    const status = app.getGPUFeatureStatus();
    return (status['2d_canvas'] ?? '').startsWith('enabled');
  } catch {
    // Assume accelerated rather than punishing the user for a failed probe.
    return true;
  }
}

function gatherCapability(info: RendererInfo): Capability {
  const primaryDisplay = screen.getPrimaryDisplay();
  const primary: DisplayInfo = {
    width: primaryDisplay.size.width,
    height: primaryDisplay.size.height,
    scaleFactor: primaryDisplay.scaleFactor,
    // Comes back as 120.0006103515625 on a 120 Hz panel; the fraction is noise.
    refreshHz: Math.round(primaryDisplay.displayFrequency ?? 60),
    internal: primaryDisplay.internal,
  };
  const cpus = os.cpus();
  return {
    arch: process.arch,
    cpuModel: cpus[0]?.model ?? 'unknown',
    cpuCount: cpus.length,
    totalMemGB: Math.round((os.totalmem() / 1e9) * 10) / 10,
    glRenderer: info.glRenderer,
    glVendor: info.glVendor,
    canvasAccelerated: isCanvasAccelerated(),
    primary,
    displayCount: screen.getAllDisplays().length,
    pixelsToPush: Math.round(
      primary.width * primary.scaleFactor * primary.height * primary.scaleFactor,
    ),
    thermalState: safeThermalState(),
    onBattery: safeOnBattery(),
  };
}

function safeThermalState(): string {
  try {
    return powerMonitor.getCurrentThermalState();
  } catch {
    return 'unknown';
  }
}

function safeOnBattery(): boolean {
  try {
    return powerMonitor.isOnBatteryPower();
  } catch {
    return false;
  }
}

// ── Keys ───────────────────────────────────────────────────────────────────
// Deliberately excludes thermal state and power source: those describe the
// afternoon, not the machine. A profile keyed on them would be invalidated
// every time a laptop got warm.

function machineKeyOf(c: Capability): string {
  return [c.arch, c.cpuModel, c.cpuCount, c.totalMemGB, c.glRenderer].join('|');
}

/** Plugging in an external display changes the workload, not the machine. */
function displayKeyOf(c: Capability): string {
  const p = c.primary;
  return `${p.width}x${p.height}@${p.scaleFactor}x|${p.refreshHz}Hz|n${c.displayCount}`;
}

// ── Heuristic tier ─────────────────────────────────────────────────────────

/**
 * The starting guess, used until the system test replaces it (and permanently
 * if the user declines). Deliberately coarse — its only job is to keep the
 * first few seconds from looking bad, and every branch here is a prior that a
 * real measurement should overrule.
 */
export function heuristicTier(c: Capability): QualityTier {
  // Software rasterisation is decisive; nothing else is worth weighing.
  if (!c.canvasAccelerated) return 'low';

  const megapixels = c.pixelsToPush / 1e6;

  // Apple Silicon has headroom for High on any built-in panel. The only
  // Apple-Silicon machines that struggle are the ones driving a 5K/6K display.
  if (c.arch === 'arm64') return megapixels > 12 ? 'balanced' : 'high';

  // Intel means integrated graphics and, by now, a machine several years old.
  // Core count is the best vintage proxy available without a GPU database.
  if (c.cpuCount >= 8 && megapixels <= 8) return 'balanced';
  return 'low';
}

// ── Persistence ────────────────────────────────────────────────────────────

function profilePath(): string {
  // app.getPath() is only valid after `ready`, so resolve lazily.
  return join(app.getPath('userData'), PROFILE_FILE_NAME);
}

function readProfile(): DeviceProfile | null {
  try {
    const parsed = JSON.parse(readFileSync(profilePath(), 'utf-8')) as Partial<DeviceProfile>;
    if (typeof parsed?.machineKey !== 'string' || typeof parsed?.tier !== 'string') return null;
    return parsed as DeviceProfile;
  } catch {
    // Missing or unreadable just means "never profiled".
    return null;
  }
}

function writeProfile(profile: DeviceProfile): void {
  try {
    writeFileSync(profilePath(), JSON.stringify(profile, null, 2), 'utf-8');
  } catch (err) {
    console.warn('[deviceProfile] could not persist profile:', err);
  }
}

// ── Resolution ─────────────────────────────────────────────────────────────

/**
 * Decide why (if at all) we should offer the system test.
 *
 * `drawRevision` is the one that matters most: when the draw path's cost
 * characteristics change, every stored measurement describes code that no
 * longer exists. Without this check the batching work that took radial from
 * 17 fps to 120 would leave every existing user pinned to the tier their old
 * numbers justified, forever, invisibly.
 */
function tokenFor(
  trigger: TestTrigger,
  info: RendererInfo,
  machineKey: string,
  displayKey: string,
): string {
  switch (trigger) {
    case 'draw-revision':
      return `draw-revision:${info.drawRevision}`;
    case 'machine-changed':
      return `machine-changed:${machineKey}`;
    case 'display-changed':
      return `display-changed:${displayKey}`;
    case 'first-run':
      return 'first-run';
  }
}

function promptFor(
  stored: DeviceProfile | null,
  info: RendererInfo,
  machineKey: string,
  displayKey: string,
): TestPrompt {
  const trigger: TestTrigger | null =
    stored === null || stored.schema !== SCHEMA
      ? 'first-run'
      : stored.drawRevision !== info.drawRevision
        ? 'draw-revision'
        : stored.machineKey !== machineKey
          ? 'machine-changed'
          : stored.displayKey !== displayKey
            ? 'display-changed'
            : null;
  if (trigger === null) return { kind: 'none' };
  const token = tokenFor(trigger, info, machineKey, displayKey);
  if (stored?.declinedTestFor?.includes(token)) return { kind: 'none' };
  return { kind: 'offer', trigger, token };
}

export function resolveProfile(info: RendererInfo): ResolvedDeviceProfile {
  const capability = gatherCapability(info);
  const machineKey = machineKeyOf(capability);
  const displayKey = displayKeyOf(capability);
  const stored = readProfile();
  const prompt = promptFor(stored, info, machineKey, displayKey);

  // A stored profile survives only if it describes this machine, this display
  // and this draw code. Anything else and its measurement is about something
  // that isn't true any more.
  const stale =
    stored === null ||
    stored.schema !== SCHEMA ||
    stored.drawRevision !== info.drawRevision ||
    stored.machineKey !== machineKey ||
    stored.displayKey !== displayKey;

  if (!stale && stored !== null) {
    return { profile: stored, capability, prompt };
  }

  // A user-chosen tier is the one thing worth carrying across invalidation:
  // they told us what they wanted, and new hardware facts don't retract that.
  const carriedTier = stored?.source === 'user' ? stored.tier : null;
  const profile: DeviceProfile = {
    schema: SCHEMA,
    drawRevision: info.drawRevision,
    machineKey,
    displayKey,
    tier: carriedTier ?? heuristicTier(capability),
    source: carriedTier ? 'user' : 'heuristic',
    calibration: null,
    // Carried, not cleared: tokens are scoped to the instance they refer to,
    // so an old refusal can't suppress a genuinely new question. Bounded so a
    // user who keeps declining doesn't grow the file without limit.
    declinedTestFor: (stored?.declinedTestFor ?? []).slice(-10),
    observedAt: new Date().toISOString(),
  };
  writeProfile(profile);
  return { profile, capability, prompt };
}

export function setTier(tier: QualityTier): DeviceProfile | null {
  const stored = readProfile();
  if (stored === null) return null;
  const next: DeviceProfile = { ...stored, tier, source: 'user', observedAt: new Date().toISOString() };
  writeProfile(next);
  return next;
}

/** `token` comes straight from the TestPrompt the renderer was handed. */
export function declineTest(token: string): DeviceProfile | null {
  const stored = readProfile();
  if (stored === null) return null;
  const declined = stored.declinedTestFor.includes(token)
    ? stored.declinedTestFor
    : [...stored.declinedTestFor, token].slice(-10);
  const next: DeviceProfile = { ...stored, declinedTestFor: declined };
  writeProfile(next);
  return next;
}

/**
 * Store a completed system test.
 *
 * Refuses to persist a run taken while the machine was thermally throttled —
 * that result measures the afternoon rather than the hardware, and writing it
 * would downgrade the user permanently because one run happened to be hot.
 * The caller still gets the tier for the current session.
 */
export function recordCalibration(
  tier: QualityTier,
  calibration: Calibration,
): { profile: DeviceProfile | null; persisted: boolean } {
  const stored = readProfile();
  if (stored === null) return { profile: null, persisted: false };

  const thermal = safeThermalState();
  if (thermal === 'serious' || thermal === 'critical') {
    return { profile: { ...stored, tier }, persisted: false };
  }

  const next: DeviceProfile = {
    ...stored,
    tier,
    source: 'measured',
    calibration,
    observedAt: new Date().toISOString(),
  };
  writeProfile(next);
  return { profile: next, persisted: true };
}

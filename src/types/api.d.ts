/**
 * Global typing for the IPC bridge exposed by electron/preload.ts.
 */

export interface ElectronApi {
  platform: NodeJS.Platform;
  electronVersion: string;
  /** Static app identity, available synchronously. */
  app: {
    version: string;
    arch: string;
  };
  spotifyAuth: {
    listenForCallback(expectedState: string): Promise<{ code: string }>;
    cancel(): Promise<void>;
  };
  systemAudio: {
    /**
     * Tell main whether the next system-audio capture should silence the
     * captured sources at the speakers (true) or pass them through (false).
     * Call before getDisplayMedia().
     */
    setMute(mute: boolean): Promise<void>;
  };
  /**
   * Output-sink volume pinning. Mirrors SinkVolumeState in
   * electron/deviceVolume.ts — if you change that union, change this too.
   */
  sinkVolume: {
    /** Takes the enumerateDevices() label, not a deviceId. */
    pin(deviceLabel: string): Promise<SinkVolumeState>;
    restore(): Promise<void>;
    getInitialState(): SinkVolumeState;
    onState(handler: (state: SinkVolumeState) => void): () => void;
  };
  shell: {
    openExternal(url: string): Promise<void>;
  };
  /**
   * Starts Spotify hidden (`open -gj -a Spotify`) so there's a Connect device
   * to command. `reason` is `not-installed` when there's no Spotify on the
   * machine, `unsupported` off macOS, `failed` otherwise.
   */
  spotifyApp: {
    launchHidden(): Promise<{ ok: boolean; reason?: string }>;
  };
  /**
   * Menu-bar bridge — see electron/main.ts's tray section. The renderer owns
   * the Spotify session, so it pushes now-playing up for the tray's labels
   * and handles the transport commands the tray sends back.
   */
  tray: {
    setNowPlaying(
      state: { title: string; artist: string; isPlaying: boolean } | null,
    ): void;
    onTransport(handler: (action: TrayTransportAction) => void): () => void;
  };
  /**
   * Notch HUD bridge — see electron/notchWindow.ts. Split across two windows:
   * the main renderer calls `setState` / `onCommand`, the notch panel calls
   * `send` / `onState` / `onExpanded`.
   */
  notch: {
    setState(state: NotchState | null): void;
    onCommand(handler: (cmd: NotchCommand) => void): () => void;
    send(cmd: NotchCommand): void;
    onState(handler: (state: NotchState | null) => void): () => void;
    onExpanded(handler: (expanded: boolean) => void): () => void;
    onMetrics(handler: (metrics: NotchMetrics) => void): () => void;
    getEnabled(): Promise<boolean>;
    setEnabled(enabled: boolean): Promise<boolean>;
    /** Fires when the HUD is toggled from the tray menu. */
    onEnabledChange(handler: (enabled: boolean) => void): () => void;
  };
  /** See electron/deviceProfile.ts. */
  deviceProfile: {
    resolve(info: {
      glRenderer: string;
      glVendor: string | null;
      drawRevision: number;
    }): Promise<ResolvedDeviceProfile>;
    setTier(tier: QualityTier): Promise<DeviceProfile | null>;
    declineTest(token: string): Promise<DeviceProfile | null>;
    recordCalibration(
      tier: QualityTier,
      calibration: Calibration,
    ): Promise<{ profile: DeviceProfile | null; persisted: boolean }>;
  };
  loginItem: {
    get(): Promise<boolean>;
    set(enabled: boolean): Promise<boolean>;
    /** Fires when launch-at-login is toggled from the tray menu. */
    onChange(handler: (enabled: boolean) => void): () => void;
  };
  window: {
    hide(): Promise<void>;
  };
  appEvents: {
    /**
     * Subscribe to the "open preferences" trigger (App menu → Settings… or
     * Cmd+,). Returns an unsubscribe function for cleanup.
     */
    onPreferences(handler: () => void): () => void;
  };
  /**
   * Bridge to electron/updater.ts. State shape mirrors the UpdateState
   * union in main; declared here so renderer code is type-safe end to end.
   */
  update: {
    getInitialState(): UpdateState;
    onState(handler: (state: UpdateState) => void): () => void;
    check(): Promise<void>;
    download(): Promise<void>;
    install(): Promise<void>;
    openFallback(url?: string): Promise<void>;
    dismissVersion(version: string): Promise<void>;
  };
}

export type TrayTransportAction = 'toggle' | 'next' | 'previous';

// ── Notch HUD ──────────────────────────────────────────────────────────────
// Mirrors electron/notchWindow.ts.

export interface NotchLyricLine {
  /** Seconds from track start. */
  time: number;
  text: string;
}

export interface NotchMetrics {
  /** Height of the menu-bar band on the display hosting the HUD, in points. */
  menuBarHeight: number;
}

export interface NotchState {
  title: string;
  artist: string;
  artUrl: string | null;
  /** Hex accent sampled from the album art, or null for the default. Null
   *  whenever "auto-tint from album art" is off. */
  accent: string | null;
  /** Second, cooler album colour for the ambient wash. */
  ambient: string | null;
  isPlaying: boolean;
  progressMs: number;
  durationMs: number;
  shuffle: boolean;
  /** null while the saved-state lookup is still in flight. */
  saved: boolean | null;
  /** Whole synced lyric track, pushed once per song — the notch window does
   *  its own line timing because the main renderer's rAF is frozen whenever
   *  it is occluded, which is exactly when the notch is being looked at. */
  lyrics: NotchLyricLine[] | null;
}

export type NotchCommand =
  /** Clicking the panel itself (not a control) brings the app forward. */
  | { kind: 'activate' }
  | { kind: 'toggle' }
  | { kind: 'next' }
  | { kind: 'previous' }
  | { kind: 'shuffle' }
  | { kind: 'save' }
  | { kind: 'seek'; ms: number };

// ── Device performance profile ─────────────────────────────────────────────
// Mirrors electron/deviceProfile.ts. If you change the shapes there, change
// them here — the preload bridge returns `unknown`, so this file is the only
// thing stopping main and renderer from drifting apart.

export type QualityTier = 'low' | 'balanced' | 'high';

export type ProfileSource = 'heuristic' | 'measured' | 'user';

export type TestTrigger = 'first-run' | 'draw-revision' | 'machine-changed' | 'display-changed';

/** `token` scopes a refusal to this instance of the reason — see deviceProfile.ts. */
export type TestPrompt =
  | { kind: 'none' }
  | { kind: 'offer'; trigger: TestTrigger; token: string };

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
  /** False means Chromium is software-rasterising the canvas. */
  canvasAccelerated: boolean;
  primary: DisplayInfo;
  displayCount: number;
  pixelsToPush: number;
  thermalState: string;
  onBattery: boolean;
}

export interface Calibration {
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

export interface ResolvedDeviceProfile {
  profile: DeviceProfile;
  capability: Capability;
  prompt: TestPrompt;
}

export interface UpdateProgress {
  percent: number;
  bytesPerSecond: number;
  transferred: number;
  total: number;
}

export type UpdateErrorCategory = 'network' | 'install' | 'unknown';

export type UpdateState =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'up-to-date'; checkedAt: number }
  | { kind: 'available'; version: string; releaseNotes?: string; releasePageUrl: string }
  | {
      kind: 'downloading';
      version: string;
      progress: UpdateProgress;
      releasePageUrl: string;
    }
  | { kind: 'downloaded'; version: string; releaseNotes?: string; releasePageUrl: string }
  | {
      kind: 'error';
      message: string;
      category: UpdateErrorCategory;
      canRetry: boolean;
      lastVersionSeen?: string;
      lastReleasePageUrl?: string;
    }
  | {
      kind: 'manual-fallback';
      reason: string;
      version?: string;
      releasePageUrl: string;
    };

/**
 * Mirror of SinkVolumeState in electron/deviceVolume.ts. Both this and the
 * preload bridge have to move together with that union.
 *
 * `already-unity` and `unsupported` are separate from `pinned` on purpose: the
 * UI should only claim it changed something when it actually did, and a device
 * with no volume control at all is a state the user needs to see rather than a
 * silent no-op.
 */
export type SinkVolumeState =
  | { kind: 'idle' }
  | { kind: 'pinned'; deviceName: string; originalVolume: number }
  | { kind: 'already-unity'; deviceName: string }
  | { kind: 'unsupported'; deviceName: string; reason: string }
  | { kind: 'error'; deviceName: string; message: string };

declare global {
  interface Window {
    api: ElectronApi;
  }
}

export {};

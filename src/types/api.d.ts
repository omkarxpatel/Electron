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
   * Reads playlist folders out of the Spotify desktop app's own cache — see
   * electron/spotifyFolders.ts. Mirrors RootlistResult there; change one and
   * change the other.
   *
   * There is no API for this. `GET /me/playlists` is flat and has never
   * carried a folder field, and the internal endpoint that does know about
   * folders answers `403 RBAC: access denied` to third-party tokens. Reading
   * Spotify's on-disk format is the only route, which is why every failure
   * here is a normal result rather than a throw: it is a convenience that
   * seeds local folders once, and the app is fully usable without it.
   */
  spotifyFolders: {
    read(): Promise<RootlistResult>;
  };
  /**
   * Text to speech for the DJ's commentary, rendered to audio rather than
   * spoken. Main runs `say` to a file and hands the bytes back; the renderer
   * plays them through the audio graph.
   *
   * It has to work this way round. Live mode points system output at
   * BlackHole so the app can tap it, and anything spoken to the default
   * device therefore lands in our own capture — where it would be folded
   * into the key, tempo and loudness recorded against whatever track is
   * playing, and would duck itself instead of the music.
   */
  speech: {
    render(text: string, voice?: string): Promise<SpeechResult>;
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
    /** true = restart as soon as it lands; false = apply on next quit. */
    download(installNow: boolean): Promise<void>;
    install(): Promise<void>;
    openFallback(url?: string): Promise<void>;
    dismissVersion(version: string): Promise<void>;
    /** Report whether audio is playing, so a silent update never restarts
     *  the app mid-listen. */
    setActivity(active: boolean): void;
    /** Whether updates install themselves without asking. Owned by main
     *  rather than the renderer's settings blob: the first check runs 8s
     *  after launch, which can be before any window has reported in. */
    getAutoInstall(): Promise<boolean>;
    /** Resolves to the value after the write, so a failed persist snaps the
     *  switch back rather than lying about what will happen. */
    setAutoInstall(on: boolean): Promise<boolean>;
    /** What an unattended install applied since this app last ran, or null.
     *  Deliberately not an UpdateState: by the time it is read the update
     *  already happened, in a process that no longer exists. */
    getJustInstalled(): Promise<JustInstalled | null>;
    /** The user has seen it; stop reporting it. */
    acknowledgeInstalled(): Promise<void>;
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

/** Mirrors JustInstalled in electron/updater.ts. */
export interface JustInstalled {
  version: string;
  /** Raw CHANGELOG section, parsed with parseReleaseNotes. Absent for a
   *  release that published no notes asset. */
  notes?: string;
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
  | {
      /** A newer version exists but the user asked not to be told about it.
       *  Distinct from 'up-to-date' because saying "Up to date" here is a
       *  lie — the update is deferred, not absent. The banner still stays
       *  hidden; only the Settings status tells the truth. */
      kind: 'skipped';
      version: string;
      checkedAt: number;
      releasePageUrl: string;
    }
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

/**
 * Mirror of RootlistNode / RootlistResult in electron/spotifyFolders.ts.
 *
 * `uri` stays a full `spotify:playlist:<id>` rather than a bare id because
 * that is what Spotify's cache stores, and narrowing it here would mean two
 * places to fix if Spotify ever puts something else in a folder.
 *
 * The reasons are distinct so the import button can say which thing is
 * missing. "Spotify isn't installed" and "Spotify is installed but hasn't
 * synced your folders yet" need different advice, and collapsing them into
 * one failure message sends people looking in the wrong place.
 */
/**
 * What `speech.render` answers with. Mirrors SpeechResult in
 * electron/speech.ts; change one and change the other.
 *
 * Every failure is a normal result rather than a throw: commentary is a
 * flourish on a feature that works without it, and the renderer's fallback is
 * to show the sentence instead of speaking it.
 */
export type SpeechResult =
  | { ok: true; wav: Uint8Array }
  | { ok: false; reason: string };

export type RootlistNode =
  | { kind: 'playlist'; uri: string }
  | { kind: 'folder'; id: string; name: string; children: RootlistNode[] };

export type RootlistResult =
  | { kind: 'ok'; nodes: RootlistNode[]; folderCount: number; playlistCount: number }
  | { kind: 'unavailable'; reason: 'no-cache' | 'no-rootlist' | 'unreadable' };

declare global {
  interface Window {
    api: ElectronApi;
  }
}

export {};

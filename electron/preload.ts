import { contextBridge, ipcRenderer } from 'electron';

const api = {
  platform: process.platform,
  electronVersion: process.versions.electron,

  /** Static app identity — populated once at preload time via sync IPC and
   *  exposed as plain values so the renderer doesn't have to await them. */
  app: {
    version: ipcRenderer.sendSync('app:version') as string,
    arch: process.arch,
  },

  spotifyAuth: {
    listenForCallback: (expectedState: string): Promise<{ code: string }> =>
      ipcRenderer.invoke('spotify-auth:listen', expectedState),
    cancel: (): Promise<void> => ipcRenderer.invoke('spotify-auth:cancel'),
  },

  systemAudio: {
    /**
     * Tell the main process whether the NEXT system-audio capture should
     * silence the original sources at the speakers (true) or pass them
     * through unchanged (false). Call this before getDisplayMedia().
     */
    setMute: (mute: boolean): Promise<void> =>
      ipcRenderer.invoke('system-audio:set-mute', mute),
  },

  /**
   * Output-sink volume. The macOS slider only reaches the DEFAULT output
   * device, so once system audio runs through BlackHole the sink we play out
   * of is frozen at whatever level it held — a hard ceiling on our loudness.
   * Main pins it to unity while Live is on and puts it back afterwards.
   *
   * `pin` takes the enumerateDevices() LABEL, not a deviceId: Chromium ids are
   * per-origin salted hashes with no route back to a CoreAudio device.
   *
   * Returns `unknown`; the shape is declared once in src/types/api.d.ts.
   */
  sinkVolume: {
    pin(deviceLabel: string): Promise<unknown> {
      return ipcRenderer.invoke('sink-volume:pin', deviceLabel);
    },
    restore(): Promise<void> {
      return ipcRenderer.invoke('sink-volume:restore');
    },
    getInitialState(): unknown {
      return ipcRenderer.sendSync('sink-volume:get-state');
    },
    onState(handler: (state: unknown) => void): () => void {
      const wrapped = (_e: unknown, state: unknown): void => handler(state);
      ipcRenderer.on('sink-volume:state', wrapped);
      return () => ipcRenderer.off('sink-volume:state', wrapped);
    },
  },

  shell: {
    openExternal: (url: string): Promise<void> => ipcRenderer.invoke('shell:open-external', url),
  },

  /** Start the Spotify desktop client hidden, so there's a Connect device to
   *  command without the user ever seeing Spotify's window. */
  spotifyApp: {
    launchHidden: (): Promise<{ ok: boolean; reason?: string }> =>
      ipcRenderer.invoke('spotify-app:launch-hidden'),
  },

  /**
   * Playlist folders. Spotify's Web API doesn't expose them at all, so main
   * reads the desktop client's local cache instead.
   *
   * Returns `unknown`; the shape is declared once in src/types/api.d.ts.
   */
  spotifyFolders: {
    read: (): Promise<unknown> => ipcRenderer.invoke('spotify-folders:read'),
  },

  /**
   * Text to speech, rendered to a WAV buffer instead of played.
   *
   * The renderer plays it through the audio graph so it reaches the same
   * output device as the music and stays out of every measurement tap — see
   * electron/speech.ts for why speaking it directly would corrupt track
   * memory.
   *
   * Returns `unknown`; the shape is declared once in src/types/api.d.ts.
   */
  speech: {
    render: (text: string, voice?: string): Promise<unknown> =>
      ipcRenderer.invoke('speech:render', text, voice),
  },

  /**
   * Menu-bar bridge. The tray lives in main but has no Spotify session of its
   * own, so the renderer pushes now-playing up and receives transport
   * commands back down. This is what makes the tray work while the window is
   * hidden — the renderer is still alive, just not visible.
   */
  tray: {
    setNowPlaying(
      state: { title: string; artist: string; isPlaying: boolean } | null,
    ): void {
      ipcRenderer.send('tray:now-playing', state);
    },
    onTransport(handler: (action: 'toggle' | 'next' | 'previous') => void): () => void {
      const wrapped = (_e: unknown, action: 'toggle' | 'next' | 'previous'): void =>
        handler(action);
      ipcRenderer.on('app-event:transport', wrapped);
      return () => ipcRenderer.off('app-event:transport', wrapped);
    },
  },

  /** Launch-at-login state. `onChange` fires when the tray's own checkbox is
   *  used, so the Settings toggle doesn't drift out of sync with it. */
  loginItem: {
    get(): Promise<boolean> {
      return ipcRenderer.invoke('login-item:get');
    },
    set(enabled: boolean): Promise<boolean> {
      return ipcRenderer.invoke('login-item:set', enabled);
    },
    onChange(handler: (enabled: boolean) => void): () => void {
      const wrapped = (_e: unknown, enabled: boolean): void => handler(enabled);
      ipcRenderer.on('app-event:login-item', wrapped);
      return () => ipcRenderer.off('app-event:login-item', wrapped);
    },
  },

  window: {
    /** Hide to the menu bar, dropping the dock icon. */
    hide(): Promise<void> {
      return ipcRenderer.invoke('window:hide');
    },
  },

  /**
   * Subscribe to main-process app events:
   *   - 'preferences' fires when the user picks App menu → Settings… or
   *     hits Cmd+, on macOS. The renderer should open the Settings drawer.
   *
   * Returns an unsubscribe function — call it on unmount.
   */
  appEvents: {
    onPreferences(handler: () => void): () => void {
      const wrapped = (): void => handler();
      ipcRenderer.on('app-event:preferences', wrapped);
      return () => ipcRenderer.off('app-event:preferences', wrapped);
    },
  },

  /**
   * Auto-update bridge. The state machine lives in the main process (see
   * electron/updater.ts) — this is the renderer's view into it.
   *
   *   getInitialState() — sync read of the current state, used at mount to
   *     hydrate the UI without a flash before the first push arrives.
   *   onState(handler)  — subscribe to all subsequent state changes.
   *   check / download / install / openFallback / dismissVersion — actions
   *     forwarded to the main-process updater. All async via ipcRenderer.invoke.
   *
   * The state shape matches electron/updater.ts UpdateState. Keeping it
   * unstructured here (returning `unknown`) is intentional — types are
   * declared once in src/types/api.d.ts so renderer and main can't drift.
   */
  update: {
    getInitialState(): unknown {
      return ipcRenderer.sendSync('update:get-state');
    },
    onState(handler: (state: unknown) => void): () => void {
      const wrapped = (_e: unknown, state: unknown): void => handler(state);
      ipcRenderer.on('update:state', wrapped);
      return () => ipcRenderer.off('update:state', wrapped);
    },
    check(): Promise<void> {
      return ipcRenderer.invoke('update:check');
    },
    /** `installNow` true restarts as soon as it lands; false stages it for
     *  the next quit. Always passed explicitly — main no longer remembers an
     *  answer from a previous prompt. */
    download(installNow: boolean): Promise<void> {
      return ipcRenderer.invoke('update:download', installNow);
    },
    install(): Promise<void> {
      return ipcRenderer.invoke('update:install');
    },
    openFallback(url?: string): Promise<void> {
      return ipcRenderer.invoke('update:open-fallback', url);
    },
    dismissVersion(version: string): Promise<void> {
      return ipcRenderer.invoke('update:dismiss-version', version);
    },
    /** Whether audio is currently playing through us. A silent update is
     *  allowed to restart the app when the machine is unattended, and this is
     *  the one thing the main process cannot see for itself — someone
     *  listening via the notch HUD hasn't touched a key in an hour. */
    setActivity(active: boolean): void {
      ipcRenderer.send('update:set-activity', active);
    },
    getAutoInstall(): Promise<boolean> {
      return ipcRenderer.invoke('update:get-auto-install');
    },
    /** Resolves to the value main actually holds after the write, not the one
     *  we asked for, so a preference that failed to persist snaps the switch
     *  back instead of claiming the app will restart itself. */
    setAutoInstall(on: boolean): Promise<boolean> {
      return ipcRenderer.invoke('update:set-auto-install', on);
    },
    getJustInstalled(): Promise<unknown> {
      return ipcRenderer.invoke('update:get-just-installed');
    },
    acknowledgeInstalled(): Promise<void> {
      return ipcRenderer.invoke('update:acknowledge-installed');
    },
  },

  /**
   * Machine capability + the persisted quality tier.
   *
   * `resolve` is called from the renderer on purpose — GPU feature status is
   * wrong until a window has loaded, and this call happening at all proves
   * one has. Returns `unknown`; the shape is declared in src/types/api.d.ts.
   */
  deviceProfile: {
    resolve(info: {
      glRenderer: string;
      glVendor: string | null;
      drawRevision: number;
    }): Promise<unknown> {
      return ipcRenderer.invoke('device-profile:resolve', info);
    },
    setTier(tier: string): Promise<unknown> {
      return ipcRenderer.invoke('device-profile:set-tier', tier);
    },
    declineTest(trigger: string): Promise<unknown> {
      return ipcRenderer.invoke('device-profile:decline-test', trigger);
    },
    recordCalibration(tier: string, calibration: unknown): Promise<unknown> {
      return ipcRenderer.invoke('device-profile:record-calibration', tier, calibration);
    },
  },
  /**
   * Notch HUD bridge. Same shape as `tray` above and for the same reason: the
   * panel is its own window with no Spotify session, so the main renderer
   * pushes state up and takes commands back.
   *
   * `onState` / `onExpanded` are consumed by the notch window; `setState` /
   * `onCommand` by the main one. Both live here because both windows load
   * this one preload.
   */
  notch: {
    setState(state: unknown): void {
      ipcRenderer.send('notch:state', state);
    },
    onCommand(handler: (cmd: unknown) => void): () => void {
      const wrapped = (_e: unknown, cmd: unknown): void => handler(cmd);
      ipcRenderer.on('notch:command', wrapped);
      return () => ipcRenderer.off('notch:command', wrapped);
    },
    send(cmd: unknown): void {
      ipcRenderer.send('notch:command', cmd);
    },
    onState(handler: (state: unknown) => void): () => void {
      const wrapped = (_e: unknown, state: unknown): void => handler(state);
      ipcRenderer.on('notch:state', wrapped);
      return () => ipcRenderer.off('notch:state', wrapped);
    },
    onExpanded(handler: (expanded: boolean) => void): () => void {
      const wrapped = (_e: unknown, v: boolean): void => handler(v);
      ipcRenderer.on('notch:expanded', wrapped);
      return () => ipcRenderer.off('notch:expanded', wrapped);
    },
    onMetrics(handler: (metrics: unknown) => void): () => void {
      const wrapped = (_e: unknown, m: unknown): void => handler(m);
      ipcRenderer.on('notch:metrics', wrapped);
      return () => ipcRenderer.off('notch:metrics', wrapped);
    },
    getEnabled(): Promise<boolean> {
      return ipcRenderer.invoke('notch:get-enabled');
    },
    setEnabled(enabled: boolean): Promise<boolean> {
      return ipcRenderer.invoke('notch:set-enabled', enabled);
    },
    /** Fires when the HUD is toggled from the tray menu, so Settings agrees. */
    onEnabledChange(handler: (enabled: boolean) => void): () => void {
      const wrapped = (_e: unknown, v: boolean): void => handler(v);
      ipcRenderer.on('app-event:notch-enabled', wrapped);
      return () => ipcRenderer.off('app-event:notch-enabled', wrapped);
    },
  },
};

contextBridge.exposeInMainWorld('api', api);

export type AppApi = typeof api;
export {};

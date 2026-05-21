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

  shell: {
    openExternal: (url: string): Promise<void> => ipcRenderer.invoke('shell:open-external', url),
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
    download(): Promise<void> {
      return ipcRenderer.invoke('update:download');
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
  },
};

contextBridge.exposeInMainWorld('api', api);

export type AppApi = typeof api;
export {};

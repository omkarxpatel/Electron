import { contextBridge, ipcRenderer } from 'electron';

const api = {
  platform: process.platform,
  electronVersion: process.versions.electron,

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
};

contextBridge.exposeInMainWorld('api', api);

export type AppApi = typeof api;
export {};

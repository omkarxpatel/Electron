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
  shell: {
    openExternal(url: string): Promise<void>;
  };
  appEvents: {
    /**
     * Subscribe to the "open preferences" trigger (App menu → Settings… or
     * Cmd+,). Returns an unsubscribe function for cleanup.
     */
    onPreferences(handler: () => void): () => void;
  };
}

declare global {
  interface Window {
    api: ElectronApi;
  }
}

export {};

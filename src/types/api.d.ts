/**
 * Global typing for the IPC bridge exposed by electron/preload.ts.
 */

export interface ElectronApi {
  platform: NodeJS.Platform;
  electronVersion: string;
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
}

declare global {
  interface Window {
    api: ElectronApi;
  }
}

export {};

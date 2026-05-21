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

declare global {
  interface Window {
    api: ElectronApi;
  }
}

export {};

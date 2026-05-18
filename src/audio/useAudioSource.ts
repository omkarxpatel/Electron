import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Selects WHERE the audio comes from. Two paths:
 *
 *  - 'system'  — `navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })`
 *                with Electron's `audio: 'loopback'` display-media handler.
 *                Captures whatever the OS is playing, no virtual driver needed.
 *                Requires Screen Recording permission on macOS.
 *
 *  - 'device'  — `navigator.mediaDevices.getUserMedia({ audio: { deviceId } })`.
 *                The traditional path — works with eqMac, BlackHole, or any
 *                physical input (microphone, line-in).
 *
 *  - 'none'    — idle, no stream.
 *
 * This hook is the single source of truth for the `MediaStream` that feeds
 * the downstream audio engine. It manages stream lifecycle (closing the old
 * tracks when switching) and persists the user's last choice.
 */

export type SourceMode = 'none' | 'system' | 'device';

const STORAGE_MODE_KEY = 'av.audioSource.mode';
const STORAGE_DEVICE_KEY = 'av.audioSource.deviceId';

interface State {
  stream: MediaStream | null;
  mode: SourceMode;
  deviceId: string | null;
  error: string | null;
  busy: boolean;
}

export function useAudioSource() {
  const [state, setState] = useState<State>({
    stream: null,
    mode: 'none',
    deviceId: null,
    error: null,
    busy: false,
  });

  // Keep latest stream in a ref so unmount can stop it without effects re-firing.
  const streamRef = useRef<MediaStream | null>(null);
  streamRef.current = state.stream;

  useEffect(() => {
    return () => {
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  /** Tear down the current stream and replace it with a new one.
   *  Track-stop happens in a microtask so the setState updater stays pure —
   *  React 19 StrictMode dev double-invokes updaters and a side effect inside
   *  would call stop() twice. (stop() is idempotent so the previous code
   *  worked in practice, but the pattern is a landmine.) */
  const swap = useCallback((next: MediaStream | null) => {
    setState((s) => {
      const old = s.stream;
      if (old) queueMicrotask(() => old.getTracks().forEach((t) => t.stop()));
      return { ...s, stream: next };
    });
  }, []);

  /**
   * Start (or restart) the system-audio capture.
   *
   * @param mute  When true the OS silences the captured sources at the speakers,
   *              so OUR app's processed playback isn't doubled. Use this when
   *              Live (playthrough) is on. When false, system audio continues
   *              to play normally and we only visualize.
   */
  const useSystemAudio = useCallback(async (mute = false) => {
    setState((s) => ({ ...s, busy: true, error: null }));
    try {
      // Inform main process what kind of loopback we want before issuing the
      // request — the displayMediaRequestHandler reads this flag.
      await window.api.systemAudio.setMute(mute);

      // `video: true` is required for ScreenCaptureKit to deliver audio on macOS.
      // We drop the video track immediately afterward.
      //
      // The explicit `audio` constraints are LOAD-BEARING. With `audio: true`
      // (defaults), Chromium applies AGC + EC + NS to the captured stream AND
      // collapses it to mono — measured ~7.5 dB RMS loss against an explicit
      // all-off request. AGC is meant for microphone capture; on a system-
      // loopback stream it's pure attenuation. With AGC off the stream comes
      // back as stereo naturally, so we don't need to specify channelCount.
      // The device-input path (getUserMedia below) already disables all three.
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });

      const audioTracks = stream.getAudioTracks();
      if (audioTracks.length === 0) {
        stream.getTracks().forEach((t) => t.stop());
        throw new Error(
          'Screen capture returned no audio track. ' +
            'Check System Settings → Privacy & Security → Screen Recording.',
        );
      }

      // Stop + remove the video track. We only consume audio downstream.
      for (const track of stream.getVideoTracks()) {
        track.stop();
        stream.removeTrack(track);
      }

      swap(stream);
      localStorage.setItem(STORAGE_MODE_KEY, 'system');
      setState((s) => ({ ...s, mode: 'system', deviceId: null, busy: false }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setState((s) => ({ ...s, busy: false, error: message }));
    }
  }, [swap]);

  const useDevice = useCallback(
    async (deviceId: string) => {
      setState((s) => ({ ...s, busy: true, error: null }));
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            deviceId: { exact: deviceId },
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
          },
        });
        swap(stream);
        localStorage.setItem(STORAGE_MODE_KEY, 'device');
        localStorage.setItem(STORAGE_DEVICE_KEY, deviceId);
        setState((s) => ({ ...s, mode: 'device', deviceId, busy: false }));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setState((s) => ({ ...s, busy: false, error: message }));
      }
    },
    [swap],
  );

  const disconnect = useCallback(() => {
    swap(null);
    localStorage.setItem(STORAGE_MODE_KEY, 'none');
    setState((s) => ({ ...s, mode: 'none', deviceId: null, error: null }));
  }, [swap]);

  return {
    stream: state.stream,
    mode: state.mode,
    deviceId: state.deviceId,
    error: state.error,
    busy: state.busy,
    useSystemAudio,
    useDevice,
    disconnect,
  };
}

/** Convenience: read the last-used mode without instantiating the hook. */
export function readLastSourceMode(): SourceMode {
  const v = localStorage.getItem(STORAGE_MODE_KEY);
  return v === 'system' || v === 'device' ? (v as SourceMode) : 'none';
}

export function readLastDeviceId(): string | null {
  return localStorage.getItem(STORAGE_DEVICE_KEY);
}

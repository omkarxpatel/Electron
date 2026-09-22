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

/** How long a track may sit `muted` before we treat it as dead. Short
 *  stalls are self-healing and fire `unmute` well inside this window. */
const MUTE_GRACE_MS = 1500;
/** Consecutive auto-recoveries before we stop and hand it back to the user.
 *  Without a cap, a permanently-stalled device would re-acquire on a loop. */
const MAX_RECOVERIES = 3;
/** A track that stays healthy this long has recovered for real, so the
 *  consecutive-attempt counter resets. */
const HEALTHY_RESET_MS = 10_000;

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

  /**
   * Watchdog for an input track that dies in place.
   *
   * After the app sits idle, macOS/Chromium can stop delivering data on a
   * capture track without the device ever leaving `enumerateDevices()`: the
   * track fires `mute`, or `ended` if the capture was torn down outright.
   * Either way the `MediaStream` keeps its object identity, so the graph-build
   * effect in useAudioEngine never re-runs and the UI still reads as connected
   * while producing silence — which is why recovering used to mean re-picking
   * the device by hand.
   *
   * We re-acquire the SAME deviceId rather than re-running the auto-select
   * heuristic, so recovery restores the user's explicit choice instead of
   * quietly moving them to a device they didn't pick.
   *
   * Only 'device' mode recovers. Re-requesting a 'system' capture would pop
   * the macOS Screen Recording dialog, and an unprompted permission dialog is
   * worse than silence.
   *
   * Per spec `track.stop()` does NOT fire `ended`, so our own stream swaps
   * can't trigger a spurious recovery here.
   */
  const recoveriesRef = useRef(0);

  useEffect(() => {
    if (!state.stream || state.mode !== 'device' || !state.deviceId) return;
    const track = state.stream.getAudioTracks()[0];
    if (!track) return;
    const deviceId = state.deviceId;

    let muteTimer: number | null = null;
    let healthyTimer: number | null = null;

    const recover = () => {
      if (muteTimer !== null) window.clearTimeout(muteTimer);
      muteTimer = null;
      if (recoveriesRef.current >= MAX_RECOVERIES) {
        setState((s) => ({
          ...s,
          error:
            'Audio input stopped responding and could not be reconnected. ' +
            'Pick the device again from the source menu.',
        }));
        return;
      }
      recoveriesRef.current += 1;
      void useDevice(deviceId);
    };

    const onEnded = () => recover();
    const onMute = () => {
      if (muteTimer !== null) return;
      muteTimer = window.setTimeout(() => {
        muteTimer = null;
        if (track.muted || track.readyState === 'ended') recover();
      }, MUTE_GRACE_MS);
    };
    const onUnmute = () => {
      if (muteTimer !== null) window.clearTimeout(muteTimer);
      muteTimer = null;
      recoveriesRef.current = 0;
    };

    track.addEventListener('ended', onEnded);
    track.addEventListener('mute', onMute);
    track.addEventListener('unmute', onUnmute);

    if (track.readyState === 'ended') recover();
    else if (track.muted) onMute();
    else {
      healthyTimer = window.setTimeout(() => {
        healthyTimer = null;
        recoveriesRef.current = 0;
      }, HEALTHY_RESET_MS);
    }

    return () => {
      if (muteTimer !== null) window.clearTimeout(muteTimer);
      if (healthyTimer !== null) window.clearTimeout(healthyTimer);
      track.removeEventListener('ended', onEnded);
      track.removeEventListener('mute', onMute);
      track.removeEventListener('unmute', onUnmute);
    };
  }, [state.stream, state.mode, state.deviceId, useDevice]);

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

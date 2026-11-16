import { useCallback, useEffect, useRef, useState } from 'react';
import { isDevicePresent, useDeviceReturn } from './useDeviceReturn';

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

/**
 * Remember the source choice, best effort. `setItem` throws synchronously
 * when the origin's quota is exhausted — also in private mode, and on some
 * disk errors — and the stream is already swapped by the time we get here:
 * the capture runs either way, and all that is lost is it coming back
 * selected next launch.
 *
 * The device id is written BEFORE the mode. If only the first write lands,
 * storage holds the new id under the old mode, which is either already right
 * or simply unread. The other order is the one that bites: mode 'device'
 * beside the previous device's id reconnects the wrong input on next launch.
 */
function remember(mode: SourceMode, deviceId: string | null): void {
  try {
    if (deviceId !== null) localStorage.setItem(STORAGE_DEVICE_KEY, deviceId);
    localStorage.setItem(STORAGE_MODE_KEY, mode);
  } catch (err) {
    console.error('audioSource: persist failed', err);
  }
}

/** How long a track may sit `muted` before we treat it as dead. Short
 *  stalls are self-healing and fire `unmute` well inside this window. */
const MUTE_GRACE_MS = 1500;
/** How long to wait before each re-acquire, by attempt number. The first is
 *  immediate because most stalls clear at once; the rest back off so a device
 *  that is genuinely wedged isn't hammered. */
const RECOVERY_BACKOFF_MS = [0, 1_000, 3_000, 8_000];
/** The steady rate once the backoff is spent. Recovery never gives up now:
 *  three strikes and a "pick the device again" dead end was the single most
 *  irritating thing the app did, and it was reached by failures the user
 *  could do nothing about — macOS stops delivering on a capture track after
 *  the app has sat idle, and the request to re-open it can fail for a few
 *  seconds afterwards while CoreAudio catches up. Waiting is the fix; the
 *  user was being asked to do it by hand. */
const RECOVERY_RETRY_MS = 20_000;
/** A track that stays healthy this long has recovered for real, so the
 *  consecutive-attempt counter resets. */
const HEALTHY_RESET_MS = 10_000;
/** Shown when the input device has left the list, as opposed to one that is
 *  present but not responding. The promise in the second sentence is kept by
 *  useDeviceReturn, which re-acquires the same device when it reappears. */
/** Shown while re-acquiring. It names the manual escape hatch without
 *  demanding it: picking the device again is now a way to skip the wait,
 *  not the only way out. */
const INPUT_RECONNECTING_MESSAGE =
  'Audio input stopped responding — reconnecting. Pick the device again from the source menu to retry now.';
const INPUT_GONE_MESSAGE =
  'The audio input device was disconnected. It will reconnect on its own when the device is back.';

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
      remember('system', null);
      setState((s) => ({ ...s, mode: 'system', deviceId: null, busy: false }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setState((s) => ({ ...s, busy: false, error: message }));
    }
  }, [swap]);

  /** Returns whether the stream was replaced. The watchdog needs to know: a
   *  failed request swaps nothing, so nothing re-runs the effect that would
   *  otherwise notice the track is still dead, and the retry has to come from
   *  the caller instead. */
  const useDevice = useCallback(
    async (deviceId: string): Promise<boolean> => {
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
        remember('device', deviceId);
        setState((s) => ({ ...s, mode: 'device', deviceId, busy: false }));
        return true;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setState((s) => ({ ...s, busy: false, error: message }));
        return false;
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
    let retryTimer: number | null = null;
    let disposed = false;

    /* Keep trying, on a backoff, for as long as this track stays dead.
     *
     * It used to stop after three attempts and tell the user to pick the
     * device again. Two things made that the wrong answer. A failed
     * getUserMedia swaps no stream, so this effect never re-ran and the
     * three attempts were spent in a burst over a couple of seconds —
     * against a device that typically needs longer than that to come back.
     * And the thing it then asked for, picking the same device from the
     * menu, is exactly what this function does: the app had the whole
     * recovery in hand and handed the work over anyway. */
    const schedule = () => {
      if (disposed || retryTimer !== null) return;
      const attempt = recoveriesRef.current;
      recoveriesRef.current = attempt + 1;
      const delay = RECOVERY_BACKOFF_MS[attempt] ?? RECOVERY_RETRY_MS;
      retryTimer = window.setTimeout(() => {
        retryTimer = null;
        void recover();
      }, delay);
    };

    const recover = async () => {
      if (muteTimer !== null) window.clearTimeout(muteTimer);
      muteTimer = null;
      if (disposed) return;
      // A device that has left the list has nothing to reconnect to. This
      // used to try anyway: each attempt was an `exact` getUserMedia that
      // could only reject, it spent the whole recovery budget doing so, and
      // the message it ended on blamed the device for "not responding".
      // Worse, a rejected attempt never swaps the stream, so this effect
      // never re-ran and nothing was left to notice the device coming back.
      // Say what actually happened, stop retrying, and let useDeviceReturn
      // below pick it up when it reappears. `null` (the list couldn't be
      // read) falls through to trying, which is what happened before.
      if ((await isDevicePresent('audioinput', deviceId)) === false) {
        if (disposed) return;
        setState((s) => ({ ...s, error: INPUT_GONE_MESSAGE }));
        return;
      }
      if (disposed) return;

      const swapped = await useDevice(deviceId);
      if (disposed) return;
      // Swapped: this effect re-runs against the new track and takes over,
      // including deciding whether that track is healthy. Nothing to do here,
      // and scheduling a retry as well would run two recoveries at once.
      if (swapped) return;
      // Nothing swapped, so useDevice has just written its own failure into
      // the error slot — "Requested device not found" and the like, which
      // says nothing a user can act on while we are still working on it.
      setState((s) => ({ ...s, error: INPUT_RECONNECTING_MESSAGE }));
      schedule();
    };

    /* Coming back to the app is the one moment worth spending an attempt on
     * out of turn. The stall is usually the machine having parked the audio
     * engine while nobody was looking, so the odds are better now than they
     * were a minute ago — and this is also exactly when someone is looking at
     * the error and waiting for it to clear. */
    const onReturn = () => {
      if (disposed || document.visibilityState !== 'visible') return;
      const current = streamRef.current?.getAudioTracks()[0];
      if (current && current.readyState === 'live' && !current.muted) return;
      if (retryTimer !== null) {
        window.clearTimeout(retryTimer);
        retryTimer = null;
      }
      recoveriesRef.current = 0;
      schedule();
    };

    const onEnded = () => schedule();
    const onMute = () => {
      if (muteTimer !== null) return;
      muteTimer = window.setTimeout(() => {
        muteTimer = null;
        if (track.muted || track.readyState === 'ended') schedule();
      }, MUTE_GRACE_MS);
    };
    const onUnmute = () => {
      if (muteTimer !== null) window.clearTimeout(muteTimer);
      muteTimer = null;
      // The track healed itself before the grace window was out, so the
      // pending attempt would rebuild the graph for nothing.
      if (retryTimer !== null) {
        window.clearTimeout(retryTimer);
        retryTimer = null;
      }
      recoveriesRef.current = 0;
    };

    track.addEventListener('ended', onEnded);
    track.addEventListener('mute', onMute);
    track.addEventListener('unmute', onUnmute);
    window.addEventListener('focus', onReturn);
    document.addEventListener('visibilitychange', onReturn);

    if (track.readyState === 'ended') schedule();
    else if (track.muted) onMute();
    else {
      healthyTimer = window.setTimeout(() => {
        healthyTimer = null;
        recoveriesRef.current = 0;
      }, HEALTHY_RESET_MS);
    }

    return () => {
      disposed = true;
      if (muteTimer !== null) window.clearTimeout(muteTimer);
      if (healthyTimer !== null) window.clearTimeout(healthyTimer);
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      track.removeEventListener('ended', onEnded);
      track.removeEventListener('mute', onMute);
      track.removeEventListener('unmute', onUnmute);
      window.removeEventListener('focus', onReturn);
      document.removeEventListener('visibilitychange', onReturn);
    };
  }, [state.stream, state.mode, state.deviceId, useDevice]);

  /* The other half of the watchdog: the device leaving and coming back.
   *
   * Watched as long as a device is the chosen source, including while its
   * stream is dead — recovery deliberately leaves `state.deviceId` on the
   * user's choice rather than clearing it, which is what makes this able to
   * find it again. Re-acquired only if the track really is dead: a Bluetooth
   * blip can drop a device from the list and re-add it while capture carries
   * on, and re-acquiring a live input rebuilds the whole graph for nothing.
   * The budget starts fresh because the device genuinely came back; failures
   * against the version of it that left say nothing about this one. */
  const sourceDeviceId = state.mode === 'device' ? state.deviceId : null;
  useDeviceReturn('audioinput', sourceDeviceId, () => {
    if (!sourceDeviceId) return;
    const track = streamRef.current?.getAudioTracks()[0];
    if (track && track.readyState === 'live' && !track.muted) return;
    recoveriesRef.current = 0;
    void useDevice(sourceDeviceId);
  });

  const disconnect = useCallback(() => {
    swap(null);
    remember('none', null);
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

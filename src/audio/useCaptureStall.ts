import { useEffect, useRef } from 'react';
import { isDevicePresent } from './useDeviceReturn';

/**
 * Re-acquires the input when a device change leaves the capture alive but
 * silent.
 *
 * The watchdog in `useAudioSource` recovers a track that SAYS it is broken:
 * `ended`, or `mute` held past a grace window. A capture can also wedge
 * without saying anything — `readyState` stays `'live'`, `muted` stays false,
 * and it delivers digital silence from then on. Taking earbuds out and
 * putting them back a few minutes later does this to a BlackHole capture that
 * was never touched: BlackHole never left `enumerateDevices()`, so
 * `useDeviceReturn` has no absent→present transition to react to, and the
 * track fires no event for anyone else to catch. The app reads as connected,
 * the visualizer sits flat, and the only way out was picking the same device
 * from the source menu by hand — which is all this does instead.
 *
 * Two conditions, and both are load-bearing. It runs only after a
 * `devicechange`, because polling for silence would rebuild the graph every
 * time the music was paused. And it acts only while the capture reads EXACT
 * zeros, because re-acquiring on every devicechange would rebuild the whole
 * graph whenever someone plugged in an unrelated mic. Gating on silence is
 * also what makes a false positive cheap: a rebuild that happens while
 * nothing is coming through cannot interrupt anything audible.
 *
 * A device that has genuinely left is NOT this hook's business — that is
 * `useDeviceReturn`, which re-acquires it when it comes back.
 */

/** What this needs of an `AnalyserNode`. Declared structurally so the check
 *  script can drive the watchdog with a plain object: nothing it mounts
 *  creates an `AudioContext`, and it must stay that way to be safe to run
 *  while someone is listening. */
export interface SilenceProbe {
  readonly fftSize: number;
  getFloatTimeDomainData(data: Float32Array): void;
}

interface Params {
  /** Reads the capture. `null` (no graph yet) means silence can't be proven,
   *  so nothing fires. */
  probe: SilenceProbe | null;
  stream: MediaStream | null;
  /** The chosen input, or `null` when the source isn't a device. */
  deviceId: string | null;
  reacquire: (deviceId: string) => void;
}

/** How long after the last `devicechange` to start probing. A Bluetooth
 *  reconnect sends a burst of them, and a capture that is going to come back
 *  on its own does it well inside this. */
const SETTLE_MS = 1200;
/** Spacing and count of the samples that must all be silent. One second of
 *  true digital zeros, straight after a device event, is not something a
 *  working capture produces. */
const PROBE_INTERVAL_MS = 250;
const PROBE_SAMPLES = 4;

export function useCaptureStall({ probe, stream, deviceId, reacquire }: Params): void {
  // Latest of each without re-subscribing: the listener is scoped to the
  // stream and the device, not to whichever closure rendered last.
  const probeRef = useRef(probe);
  probeRef.current = probe;
  const reacquireRef = useRef(reacquire);
  reacquireRef.current = reacquire;

  useEffect(() => {
    if (!stream || !deviceId) return;
    const track = stream.getAudioTracks()[0];
    if (!track) return;
    const md = navigator.mediaDevices;
    if (!md?.addEventListener) return;

    let disposed = false;
    let settleTimer: number | null = null;
    let probeTimer: number | null = null;
    let quiet = 0;
    let buffer: Float32Array | null = null;

    const stopProbe = () => {
      if (probeTimer !== null) window.clearInterval(probeTimer);
      probeTimer = null;
      quiet = 0;
    };

    const isSilent = (): boolean => {
      const p = probeRef.current;
      if (!p) return false;
      if (!buffer || buffer.length !== p.fftSize) buffer = new Float32Array(p.fftSize);
      p.getFloatTimeDomainData(buffer);
      for (let i = 0; i < buffer.length; i += 1) if (buffer[i] !== 0) return false;
      return true;
    };

    const reacquireIfPresent = async () => {
      // A device that has left the list has nothing to re-open, and an
      // `exact` request for it could only reject. useDeviceReturn is already
      // watching for it to come back.
      if ((await isDevicePresent('audioinput', deviceId)) === false) return;
      if (disposed) return;
      reacquireRef.current(deviceId);
    };

    const sample = () => {
      if (disposed) return;
      // A track that admits it is broken belongs to the other watchdog, which
      // has the backoff and the retry. Two recoveries at once would open the
      // device twice.
      if (track.readyState !== 'live' || track.muted) {
        stopProbe();
        return;
      }
      if (!isSilent()) {
        stopProbe();
        return;
      }
      quiet += 1;
      if (quiet < PROBE_SAMPLES) return;
      stopProbe();
      void reacquireIfPresent();
    };

    const onDeviceChange = () => {
      if (settleTimer !== null) window.clearTimeout(settleTimer);
      stopProbe();
      settleTimer = window.setTimeout(() => {
        settleTimer = null;
        probeTimer = window.setInterval(sample, PROBE_INTERVAL_MS);
      }, SETTLE_MS);
    };

    md.addEventListener('devicechange', onDeviceChange);
    return () => {
      disposed = true;
      if (settleTimer !== null) window.clearTimeout(settleTimer);
      stopProbe();
      md.removeEventListener('devicechange', onDeviceChange);
    };
  }, [stream, deviceId]);
}

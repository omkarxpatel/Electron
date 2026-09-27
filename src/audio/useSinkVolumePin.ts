import { useEffect, useState } from 'react';
import type { SinkVolumeState } from '../types/api';

/**
 * Holds the output device at unity while Live is on.
 *
 * Why this is needed at all: the macOS volume slider only ever addresses the
 * DEFAULT output device. Once the user points system output at BlackHole so we
 * can tap it, the device we play out of via `setSinkId` is no longer the
 * default, so nothing can reach its volume — it stays frozen wherever it was
 * when they switched away, and that becomes a hard ceiling on our loudness.
 * The slider spans ~64 dB on built-in speakers and ~100 dB on Bluetooth, so a
 * sink left at 20% is 50-80 dB down.
 *
 * The work happens in electron/deviceVolume.ts; this hook only decides WHEN,
 * and resolves the device label that main needs.
 */
export function useSinkVolumePin(
  outputDeviceId: string | null,
  active: boolean,
): SinkVolumeState {
  const [state, setState] = useState<SinkVolumeState>(() =>
    window.api.sinkVolume.getInitialState(),
  );

  useEffect(() => window.api.sinkVolume.onState(setState), []);

  useEffect(() => {
    // No explicit sink means playback goes to the AudioContext default, which
    // is the default output device — BlackHole, the thing we're tapping. There
    // is nothing meaningful to pin in that case.
    if (!active || !outputDeviceId) return;

    let cancelled = false;
    void (async () => {
      // Main matches on the device NAME because Chromium deviceIds are
      // per-origin salted hashes with no route back to a CoreAudio device.
      // Labels are only populated once microphone permission is granted,
      // which by this point it is — we're holding a capture stream.
      const devices = await navigator.mediaDevices.enumerateDevices();
      const match = devices.find(
        (d) => d.kind === 'audiooutput' && d.deviceId === outputDeviceId,
      );
      if (cancelled || !match?.label) return;
      await window.api.sinkVolume.pin(match.label);
    })();

    return () => {
      cancelled = true;
      // Runs when Live stops, the sink changes, or the window unmounts. Main
      // serialises this against the re-pin that a sink change triggers.
      void window.api.sinkVolume.restore();
    };
  }, [outputDeviceId, active]);

  return state;
}

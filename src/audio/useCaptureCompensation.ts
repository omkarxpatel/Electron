import { useEffect, useState } from 'react';
import type { CaptureVolumeState } from '../types/api';
import type { SourceMode } from './useAudioSource';

/** The most the measuring side will add back, in dB. BlackHole's slider spans
 *  64 dB, so this covers it end to end. A reading past that is not a volume
 *  anyone is listening at. */
const MAX_CAPTURE_COMPENSATION_DB = 64;

/**
 * How many dB the macOS volume slider has taken off the input we record, to
 * be added back on the measuring side. 0 when there is nothing honest to add.
 *
 * Why: system output runs through BlackHole so we can capture it, and the
 * slider attenuates BlackHole before we hear a sample. At 50% that is 32 dB,
 * so the visuals shrank with the volume and the loudness tap measured the
 * slider instead of the track.
 *
 * The work happens in electron/captureVolume.ts; this hook only decides WHEN,
 * and resolves the device label main needs, the same split as
 * useSinkVolumePin.
 */
export function useCaptureCompensation(
  mode: SourceMode,
  deviceId: string | null,
  capturing: boolean,
): number {
  const [state, setState] = useState<CaptureVolumeState>({ kind: 'idle' });

  useEffect(() => window.api.captureVolume.onState(setState), []);

  useEffect(() => {
    // Only a device input can be a loopback. System Audio is captured from
    // the apps themselves, ahead of any device's volume, so there is nothing
    // to add back.
    if (mode !== 'device' || !deviceId || !capturing) return;

    let cancelled = false;
    void (async () => {
      // Main matches on the device NAME, because Chromium deviceIds are
      // per-origin salted hashes with no route back to a CoreAudio device.
      const devices = await navigator.mediaDevices.enumerateDevices();
      const match = devices.find((d) => d.kind === 'audioinput' && d.deviceId === deviceId);
      if (cancelled || !match?.label) return;
      await window.api.captureVolume.watch(match.label);
    })().catch(() => {
      // No helper to answer, as in the capture harness: nothing to add back.
    });

    return () => {
      cancelled = true;
      setState({ kind: 'idle' });
      void window.api.captureVolume.watch(null).catch(() => {});
    };
  }, [mode, deviceId, capturing]);

  return state.kind === 'tracking'
    ? Math.min(MAX_CAPTURE_COMPENSATION_DB, Math.max(0, -state.db))
    : 0;
}

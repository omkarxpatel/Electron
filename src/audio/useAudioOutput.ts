import { useCallback, useEffect, useState } from 'react';
import { isVirtualSink } from './deviceLabel';

/**
 * Output device selection for the AudioContext destination. Independent of
 * the input source — chooses WHERE processed audio plays.
 *
 * Required when system output is routed to a virtual device like BlackHole
 * (so we can capture it on the input side), because the AudioContext's
 * default sink would otherwise also be BlackHole → feedback loop. The user
 * picks a real device here (speakers, headphones) and `setSinkId()` routes
 * our processed playback there directly.
 *
 * `null` means "use the AudioContext default sink at the time of creation".
 */

const STORAGE_OUTPUT_KEY = 'av.audioOutput.deviceId';
const MIGRATION_KEY = 'av.audioOutput.migration.v1';

export function useAudioOutput() {
  const [outputDeviceId, setState] = useState<string | null>(() => {
    return localStorage.getItem(STORAGE_OUTPUT_KEY);
  });

  const setOutputDevice = useCallback((id: string | null) => {
    setState(id);
    if (id === null) localStorage.removeItem(STORAGE_OUTPUT_KEY);
    else localStorage.setItem(STORAGE_OUTPUT_KEY, id);
  }, []);

  /**
   * One-time migration. Earlier versions of the app could persist a virtual
   * driver (Microsoft Teams Audio Device, Krisp, etc.) as the output device
   * — the auto-select filter wasn't yet tight enough to exclude them. If a
   * user upgrades into a version of the app with the tighter filter, their
   * persisted choice would survive and they'd still be sending output to a
   * silent virtual sink. This effect detects that case and clears the
   * persisted value once, allowing useAutoSelectDevices to pick a real
   * device on this launch.
   *
   * Idempotent via the MIGRATION_KEY flag; we only set the flag once we've
   * actually been able to read device labels (which requires microphone
   * permission). If labels aren't available, we leave the flag unset and
   * retry on a future launch.
   */
  useEffect(() => {
    if (localStorage.getItem(MIGRATION_KEY) === 'done') return;
    const persistedId = localStorage.getItem(STORAGE_OUTPUT_KEY);
    if (!persistedId) {
      // Nothing to migrate. Mark done so we don't keep enumerating devices
      // on every cold launch for users who never picked anything.
      localStorage.setItem(MIGRATION_KEY, 'done');
      return;
    }
    let cancelled = false;
    void navigator.mediaDevices
      .enumerateDevices()
      .then((devices) => {
        if (cancelled) return;
        const hasLabels = devices.some((d) => !!d.label);
        // Without labels (permission not granted yet) we can't tell whether
        // the persisted device is virtual. Bail without setting the flag so
        // the migration retries next launch.
        if (!hasLabels) return;
        const match = devices.find(
          (d) => d.kind === 'audiooutput' && d.deviceId === persistedId,
        );
        if (match && isVirtualSink(match.label)) {
          localStorage.removeItem(STORAGE_OUTPUT_KEY);
          setState(null);
        }
        // Whether or not we cleared, we've successfully checked — mark done.
        localStorage.setItem(MIGRATION_KEY, 'done');
      })
      .catch(() => {
        // enumerateDevices can throw if the API is unavailable; leave the
        // flag unset so we retry on next launch.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return { outputDeviceId, setOutputDevice };
}

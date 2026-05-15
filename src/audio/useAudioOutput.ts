import { useCallback, useState } from 'react';

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

export function useAudioOutput() {
  const [outputDeviceId, setState] = useState<string | null>(() => {
    return localStorage.getItem(STORAGE_OUTPUT_KEY);
  });

  const setOutputDevice = useCallback((id: string | null) => {
    setState(id);
    if (id === null) localStorage.removeItem(STORAGE_OUTPUT_KEY);
    else localStorage.setItem(STORAGE_OUTPUT_KEY, id);
  }, []);

  return { outputDeviceId, setOutputDevice };
}

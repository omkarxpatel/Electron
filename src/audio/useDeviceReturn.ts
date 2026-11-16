import { useEffect, useRef } from 'react';

/**
 * Whether a device is in the list right now: `true`/`false`, or `null` when
 * the list could not be read. Callers treat `null` as "assume it's there", so
 * a failed enumeration never stops a recovery that would have worked.
 */
export async function isDevicePresent(
  kind: MediaDeviceKind,
  deviceId: string,
): Promise<boolean | null> {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.some((d) => d.kind === kind && d.deviceId === deviceId);
  } catch {
    return null;
  }
}

/**
 * Calls `onReturn` when a device that had gone missing is back in the list.
 *
 * Both ends of the audio path pin an explicit device — the input by
 * `getUserMedia({ deviceId: { exact } })`, the output by `setSinkId` — and
 * neither noticed that device leaving and coming back. AirPods reconnecting,
 * headphones replugged, the BlackHole driver reloading: the selection stayed
 * pointed at the device, the device came back, and nothing used it again. The
 * only way out was picking it by hand. `devicechange` was already firing; it
 * just had nobody listening for this.
 *
 * What it reacts to is the TRANSITION, absent to present, and nothing else.
 * `devicechange` fires for every device on the machine, and acting on every
 * one would be wrong at both ends: re-applying an output with `setSinkId` on
 * a healthy context is an audible glitch, and re-acquiring an input rebuilds
 * the whole graph. Plugging in an unrelated mic must do nothing.
 *
 * "Absent when we started, present later" counts as a return: launching with
 * the AirPods still in their case, then taking them out, is the same symptom.
 * "Not listed yet" does not — presence is unknown until the first listing.
 *
 * It returns the device the user CHOSE, never a substitute. Falling back to a
 * best guess when it vanishes would move someone to a device they didn't pick,
 * which is the one thing recovery in this app is written not to do.
 */
export function useDeviceReturn(
  kind: MediaDeviceKind,
  deviceId: string | null,
  onReturn: () => void,
): void {
  // Latest callback, without re-subscribing: the listener is scoped to the
  // device, not to whichever closure rendered last.
  const onReturnRef = useRef(onReturn);
  onReturnRef.current = onReturn;

  useEffect(() => {
    if (!deviceId) return;
    const md = navigator.mediaDevices;
    if (!md?.enumerateDevices || !md.addEventListener) return;

    let disposed = false;
    /** Only the newest listing is acted on. Two `devicechange` events close
     *  together — a Bluetooth reconnect often sends several — each start an
     *  enumeration, and if both were allowed to compare against "was absent"
     *  they would both fire. */
    let latest = 0;
    /** `null` until the first listing lands; see the header. */
    let present: boolean | null = null;

    const check = async (): Promise<void> => {
      const mine = ++latest;
      const now = await isDevicePresent(kind, deviceId);
      if (disposed || mine !== latest || now === null) return;
      const returned = present === false && now;
      present = now;
      if (returned) onReturnRef.current();
    };

    void check();
    md.addEventListener('devicechange', check);
    return () => {
      disposed = true;
      md.removeEventListener('devicechange', check);
    };
  }, [kind, deviceId]);
}

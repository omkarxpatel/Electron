/**
 * Stops the input and the output being the same piece of hardware, which is
 * a feedback loop with the gain turned up.
 *
 * Two shapes of it, and `groupId` catches both — Chromium assigns one group
 * per physical device, so an input and an output that share a group are two
 * ends of the same thing:
 *
 *   BlackHole 2ch in + BlackHole 2ch out   digital. Our own output is
 *                                          re-captured, so it compounds every
 *                                          pass and runs away in well under a
 *                                          second.
 *   MacBook Pro Microphone + MacBook Pro   acoustic. Different CoreAudio
 *   Speakers                               devices, but one built-in codec and
 *                                          so one group — the mic hears the
 *                                          speakers and howls.
 *
 * `deviceId` cannot do this job, in both directions. The built-in mic and
 * speakers carry different ids, so it would miss the acoustic loop; and every
 * kind has its own entry under the literal id `default`, so the default input
 * and the default output compare equal even when they are unrelated devices.
 *
 * Measured on this machine (`enumerateDevices()` with permission granted):
 *
 *   audioinput   group b517d2e4  id default   Default - MacBook Pro Microphone
 *   audioinput   group d9794762  id caf34135  BlackHole 2ch (Virtual)
 *   audioinput   group b517d2e4  id fe170226  MacBook Pro Microphone (Built-in)
 *   audiooutput  group d9794762  id default   Default - BlackHole 2ch (Virtual)
 *   audiooutput  group d9794762  id caf34135  BlackHole 2ch (Virtual)
 *   audiooutput  group b517d2e4  id 4eebf8e4  MacBook Pro Speakers (Built-in)
 */

/**
 * The physical device a selection resolves to, or `null` when there isn't one
 * to compare against.
 *
 * `null` in, `null` out: nothing is selected, so nothing can collide. The
 * "System default" rows are NOT that case — they route to a real device, and
 * callers pass the literal id `default` to resolve them.
 *
 * An empty `groupId` also reads as `null`. Without microphone permission
 * Chromium blanks the group along with the label, and treating `''` as a value
 * would match every blank device to every other and disable the whole menu.
 */
export function resolveGroupId(
  devices: MediaDeviceInfo[],
  kind: MediaDeviceKind,
  deviceId: string | null,
): string | null {
  if (deviceId === null) return null;
  const match = devices.find((d) => d.kind === kind && d.deviceId === deviceId);
  return match?.groupId || null;
}

/** Whether two resolved groups are the same device — i.e. picking the one
 *  would close the loop against the other. Blank groups never match, for the
 *  no-permission reason above. */
export function isSameDevice(groupId: string | null, otherGroupId: string | null): boolean {
  return !!groupId && groupId === otherGroupId;
}

/** Shown on every row the rule refuses, in both menus. The note is short
 *  enough to sit on the row; the reason goes in the `title`. */
export const FEEDBACK_NOTE = 'same device';
export const FEEDBACK_REASON =
  'The input and the output would be the same device, which feeds the output ' +
  'straight back into the input and howls.';

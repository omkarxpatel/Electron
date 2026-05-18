/** Format a millisecond duration as `m:ss`. Negatives clamp to 0, so a
 *  briefly-negative progress value from a poll race doesn't render as
 *  `-1:59`. Used by every track row + scrubber in the UI. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

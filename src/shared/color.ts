/** Convert a `#rrggbb` hex string to an `rgba(r, g, b, a)` CSS color. Falls
 *  back to the Spotify-green default if the input doesn't match the expected
 *  format — better to render a usable accent than to crash. */
export function hexToRgba(hex: string, alpha: number): string {
  if (!hex.startsWith('#') || hex.length !== 7) return `rgba(29, 215, 96, ${alpha})`;
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

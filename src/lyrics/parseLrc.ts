/**
 * LRC (synced-lyrics) format parser.
 *
 *   [mm:ss]      text          (whole-second precision)
 *   [mm:ss.xx]   text          (centisecond precision)
 *   [mm:ss.xxx]  text          (millisecond precision)
 *
 * Multiple timestamps per line are legal in the spec but rare; we don't
 * bother supporting them here. Bracketed metadata lines (`[ar:...]`,
 * `[ti:...]`, `[length:...]`, etc.) are silently skipped since they don't
 * match the timestamp regex.
 */

export interface LyricLine {
  /** Time in seconds from track start. */
  time: number;
  text: string;
}

const TIMESTAMP_RE = /\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/;

export function parseLrc(lrc: string): LyricLine[] {
  const result: LyricLine[] = [];
  const lines = lrc.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const m = TIMESTAMP_RE.exec(line);
    if (!m || m.index !== 0) continue;
    const min = parseInt(m[1], 10);
    const sec = parseInt(m[2], 10);
    const fracStr = m[3] ?? '0';
    // Pad to 3 digits so "[1:23.5]" → 0.5, "[1:23.55]" → 0.55, "[1:23.555]" → 0.555.
    const frac = parseInt(fracStr.padEnd(3, '0'), 10) / 1000;
    const time = min * 60 + sec + frac;
    const text = line.slice(m[0].length).trim();
    if (text) result.push({ time, text });
  }
  return result.sort((a, b) => a.time - b.time);
}

/**
 * Binary-search the index of the latest line whose timestamp is ≤ elapsedSec.
 * Returns -1 if we're still before the first line.
 */
export function findCurrentLineIndex(lines: LyricLine[], elapsedSec: number): number {
  if (lines.length === 0) return -1;
  if (elapsedSec < lines[0].time) return -1;
  let lo = 0;
  let hi = lines.length - 1;
  let idx = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].time <= elapsedSec) {
      idx = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return idx;
}

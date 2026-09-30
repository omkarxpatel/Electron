/**
 * Per-track spectral memory.
 *
 * Spotify withdrew `audio-features` in November 2024 and has not replaced it,
 * so there is no longer any way to ask what a track's tempo, key or energy is.
 * But this app hears every track it plays, already measures its spectrum to
 * build the EQ correction, and knows the Spotify id of what is playing. So the
 * measurements can just be kept: play a track once and we know what it sounds
 * like, for good.
 *
 * Two things that buys immediately:
 *
 *   - AI Enhance stops taking 20 s to settle on a track it has heard before.
 *     Steady mode averages the spectrum over 20 s because that is what a
 *     long-term average spectrum IS, but the wait is only needed the FIRST
 *     time. A recalled shape is correct from the downbeat.
 *
 *   - Nothing carries across a track boundary. Without track awareness the
 *     20 s window straddles the change, so the first third of every track is
 *     corrected using the previous track's balance.
 *
 * Only the SHAPE is stored, never the level. Absolute dBFS at the pre-EQ tap
 * moves with the input gain and the EQ's own headroom trim, so it is not
 * comparable between sessions — the shape is.
 *
 * No imports, on purpose: `scripts/check-enhancer.mjs` compiles this file
 * standalone and runs it under plain node. Keep it that way or it drops out
 * of the only gate this repo has.
 */

/** Band count the enhancer reasons in — matches ISO_10 in enhanceProfiles. */
export const PROFILE_BANDS = 10;

/** In-memory profile. Readable field names; see StoredProfile for what
 *  actually reaches the disk. */
export interface TrackProfile {
  /** Mean-zero band levels in dB, length PROFILE_BANDS. Shape, not level. */
  shape10: number[];
  /** Seconds of signal folded in across every play. The confidence weight. */
  seconds: number;
  /** ms epoch of the last fold. Drives eviction when the store is full. */
  updated: number;
  /** BS.1770 integrated loudness of the track as delivered, or null if it
   *  was never measured (profiles written before the meter existed, or a
   *  play too quiet to pass the gates). Unlike the shape this IS a level —
   *  it is measured upstream of everything the app does, so it describes the
   *  track rather than our processing, and is comparable between sessions. */
  lufs: number | null;
}

/**
 * How much prior measurement a new play is weighed against.
 *
 * Without a cap the profile would freeze after a few plays, and a track
 * re-mastered or re-encoded by the source would never be re-learned. Ten
 * minutes of prior is enough that one noisy play can't move the shape much,
 * and little enough that three or four plays of a changed track will.
 */
export const MAX_PRIOR_SECONDS = 600;

/**
 * Least signal we will commit. Below this the average is dominated by the
 * intro rather than the track, and storing it would poison the recall for
 * every later play. A skipped track measures nothing.
 */
export const MIN_COMMIT_SECONDS = 20;

/** Subtract the mean so a curve carries shape only, no level. */
export function meanZero(bands: number[]): number[] {
  let sum = 0;
  for (const v of bands) sum += v;
  const mean = sum / bands.length;
  return bands.map((v) => v - mean);
}

/**
 * Fold a finished measurement into what we already knew about a track.
 *
 * A running weighted mean by measured seconds, with the prior capped. Passing
 * `prev` as null is the first play.
 */
export function foldMeasurement(
  prev: TrackProfile | null,
  bands10: number[],
  seconds: number,
  now: number,
  lufs: number | null = null,
): TrackProfile {
  const shape = meanZero(bands10);
  const clean = lufs !== null && Number.isFinite(lufs) ? lufs : null;
  if (!prev) {
    return { shape10: shape, seconds, updated: now, lufs: clean };
  }
  const priorWeight = Math.min(prev.seconds, MAX_PRIOR_SECONDS);
  const total = priorWeight + seconds;
  const merged = shape.map(
    (v, i) => (prev.shape10[i] * priorWeight + v * seconds) / total,
  );
  return {
    // meanZero again: the weighted average of two mean-zero curves is itself
    // mean-zero only up to rounding, and this value is persisted and re-folded
    // on every play, so the drift would compound rather than wash out.
    shape10: meanZero(merged),
    seconds: prev.seconds + seconds,
    updated: now,
    // Averaged in the same proportion as the shape. A partial play measures
    // a real but unrepresentative slice of the track, so one is not allowed
    // to redefine a figure several full plays agreed on.
    lufs:
      clean === null
        ? prev.lufs
        : prev.lufs === null
          ? clean
          : (prev.lufs * priorWeight + clean * seconds) / total,
  };
}

/* ── Storage format ──────────────────────────────────────────────────────
 *
 * This is written for every track the user plays and read in full at
 * startup, so it is kept deliberately terse. The readable form costs about
 * 50% more for no benefit: one-character keys, the shape at 0.1 dB (two
 * orders of magnitude below anything audible, and the sliders themselves
 * move in 0.5 dB steps), whole seconds, and the timestamp in minutes rather
 * than milliseconds because it is only ever used to sort for eviction.
 *
 * Measured by check:enhancer rather than estimated — see the size budget
 * assertion there.
 */

interface StoredProfile {
  /** shape10, at 0.1 dB. */
  s: number[];
  /** seconds, whole. */
  n: number;
  /** updated, in minutes since the epoch. */
  u: number;
  /** lufs, at 0.1 LU. Omitted entirely when unmeasured, rather than stored
   *  as null — it costs nothing to leave out and most of the store predates
   *  the meter. */
  l?: number;
}

const MS_PER_MINUTE = 60_000;

export function encodeProfile(p: TrackProfile): StoredProfile {
  const out: StoredProfile = {
    s: p.shape10.map((v) => Math.round(v * 10) / 10),
    n: Math.max(1, Math.round(p.seconds)),
    u: Math.round(p.updated / MS_PER_MINUTE),
  };
  if (p.lufs !== null && Number.isFinite(p.lufs)) out.l = Math.round(p.lufs * 10) / 10;
  return out;
}

/**
 * Validate and widen one stored entry. Returns null for anything malformed.
 *
 * This is the only door stored data comes through. localStorage survives
 * downgrades and hand-editing, and a bad shape would be seeded straight into
 * the EQ — so a partial or NaN-bearing entry is dropped, not repaired.
 */
export function decodeProfile(value: unknown): TrackProfile | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Partial<StoredProfile>;
  if (!Array.isArray(v.s) || v.s.length !== PROFILE_BANDS) return null;
  if (!v.s.every((n) => typeof n === 'number' && Number.isFinite(n))) return null;
  if (typeof v.n !== 'number' || !Number.isFinite(v.n) || v.n <= 0) return null;
  if (typeof v.u !== 'number' || !Number.isFinite(v.u) || v.u < 0) return null;
  const lufs = typeof v.l === 'number' && Number.isFinite(v.l) ? v.l : null;
  return { shape10: v.s.slice(), seconds: v.n, updated: v.u * MS_PER_MINUTE, lufs };
}

/**
 * Drop the least recently used entries until `max` remain.
 *
 * Returns a new record; the input is untouched. Eviction is by `updated`
 * rather than insertion order because the point is to keep what is actually
 * being listened to.
 */
export function evictOldest(
  store: Record<string, TrackProfile>,
  max: number,
): Record<string, TrackProfile> {
  const ids = Object.keys(store);
  if (ids.length <= max) return store;
  ids.sort((a, b) => store[b].updated - store[a].updated);
  const kept: Record<string, TrackProfile> = {};
  for (let i = 0; i < max; i++) kept[ids[i]] = store[ids[i]];
  return kept;
}

/** Serialize a whole store to what goes in localStorage. */
export function encodeStore(store: Record<string, TrackProfile>): string {
  const out: Record<string, StoredProfile> = {};
  for (const [id, p] of Object.entries(store)) out[id] = encodeProfile(p);
  return JSON.stringify(out);
}

/** Parse a whole store, dropping any entry that doesn't validate. */
export function decodeStore(raw: string): Record<string, TrackProfile> {
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const out: Record<string, TrackProfile> = {};
  for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
    const p = decodeProfile(value);
    if (p) out[id] = p;
  }
  return out;
}

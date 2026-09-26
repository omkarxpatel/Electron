/**
 * Derived listening stats.
 *
 * Pure functions over what `/me/top/{tracks,artists}` returns — no fetching
 * here, so the numbers can be checked without a Spotify session.
 *
 * Two of these depend on fields Spotify REMOVED from Dev Mode responses in
 * Feb 2026: `popularity` on tracks and `genres` on artists. Client IDs
 * created before the cutover are still sent them. Every function that needs
 * one returns `null` when the field is absent across the board, so callers
 * hide the panel instead of rendering a chart of zeros — an empty genre
 * breakdown would otherwise read as "you listen to no genres" rather than
 * "your account can't see this".
 */

import type { SpotifyArtist, SpotifyTrack } from './types';

// ── Rank movement ───────────────────────────────────────────────────────

/** How an entry moved between two time windows. */
export type RankDelta =
  | { kind: 'new' }
  | { kind: 'same' }
  | { kind: 'up'; by: number }
  | { kind: 'down'; by: number };

/**
 * Where `id` sits now versus where it sat in `previous`.
 *
 * "New" means absent from the older window entirely. Both lists are capped
 * at 50 by the API, so an entry that merely fell past 50th place also reads
 * as new when it climbs back — there's no way to tell that apart from a
 * genuine first appearance, and claiming otherwise would be a guess.
 */
export function rankDelta(id: string, currentIndex: number, previousIds: string[]): RankDelta {
  const was = previousIds.indexOf(id);
  if (was < 0) return { kind: 'new' };
  const moved = was - currentIndex;
  if (moved === 0) return { kind: 'same' };
  return moved > 0 ? { kind: 'up', by: moved } : { kind: 'down', by: -moved };
}

/** One row of a top list with its movement against the comparison window. */
export interface RankedEntry<T> {
  item: T;
  rank: number;
  delta: RankDelta;
}

export function withRankDeltas<T extends { id: string }>(
  current: T[],
  previous: T[],
): RankedEntry<T>[] {
  const previousIds = previous.map((p) => p.id);
  return current.map((item, i) => ({
    item,
    rank: i + 1,
    delta: rankDelta(item.id, i, previousIds),
  }));
}

// ── Genre breakdown ─────────────────────────────────────────────────────

export interface GenreCount {
  genre: string;
  /** How many of the supplied artists carry this genre. */
  count: number;
  /** Share of the largest genre, 0-1 — used for bar widths. */
  share: number;
}

/**
 * Aggregate genres across artists, most common first.
 *
 * Returns null when not one artist carries a genre list, which is what a
 * post-Feb-2026 client ID sees — `genres` comes back null or omitted. An
 * account that genuinely has no genre data and one that isn't allowed to see
 * it are indistinguishable from here, so both hide the panel.
 */
export function topGenres(artists: SpotifyArtist[], limit = 10): GenreCount[] | null {
  const counts = new Map<string, number>();
  let sawAnyList = false;
  for (const artist of artists) {
    const genres = artist.genres;
    if (!genres || genres.length === 0) continue;
    sawAnyList = true;
    for (const g of genres) counts.set(g, (counts.get(g) ?? 0) + 1);
  }
  if (!sawAnyList) return null;
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
  const max = sorted[0]?.[1] ?? 1;
  return sorted.map(([genre, count]) => ({ genre, count, share: count / max }));
}

// ── Mainstream-ness ─────────────────────────────────────────────────────

export interface PopularityStat {
  /** Mean `popularity` (0-100) across the tracks that reported one. */
  average: number;
  /** How many tracks actually carried the field. */
  sampled: number;
  /** Lowest-popularity tracks, most obscure first. */
  deepestCuts: SpotifyTrack[];
}

/**
 * Average popularity of the supplied tracks, plus the most obscure of them.
 *
 * Null when no track reports `popularity` — removed from Dev Mode responses
 * in Feb 2026. Tracks missing the field are skipped rather than counted as
 * zero, which would drag the average toward "obscure" purely because of a
 * permissions change.
 */
export function popularityStat(tracks: SpotifyTrack[], deepCount = 5): PopularityStat | null {
  const scored = tracks.filter(
    (t): t is SpotifyTrack & { popularity: number } => typeof t.popularity === 'number',
  );
  if (scored.length === 0) return null;
  const total = scored.reduce((sum, t) => sum + t.popularity, 0);
  const deepestCuts = [...scored].sort((a, b) => a.popularity - b.popularity).slice(0, deepCount);
  return {
    average: total / scored.length,
    sampled: scored.length,
    deepestCuts,
  };
}

/** Plain-language reading of an average popularity score. Bands are chosen
 *  to be descriptive rather than flattering — 50 really is middle-of-road. */
export function mainstreamLabel(average: number): string {
  if (average >= 75) return 'Chart-driven';
  if (average >= 60) return 'Mostly mainstream';
  if (average >= 45) return 'Balanced';
  if (average >= 30) return 'Off the beaten path';
  return 'Deep underground';
}

// ── Overview tiles ──────────────────────────────────────────────────────

export interface Overview {
  /** Distinct artists credited across the supplied tracks. */
  distinctArtists: number;
  /** Null when no artist carries genres — same reason as `topGenres`. */
  distinctGenres: number | null;
  averageLengthMs: number;
  /** 0-1. Share of tracks flagged explicit. */
  explicitShare: number;
  /** Entries absent from the comparison window. Null when there isn't one
   *  (all-time has nothing older to compare against). */
  newEntries: number | null;
}

export function overview(
  tracks: SpotifyTrack[],
  artists: SpotifyArtist[],
  previousTracks: SpotifyTrack[] | null,
): Overview | null {
  if (tracks.length === 0) return null;

  const artistIds = new Set<string>();
  for (const t of tracks) for (const a of t.artists) artistIds.add(a.id);

  const genreNames = new Set<string>();
  let sawGenreList = false;
  for (const a of artists) {
    if (!a.genres || a.genres.length === 0) continue;
    sawGenreList = true;
    for (const g of a.genres) genreNames.add(g);
  }

  const totalMs = tracks.reduce((sum, t) => sum + t.duration_ms, 0);
  const explicitCount = tracks.filter((t) => t.explicit).length;

  let newEntries: number | null = null;
  if (previousTracks) {
    const previousIds = new Set(previousTracks.map((t) => t.id));
    newEntries = tracks.filter((t) => !previousIds.has(t.id)).length;
  }

  return {
    distinctArtists: artistIds.size,
    distinctGenres: sawGenreList ? genreNames.size : null,
    averageLengthMs: totalMs / tracks.length,
    explicitShare: explicitCount / tracks.length,
    newEntries,
  };
}

// ── Release eras ────────────────────────────────────────────────────────

export interface EraBucket {
  /** e.g. "2010s". */
  label: string;
  decade: number;
  count: number;
  /** Share of the biggest bucket, 0-1 — used for bar widths. */
  share: number;
}

/**
 * How old the music is, bucketed by decade of release.
 *
 * `release_date` survived Feb 2026 (unlike `popularity`), and it rides along
 * on the album object already attached to every track, so this costs nothing
 * extra. Precision varies — Spotify sends "2017", "2017-05" or "2017-05-12" —
 * so only the leading year is read.
 *
 * Returns null when no track carries a date at all, rather than an empty
 * chart that would read as "you listen to nothing".
 */
export function releaseEras(tracks: SpotifyTrack[]): EraBucket[] | null {
  const counts = new Map<number, number>();
  for (const t of tracks) {
    const year = Number(t.album?.release_date?.slice(0, 4));
    if (!Number.isFinite(year) || year < 1900) continue;
    const decade = Math.floor(year / 10) * 10;
    counts.set(decade, (counts.get(decade) ?? 0) + 1);
  }
  if (counts.size === 0) return null;
  const max = Math.max(...counts.values());
  return [...counts.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([decade, count]) => ({
      label: `${decade}s`,
      decade,
      count,
      share: count / max,
    }));
}

// ── Biggest movers ──────────────────────────────────────────────────────

export interface Movers<T> {
  climber: RankedEntry<T> | null;
  faller: RankedEntry<T> | null;
}

/**
 * The single largest rise and fall in a ranked list.
 *
 * `new` entries are excluded from "climber" deliberately: an entry with no
 * previous position hasn't climbed by a measurable amount, and treating it
 * as an infinite rise would always beat every real mover.
 */
export function biggestMovers<T extends { id: string }>(
  ranked: RankedEntry<T>[],
): Movers<T> {
  let climber: RankedEntry<T> | null = null;
  let faller: RankedEntry<T> | null = null;
  for (const entry of ranked) {
    if (entry.delta.kind === 'up') {
      if (!climber || entry.delta.by > (climber.delta as { by: number }).by) climber = entry;
    } else if (entry.delta.kind === 'down') {
      if (!faller || entry.delta.by > (faller.delta as { by: number }).by) faller = entry;
    }
  }
  return { climber, faller };
}

// ── Artist concentration ────────────────────────────────────────────────

export interface Concentration {
  /** 0-1. Share of tracks credited to one of the top `topN` artists. */
  share: number;
  /** Names of those artists, in rank order. */
  names: string[];
}

/**
 * How much of the top-track list belongs to the handful of artists at the
 * top of the artist list — "are you exploring, or on a bender".
 *
 * Counts a track once even when several of its credited artists are in the
 * set, so features can't push the share above 1.
 */
export function artistConcentration(
  tracks: SpotifyTrack[],
  artists: SpotifyArtist[],
  topN = 5,
): Concentration | null {
  if (tracks.length === 0 || artists.length === 0) return null;
  const top = artists.slice(0, topN);
  const ids = new Set(top.map((a) => a.id));
  const hits = tracks.filter((t) => t.artists.some((a) => ids.has(a.id))).length;
  return { share: hits / tracks.length, names: top.map((a) => a.name) };
}

/** mm:ss for an average track length. */
export function formatLength(ms: number): string {
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  const sec = total % 60;
  return `${m}:${String(sec).padStart(2, '0')}`;
}

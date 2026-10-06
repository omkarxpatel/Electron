/**
 * Which of your playlists already contain a given track.
 *
 * Spotify has no "does playlist X contain track Y" endpoint, so the only way
 * to answer is to read every playlist's track list. What makes that
 * affordable is `fields`, which prunes the response to the one thing needed:
 * a 100-item page is **5.8 KB** as `fields=next,items(track(uri))` against
 * **679 KB** without, a 116x cut.
 *
 * It is still not cheap. Measured end to end on a real account — 50 editable
 * playlists, 13,997 tracks — a full crawl is **414 requests, 2.85 MB and 57
 * seconds** at the concurrency below, with no 429. So nothing happens until
 * something asks: the crawl starts the first time an "Add to playlist"
 * submenu opens, and the result is kept for the rest of the session.
 *
 * 57 seconds is also why markers appear as playlists land rather than when
 * the crawl finishes, and why this is a store with subscribers instead of a
 * promise — waiting for all of it would mean a submenu that tells you
 * nothing for the first minute of every session. Short playlists resolve in
 * the first second, which is the common case.
 *
 * ── What it will not claim ──
 *
 * A playlist is only ever marked as *containing* the track. There is no "not
 * in this one" marker, and a playlist that has not been read yet is simply
 * unmarked. Those two look identical on purpose: the alternative is telling
 * someone a track is missing from a playlist we have not actually looked at,
 * and they would only find out by adding a duplicate. Same instinct as the
 * remove label counting only the copies it can see.
 */

import { getPlaylistTrackUris } from './api';
import type { SpotifyPlaylist } from './types';

/** Parallel page fetches. 5 completed 414 requests with zero 429s when
 *  measured; a backoff-and-retry loop would be both more code and slower
 *  than not tripping the limit in the first place. Raise it only with a
 *  measurement, not a guess. */
const CONCURRENCY = 5;

/** playlist id → every track uri in it. Absent means "not read yet". */
const contents = new Map<string, Set<string>>();
/** In-flight or finished, so a second submenu open does not re-crawl. */
const started = new Set<string>();
const listeners = new Set<() => void>();

let crawling = 0;

function emit(): void {
  for (const fn of listeners) fn();
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** True while at least one playlist is still being read. */
export function isIndexing(): boolean {
  return crawling > 0;
}

/**
 * The ids of `playlists` known to contain `trackUri`.
 *
 * Only ever reports what has been read. See the header: an unread playlist is
 * indistinguishable from one that does not have the track, deliberately.
 */
export function playlistsContaining(trackUri: string, ids: string[]): Set<string> {
  const out = new Set<string>();
  for (const id of ids) {
    if (contents.get(id)?.has(trackUri)) out.add(id);
  }
  return out;
}

/** Start reading anything not read yet. Safe to call on every menu open. */
export function ensureIndexed(playlists: SpotifyPlaylist[]): void {
  const todo = playlists.map((p) => p.id).filter((id) => !started.has(id));
  if (todo.length === 0) return;
  for (const id of todo) started.add(id);

  // A hand-rolled worker pool rather than Promise.all over everything: 56
  // simultaneous crawls is how you get rate-limited, and the point of the
  // store is that the UI does not have to wait for the whole thing anyway.
  const queue = [...todo];
  const workers = Math.min(CONCURRENCY, queue.length);
  crawling += workers;

  for (let i = 0; i < workers; i++) {
    void (async () => {
      for (;;) {
        const id = queue.shift();
        if (id === undefined) break;
        try {
          contents.set(id, await getPlaylistTrackUris(id));
          emit();
        } catch (err) {
          // Left unread, not recorded as empty — an empty set would claim the
          // track is absent from a playlist we failed to read.
          started.delete(id);
          console.warn(`could not index playlist ${id}:`, err);
        }
      }
      crawling -= 1;
      emit();
    })();
  }
}

/** Keep the index true after our own write, so the marker is right at once
 *  instead of after the next session's crawl. */
export function noteAdded(playlistId: string, trackUri: string): void {
  const set = contents.get(playlistId);
  if (!set) return;
  set.add(trackUri);
  emit();
}

export function noteRemoved(playlistId: string, trackUri: string): void {
  const set = contents.get(playlistId);
  if (!set) return;
  set.delete(trackUri);
  emit();
}

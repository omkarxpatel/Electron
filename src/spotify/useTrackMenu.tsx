import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { ContextMenu, type ContextMenuItem } from '../components/ContextMenu';
import { useLibrary } from './SpotifyProvider';
import { usePlaylistIndex } from './usePlaylistIndex';
import { buildTrackMenuItems, createEditRunner, type TrackMenuSource } from './trackMenu';
import { requestOverlayNav } from './navigation';
import type { SpotifyTrack } from './types';

/**
 * The right-click menu on a track row, wired up once.
 *
 * `buildTrackMenuItems` decides WHAT is in the menu. This decides everything
 * around it, which is the part that was stopping the menu from existing in
 * most of the app: a result line with its own timer, the open/close position
 * state, an edit runner, and a re-render when the playlist index fills in.
 * That came to about sixty lines per surface, and it had already been written
 * twice and hand-rolled a third time — the album view's copy swallowed its
 * "Add to queue" failures silently, which is exactly the drift trackMenu.ts
 * warns about at the top.
 *
 * It reads `useLibrary()` itself rather than taking playlists, the user id and
 * the two write actions as props. That is the whole reason the queue and the
 * stats view can have a menu at all: both are rendered three levels below
 * anything that holds those, and threading them down would have meant new
 * props on every component in between for a feature none of them care about.
 * Every surface here is under <SpotifyProvider>, so the context is always
 * there.
 *
 * Navigation goes out over `requestOverlayNav` from everywhere, including from
 * inside the overlay itself — SpotifySection owns that listener and is an
 * ancestor of all of it, so a window event reaches the right place whether the
 * menu was opened from the player bar or from an album page two views deep.
 */

/** Matches the track list and the player bar, which this joins. */
const NOTICE_MS = 2600;

export interface TrackMenuConfig {
  /**
   * The list "Remove from…" should act on, or null to leave the item out.
   *
   * Most surfaces pass nothing. Search results, the queue, an artist's
   * Popular list and the stats view are all views OF tracks rather than lists
   * you can edit, and `removeTrackFromSource` only ever acts on whichever
   * source the main track list has open — which is usually not what you are
   * looking at. An item that deletes from a list the menu never named is
   * worse than no item.
   */
  source?: TrackMenuSource | null;
  /** Loaded tracks of `source`, for the duplicate count. */
  sourceTracks?: SpotifyTrack[];
  /** Liked toggle. Only the player bar knows this for its own track. */
  saved?: boolean | null;
  onToggleSaved?: () => Promise<void> | void;
  /**
   * Drop the entry that would navigate to the page you are already on.
   *
   * Flat booleans rather than an `omit: {}` object on purpose: callers write
   * the config inline, and a fresh object literal every render would
   * invalidate the memo below on every render.
   */
  omitGoToAlbum?: boolean;
  omitGoToArtist?: boolean;
}

export interface TrackMenu {
  /** Call from `onContextMenu`. Prevents the native menu itself. */
  open: (track: SpotifyTrack, e: React.MouseEvent) => void;
  /**
   * Render this once, anywhere in the component. Both halves are portalled to
   * document.body, so it is safe inside a `<tbody>` or a `<ul>` — a plain
   * `<div>` there would be invalid markup that React silently reparents.
   */
  node: ReactNode;
}

export function useTrackMenu(config: TrackMenuConfig = {}): TrackMenu {
  const {
    source = null,
    sourceTracks,
    saved,
    onToggleSaved,
    omitGoToAlbum = false,
    omitGoToArtist = false,
  } = config;

  const lib = useLibrary();

  // ── Result line ─────────────────────────────────────────────────────────
  // A write that fails silently is the worst outcome: the next move would be
  // to open Spotify and check, which is the thing this menu exists to avoid.
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimerRef = useRef<number | null>(null);
  const showNotice = useCallback((text: string) => {
    setNotice(text);
    if (noticeTimerRef.current !== null) window.clearTimeout(noticeTimerRef.current);
    noticeTimerRef.current = window.setTimeout(() => {
      setNotice(null);
      noticeTimerRef.current = null;
    }, NOTICE_MS);
  }, []);
  useEffect(
    () => () => {
      if (noticeTimerRef.current !== null) window.clearTimeout(noticeTimerRef.current);
    },
    [],
  );

  const runEdit = useMemo(() => createEditRunner(showNotice), [showNotice]);

  // ── Open / close ────────────────────────────────────────────────────────
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    track: SpotifyTrack;
    anchor: HTMLElement | null;
  } | null>(null);
  const close = useCallback(() => setMenu(null), []);

  const open = useCallback((track: SpotifyTrack, e: React.MouseEvent) => {
    e.preventDefault();
    // Stop the row's own handlers from also firing. Several of these rows are
    // buttons whose click plays the track, and a right-click that both opened
    // a menu and started the song would be its own bug report.
    e.stopPropagation();
    setMenu({
      x: e.clientX,
      y: e.clientY,
      track,
      anchor: e.currentTarget as HTMLElement,
    });
  }, []);

  // Re-renders the menu as the index fills; see playlistIndex.ts.
  const indexRevision = usePlaylistIndex();

  const items = useMemo<ContextMenuItem[]>(() => {
    if (!menu) return [];
    return buildTrackMenuItems({
      track: menu.track,
      playlists: lib.playlists,
      userId: lib.userId,
      source,
      sourceTracks: sourceTracks ?? [],
      saved,
      onToggleSaved,
      onAddToPlaylist: lib.addTrackToPlaylist,
      onRemoveFromSource: lib.removeTrackFromSource,
      onGoToAlbum: omitGoToAlbum
        ? undefined
        : (t) => {
            if (t.album?.id) requestOverlayNav({ kind: 'album', albumId: t.album.id });
          },
      onGoToArtist: omitGoToArtist
        ? undefined
        : (t) => {
            const id = t.artists[0]?.id;
            if (id) requestOverlayNav({ kind: 'artist', artistId: id });
          },
      runEdit,
      showNotice,
    });
  }, [
    menu,
    lib.playlists,
    lib.userId,
    lib.addTrackToPlaylist,
    lib.removeTrackFromSource,
    source,
    sourceTracks,
    saved,
    onToggleSaved,
    omitGoToAlbum,
    omitGoToArtist,
    runEdit,
    showNotice,
    indexRevision,
  ]);

  const node = (
    <>
      {notice &&
        createPortal(
          // Same line the player bar uses — fixed, so it is never clipped by
          // whichever scroll container the row happens to live in.
          <div className="sp-player-notice" role="status">
            {notice}
          </div>,
          document.body,
        )}
      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={items} anchor={menu.anchor} onClose={close} />
      )}
    </>
  );

  return { open, node };
}

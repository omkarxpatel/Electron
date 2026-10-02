import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SpotifyNowPlaying } from './SpotifyNowPlaying';
import { ContextMenu, type ContextMenuItem } from './ContextMenu';
import { usePlayback, useLibrary } from '../spotify/SpotifyProvider';
import { buildTrackMenuItems, createEditRunner } from '../spotify/trackMenu';
import { requestOverlayNav } from '../spotify/navigation';

/** Matches the track list's notice, which this mirrors. */
const NOTICE_MS = 2600;

/**
 * Thin context-consumer wrapper around SpotifyNowPlaying.
 *
 * Pulls playback state + transport actions from PlaybackContext so the App
 * shell no longer has to thread ten props down. SpotifyNowPlaying itself
 * stays pure / memo-friendly — this wrapper exists only to break the
 * prop-drilling chain.
 *
 * It also owns the "Suggested" test, because that is the one thing in the
 * player bar needing both contexts at once: playback (what's on) and library
 * (what's in the open playlist).
 */
export function NowPlayingBar() {
  const p = usePlayback();
  const lib = useLibrary();

  // Smart Shuffle splices tracks that aren't in the playlist into the queue,
  // and Spotify's API never flags which ones — the context uri stays the
  // playlist either way. So infer it: playing from the playlist we have open,
  // but the track isn't in it.
  //
  // Every clause below is a way that inference has been wrong:
  //
  //  - `tracksNextOffset === null` means fully paged in. Mid-pagination,
  //    "not in the list we've loaded" doesn't mean "not in the playlist".
  //  - `tracks.length > 0` because you cannot conclude a track is missing
  //    from a list you have none of. Opening a source used to set the
  //    fully-paged sentinel while the list was still empty, so for that whole
  //    window this test said yes to everything, badging tracks that were
  //    visibly sitting in the playlist.
  //  - `!tracksLoading` for the same reason, one step earlier.
  //  - `linked_from` because Spotify relinks tracks per market: the id on the
  //    player is the market-specific one while the playlist holds the
  //    original, so comparing only `id` reports a false miss.
  //
  // Liked Songs is excluded: it plays as a uri list with no context, so there
  // is nothing to compare against.
  const item = p.playback?.item ?? null;
  const trackId = item?.id ?? null;
  const originalId = item?.linked_from?.id ?? null;
  const contextUri = p.playback?.context?.uri ?? null;
  const suggested =
    trackId !== null &&
    contextUri !== null &&
    lib.source?.kind === 'playlist' &&
    lib.source.playlist.uri === contextUri &&
    lib.tracksNextOffset === null &&
    !lib.tracksLoading &&
    lib.tracks.length > 0 &&
    !lib.tracks.some(
      (t) => t.id === trackId || (originalId !== null && t.id === originalId),
    );

  // ── Right-click menu on the now-playing track ───────────────────────────
  const [menu, setMenu] = useState<{ x: number; y: number; anchor: HTMLElement } | null>(
    null,
  );
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

  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      if (!item) return;
      e.preventDefault();
      setMenu({ x: e.clientX, y: e.clientY, anchor: e.currentTarget as HTMLElement });
    },
    [item],
  );

  const menuItems = useMemo<ContextMenuItem[]>(() => {
    if (!menu || !item) return [];
    // "Remove from this playlist" is offered only when the playlist you have
    // open is also the one playing. removeTrackFromSource acts on the open
    // source, so any other pairing would delete the track from a list the
    // menu never named — the player bar is frequently playing something you
    // are not currently looking at. Liked Songs plays as a bare uri list with
    // no context, so it can never be confirmed this way; the Liked toggle
    // below covers un-saving instead.
    const playingOpenPlaylist =
      lib.source?.kind === 'playlist' && lib.source.playlist.uri === contextUri;

    return buildTrackMenuItems({
      track: item,
      playlists: lib.playlists,
      userId: lib.userId,
      source: playingOpenPlaylist ? lib.source : null,
      sourceTracks: playingOpenPlaylist ? lib.tracks : [],
      saved: p.savedCurrent,
      onToggleSaved: p.toggleSaveCurrent,
      onAddToPlaylist: lib.addTrackToPlaylist,
      onRemoveFromSource: lib.removeTrackFromSource,
      onGoToAlbum: (t) =>
        t.album?.id && requestOverlayNav({ kind: 'album', albumId: t.album.id }),
      onGoToArtist: (t) =>
        t.artists[0]?.id && requestOverlayNav({ kind: 'artist', artistId: t.artists[0].id }),
      runEdit,
      showNotice,
    });
  }, [menu, item, contextUri, lib, p.savedCurrent, p.toggleSaveCurrent, runEdit, showNotice]);

  return (
    <>
      {notice && (
        <div className="sp-player-notice" role="status">
          {notice}
        </div>
      )}
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItems}
          anchor={menu.anchor}
          onClose={() => setMenu(null)}
        />
      )}
    <SpotifyNowPlaying
      playback={p.playback}
      togglePlay={p.togglePlay}
      next={p.next}
      previous={p.previous}
      seek={p.seek}
      setVolume={p.setVolume}
      toggleShuffle={p.toggleShuffle}
      cycleRepeat={p.cycleRepeat}
      toggleSaveCurrent={p.toggleSaveCurrent}
      savedCurrent={p.savedCurrent}
      suggested={suggested}
      onTrackContextMenu={handleContextMenu}
    />
    </>
  );
}

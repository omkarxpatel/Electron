import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { HoverOverlayPanel } from './HoverOverlayPanel';
import { SectionBoundary } from './SectionBoundary';
import { SpotifyTrackList } from './SpotifyTrackList';
import { prefetchLyrics } from '../lyrics/useLyrics';
import { getQueue } from '../spotify/api';
import { useLibrary, usePlayback } from '../spotify/SpotifyProvider';
import { useTransportShortcuts } from '../spotify/useTransportShortcuts';
import type { SpotifyTrack } from '../spotify/types';
import { onOverlayNav } from '../spotify/navigation';

/**
 * The right column of the post-auth workspace: music-icon overlay trigger,
 * track list, lyrics. Also owns the HoverOverlayPanel (library / search /
 * queue) — it's a sibling rather than a child because the panel is fixed-
 * positioned, and the trigger button + panel share state.
 *
 * State owned here (not lifted to App):
 *   - overlay open/close + grace-period close timer
 *   - lyrics prefetch effect (fires on currentlyPlayingId change)
 *
 * Reads from PlaybackContext + LibraryContext directly so App doesn't have
 * to thread a dozen spotify props through.
 */

// Lazy-loaded post-auth chunks. SpotifyOverlay (library + search + queue +
// album-detail) and LyricsPane (lrclib + ovh + LRC parser) are only used
// after the user authenticates Spotify. Splitting them out trims the cold-
// start parse cost. Suspense fallback is `null` because both render in
// container slots that already have their own empty states.
const SpotifyOverlay = lazy(() =>
  import('./SpotifyOverlay').then((m) => ({ default: m.SpotifyOverlay })),
);
const LyricsPane = lazy(() =>
  import('./LyricsPane').then((m) => ({ default: m.LyricsPane })),
);

interface Props {
  /** Window-visibility flag — RAF-driven children gate on it to suspend
   *  while the window is hidden. */
  active: boolean;
  /** When false the lyrics pane is not mounted at all, so its lazy chunk is
   *  never fetched and the track list reclaims the vertical space. */
  showLyrics: boolean;
  /** Right column slid away so the visualizer + EQ get the full width. The
   *  panel stays mounted — collapsing must not drop the Spotify poll, the
   *  lyrics prefetch or the track list's scroll position. */
  collapsed: boolean;
  onToggleCollapsed: () => void;
}

export function SpotifySection({ active, showLyrics, collapsed, onToggleCollapsed }: Props) {
  const library = useLibrary();
  const playback = usePlayback();

  // Whether the transport is playing the source this list is showing, which
  // is what lets the header button show Pause. Compared on the context uri
  // rather than on the playing track: a track can appear in many playlists,
  // so "the current track is in this list" would light up the wrong header.
  //
  // Liked Songs can't be detected this way and stays showing Play — it is
  // started as a bare uri list, so Spotify reports no context at all.
  const sourcePlaying =
    playback.playback?.is_playing === true &&
    library.source?.kind === 'playlist' &&
    playback.playback.context?.uri === library.source.playlist.uri;
  // Space / ← / →. Registered here because this section is only mounted once
  // Spotify is connected, so the keys do nothing before there's a player.
  useTransportShortcuts();
  const currentlyPlayingId = useMemo(
    () => playback.playback?.item?.id ?? null,
    [playback.playback?.item?.id],
  );

  // Overlay state + handlers — see App.tsx's previous comment for the rationale.
  const [overlayOpen, setOverlayOpen] = useState<boolean>(false);
  const overlayCloseTimerRef = useRef<number | null>(null);
  const cancelOverlayClose = useCallback((): void => {
    if (overlayCloseTimerRef.current !== null) {
      window.clearTimeout(overlayCloseTimerRef.current);
      overlayCloseTimerRef.current = null;
    }
  }, []);
  const requestOverlayClose = useCallback((): void => {
    cancelOverlayClose();
    overlayCloseTimerRef.current = window.setTimeout(() => {
      setOverlayOpen(false);
      overlayCloseTimerRef.current = null;
    }, 300);
  }, [cancelOverlayClose]);
  const openOverlay = useCallback((): void => {
    cancelOverlayClose();
    setOverlayOpen(true);
  }, [cancelOverlayClose]);
  const closeOverlay = useCallback((): void => {
    cancelOverlayClose();
    setOverlayOpen(false);
  }, [cancelOverlayClose]);
  useEffect(() => () => cancelOverlayClose(), [cancelOverlayClose]);

  // "Go to album" from a track row. The album view lives inside the overlay,
  // so this opens the panel and hands it the album to drill into. The nonce
  // is what makes asking for the *same* album twice register as a new
  // request — the overlay resets itself to the library view on every open,
  // so without it the second trip would land back on the library.
  const [albumRequest, setAlbumRequest] = useState<{ albumId: string; nonce: number } | null>(
    null,
  );
  const [artistRequest, setArtistRequest] = useState<
    { artistId: string; nonce: number } | null
  >(null);
  const navNonceRef = useRef(0);

  const openAlbum = useCallback(
    (albumId: string): void => {
      navNonceRef.current += 1;
      setArtistRequest(null);
      setAlbumRequest({ albumId, nonce: navNonceRef.current });
      openOverlay();
    },
    [openOverlay],
  );
  const openArtist = useCallback(
    (artistId: string): void => {
      navNonceRef.current += 1;
      setAlbumRequest(null);
      setArtistRequest({ artistId, nonce: navNonceRef.current });
      openOverlay();
    },
    [openOverlay],
  );

  const handleGoToAlbum = useCallback(
    (track: SpotifyTrack): void => {
      const albumId = track.album?.id;
      if (!albumId) return;
      openAlbum(albumId);
    },
    [openAlbum],
  );

  // The player bar is a sibling, not a child — it asks for these by window
  // event rather than through App. See src/spotify/navigation.ts.
  useEffect(
    () =>
      onOverlayNav((target) => {
        if (target.kind === 'album') openAlbum(target.albumId);
        else openArtist(target.artistId);
      }),
    [openAlbum, openArtist],
  );
  const overlayTriggerProps = useMemo(
    () => ({
      onMouseEnter: openOverlay,
      onMouseLeave: requestOverlayClose,
      onClick: () => (overlayOpen ? closeOverlay() : openOverlay()),
      'aria-expanded': overlayOpen,
    }),
    [overlayOpen, openOverlay, requestOverlayClose, closeOverlay],
  );

  // Lyrics prefetch — whenever the current track changes, fetch the queue
  // and prime the lyrics cache for the next ~2 upcoming tracks. By the time
  // the user advances, those lyrics are already in memory and render instantly.
  useEffect(() => {
    if (!library.authed || !currentlyPlayingId) return;
    let cancelled = false;
    // Slight delay so the queue is up-to-date after the track change has
    // propagated through Spotify's servers.
    const t = window.setTimeout(() => {
      void getQueue()
        .then((q) => {
          if (cancelled || !q) return;
          for (const upcoming of q.queue.slice(0, 2)) {
            if (!upcoming) continue;
            const title = upcoming.name;
            const artist = upcoming.artists?.[0]?.name;
            if (!title || !artist) continue;
            prefetchLyrics(title, artist, upcoming.album?.name, upcoming.duration_ms);
          }
        })
        .catch(() => {
          /* queue read failures aren't worth surfacing — silent skip */
        });
    }, 600);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [library.authed, currentlyPlayingId]);

  return (
    <>
      <div className="workspace-right">
        <div className="sp-right-header">
          <button
            type="button"
            className="sp-right-music-icon"
            data-active={overlayOpen ? 'true' : 'false'}
            aria-label="Open Spotify library"
            title="Hover to open library, search & queue"
            {...overlayTriggerProps}
          >
            <IconLibrary />
          </button>
          <button
            type="button"
            className="sp-right-collapse"
            onClick={onToggleCollapsed}
            aria-label="Collapse panel"
            aria-expanded={!collapsed}
            title="Collapse the panel — the visualizer takes the full width"
          >
            <IconChevronRight />
          </button>
        </div>

        <SectionBoundary label="track list">
        <SpotifyTrackList
          source={library.source}
          tracks={library.tracks}
          tracksTotal={library.tracksTotal}
          loading={library.tracksLoading}
          currentlyPlayingId={currentlyPlayingId}
          onPlay={library.playTrack}
          onPlayTracks={library.playTracks}
          onLoadMore={library.loadMoreTracks}
          hasMore={library.tracksNextOffset !== null}
          rawLoadedThrough={library.tracksNextOffset}
          shuffle={playback.playback?.shuffle_state === true}
          sourcePlaying={sourcePlaying}
          onPause={playback.togglePlay}
          playlists={library.playlists}
          userId={library.userId}
          onAddToPlaylist={library.addTrackToPlaylist}
          onRemoveFromSource={library.removeTrackFromSource}
          onGoToAlbum={handleGoToAlbum}
          onRenamePlaylist={library.renamePlaylist}
          onDeletePlaylist={library.deletePlaylist}
          onMoveTrack={library.moveTrackInPlaylist}
        />
        </SectionBoundary>

        {showLyrics && (
          <SectionBoundary label="lyrics">
            <Suspense fallback={null}>
              <LyricsPane playback={playback.playback} active={active} />
            </Suspense>
          </SectionBoundary>
        )}
      </div>

      {/* Absolutely positioned, so it is not a third grid column — the
          workspace stays a 2-column grid whether or not this is showing. */}
      {collapsed && (
        <button
          type="button"
          className="sp-right-expand"
          onClick={onToggleCollapsed}
          aria-label="Expand panel"
          aria-expanded={false}
          title="Bring the playlist panel back"
        >
          <IconChevronLeft />
        </button>
      )}

      <HoverOverlayPanel
        title="Spotify"
        open={overlayOpen}
        onMouseEnter={openOverlay}
        onMouseLeave={requestOverlayClose}
        onClose={closeOverlay}
      >
        <SectionBoundary label="library panel">
        <Suspense fallback={null}>
          <SpotifyOverlay
            playlists={library.playlists}
            playlistsLoading={library.playlistsLoading}
            selectedPlaylistId={
              library.source?.kind === 'playlist' ? library.source.playlist.id : null
            }
            onSelectPlaylist={library.selectPlaylist}
            onSelectLikedSongs={library.selectLikedSongs}
            userId={library.userId}
            onAddToPlaylist={library.addTrackToPlaylist}
            likedSelected={library.source?.kind === 'liked'}
            onCreatePlaylist={library.createPlaylist}
            searchAll={library.searchAll}
            searchMore={library.searchMore}
            playTrack={library.playTrack}
            playContext={library.playContext}
            currentlyPlayingId={currentlyPlayingId}
            open={overlayOpen}
            onClose={closeOverlay}
            albumRequest={albumRequest}
            artistRequest={artistRequest}
          />
        </Suspense>
        </SectionBoundary>
      </HoverOverlayPanel>
    </>
  );
}

/** Chevrons point the way the panel travels: right to tuck it away, left to
 *  pull it back. */
function IconChevronRight() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M9 6l6 6-6 6" />
    </svg>
  );
}

function IconChevronLeft() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M15 6l-6 6 6 6" />
    </svg>
  );
}

function IconLibrary() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M9 18V5l12-2v13" />
      <circle cx="6" cy="18" r="3" />
      <circle cx="18" cy="16" r="3" />
    </svg>
  );
}

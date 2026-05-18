import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { HoverOverlayPanel } from './HoverOverlayPanel';
import { SpotifyTrackList } from './SpotifyTrackList';
import { prefetchLyrics } from '../lyrics/useLyrics';
import { getQueue } from '../spotify/api';
import { useLibrary, usePlayback } from '../spotify/SpotifyProvider';

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
}

export function SpotifySection({ active }: Props) {
  const library = useLibrary();
  const playback = usePlayback();
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
        </div>

        <SpotifyTrackList
          playlist={library.selectedPlaylist}
          tracks={library.tracks}
          loading={library.tracksLoading}
          currentlyPlayingId={currentlyPlayingId}
          onPlay={library.playTrack}
          onLoadMore={library.loadMoreTracks}
          hasMore={library.tracksNextOffset !== null}
        />

        <Suspense fallback={null}>
          <LyricsPane playback={playback.playback} active={active} />
        </Suspense>
      </div>

      <HoverOverlayPanel
        title="Spotify"
        open={overlayOpen}
        onMouseEnter={openOverlay}
        onMouseLeave={requestOverlayClose}
        onClose={closeOverlay}
      >
        <Suspense fallback={null}>
          <SpotifyOverlay
            playlists={library.playlists}
            playlistsLoading={library.playlistsLoading}
            selectedPlaylistId={library.selectedPlaylist?.id ?? null}
            onSelectPlaylist={library.selectPlaylist}
            searchTracks={library.searchTracks}
            playTrack={library.playTrack}
            currentlyPlayingId={currentlyPlayingId}
            open={overlayOpen}
            onClose={closeOverlay}
          />
        </Suspense>
      </HoverOverlayPanel>
    </>
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

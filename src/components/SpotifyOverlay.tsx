import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRenderCount } from '../perf';
import {
  getAlbum,
  getArtist,
  getArtistAlbums,
  type AlbumWithTracks,
  type SearchResults,
  type SearchType,
} from '../spotify/api';
import { SpotifyLibrary } from './SpotifyLibrary';
import { SpotifyQueue } from './SpotifyQueue';
import { SpotifyStats } from './SpotifyStats';
import { DjPanel, type LiveMeasurement } from './DjPanel';
import type {
  SpotifyAlbum,
  SpotifyArtist,
  SpotifyPlaylist,
  SpotifyTrack,
} from '../spotify/types';
import { ContextMenu, type ContextMenuItem } from './ContextMenu';
import { addToQueue, canEditPlaylist, isMissingScopeError } from '../spotify/api';
import { formatDuration } from '../shared/format';
import type { TrackProfile } from '../audio/trackProfile';
import { pickMediumImage } from '../shared/image';

type View = 'library' | 'album' | 'artist' | 'queue' | 'stats' | 'dj';

interface Props {
  playlists: SpotifyPlaylist[];
  playlistsLoading: boolean;
  /** Needed to tell which playlists the user may actually write to. */
  userId: string | null;
  onAddToPlaylist: (playlistId: string, track: SpotifyTrack) => Promise<void>;
  selectedPlaylistId: string | null;
  onSelectPlaylist: (playlist: SpotifyPlaylist) => void;
  onSelectLikedSongs: () => void;
  likedSelected: boolean;
  onCreatePlaylist: (name: string) => Promise<void>;
  searchAll: (query: string, signal?: AbortSignal) => Promise<SearchResults>;
  searchMore: (query: string, type: SearchType, offset: number) => Promise<SearchResults>;
  playTrack: (track: SpotifyTrack, contextUri?: string) => void;
  playContext: (contextUri: string) => void;
  currentlyPlayingId: string | null;
  /** True when the panel is open. Bumps refresh keys for inner views that
   *  should refetch on each open (saved albums, queue). */
  open: boolean;
  /** Called by the inner views when they want to dismiss the panel — e.g.
   *  after the user clicks a playlist tile, the parent closes the overlay
   *  so the user immediately sees the loaded tracks in the right column. */
  onClose: () => void;
  /** An album or artist to drill straight into, set by "Go to album" on a
   *  track row or by clicking the player bar. `nonce` is what makes a repeat
   *  request for the same target count as a new one. */
  albumRequest: { albumId: string; nonce: number } | null;
  artistRequest: { artistId: string; nonce: number } | null;
  /** Everything the DJ view needs. Threaded from App rather than read from a
   *  hook here because only one `useTrackMemory` may exist — a second would
   *  hold its own copy of the store and the two would diverge. */
  dj: {
    currentTrack: SpotifyTrack | null;
    live: LiveMeasurement | null;
    recall: (trackId: string | null) => TrackProfile | null;
    audible: boolean;
    duckGainRef: { current: GainNode | null };
    voiceGainRef: { current: GainNode | null };
  };
}

export const SpotifyOverlay = memo(SpotifyOverlayImpl);

function SpotifyOverlayImpl({
  playlists,
  playlistsLoading,
  userId,
  onAddToPlaylist,
  selectedPlaylistId,
  onSelectPlaylist,
  onSelectLikedSongs,
  likedSelected,
  onCreatePlaylist,
  searchAll,
  searchMore,
  playTrack,
  playContext,
  currentlyPlayingId,
  open,
  onClose,
  albumRequest,
  artistRequest,
  dj,
}: Props) {
  useRenderCount('SpotifyOverlay');
  const [view, setView] = useState<View>('library');
  const [selectedAlbum, setSelectedAlbum] = useState<AlbumWithTracks | null>(null);
  const [selectedArtist, setSelectedArtist] = useState<
    { artist: SpotifyArtist; albums: SpotifyAlbum[] } | null
  >(null);
  const [albumLoading, setAlbumLoading] = useState<boolean>(false);
  const [refreshKey, setRefreshKey] = useState<number>(0);

  // Bump refreshKey on every open; reset to library view too so the user
  // doesn't reopen straight into a stale drill-in.
  useEffect(() => {
    if (open) {
      setRefreshKey((k) => k + 1);
      setView('library');
      setSelectedAlbum(null);
      setSelectedArtist(null);
    }
  }, [open]);

  /**
   * Drill into an album asked for from outside the panel.
   *
   * Declared after the open-effect above deliberately: that one resets the
   * view to `library` on every open, and when a track row opens the panel
   * both fire in the same commit. Effects run in declaration order, so this
   * one wins — reverse them and "Go to album" lands on the library instead.
   */
  useEffect(() => {
    if (!albumRequest) return;
    let cancelled = false;
    setAlbumLoading(true);
    void getAlbum(albumRequest.albumId)
      .then((full) => {
        if (cancelled || !full) return;
        setSelectedAlbum(full);
        setView('album');
      })
      .catch((err) => {
        console.error('getAlbum failed:', err);
      })
      .finally(() => {
        if (!cancelled) setAlbumLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [albumRequest]);

  const handleSelectPlaylist = useCallback(
    (playlist: SpotifyPlaylist): void => {
      onSelectPlaylist(playlist);
      onClose();
    },
    [onSelectPlaylist, onClose],
  );

  const handleSelectAlbum = useCallback(async (album: SpotifyAlbum): Promise<void> => {
    setAlbumLoading(true);
    try {
      const full = await getAlbum(album.id);
      if (full) {
        setSelectedAlbum(full);
        setView('album');
      }
    } catch (err) {
      console.error('getAlbum failed:', err);
    } finally {
      setAlbumLoading(false);
    }
  }, []);

  const openArtist = useCallback(async (artistId: string): Promise<void> => {
    setAlbumLoading(true);
    try {
      const [artist, albums] = await Promise.all([
        getArtist(artistId),
        getArtistAlbums(artistId),
      ]);
      if (!artist) return;
      setSelectedArtist({ artist, albums });
      setView('artist');
    } catch (err) {
      console.error('getArtist failed:', err);
    } finally {
      setAlbumLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!artistRequest) return;
    void openArtist(artistRequest.artistId);
  }, [artistRequest, openArtist]);

  const backToLibrary = useCallback((): void => {
    setSelectedAlbum(null);
    setSelectedArtist(null);
    setView('library');
  }, []);

  /**
   * Play a search result inside its album rather than as a bare URI.
   *
   * A one-URI `play` call gives Spotify a context of exactly one track, so
   * playback stopped dead at the end of it. Handing over the album as the
   * context (started at this track) means the music keeps going. It isn't
   * Spotify's own behavior — theirs rolls into an algorithmic radio, which
   * needs /recommendations, withdrawn for new client IDs in Nov 2024.
   */
  const handlePlayTrackFromLibrary = useCallback(
    (t: SpotifyTrack): void => {
      playTrack(t, t.album?.uri);
    },
    [playTrack],
  );

  /** Opens the artist page rather than starting playback. Clicking an artist
   *  anywhere in the app should land in the same place; the page carries its
   *  own Play button, so nothing is lost. */
  const handleSelectArtist = useCallback(
    (artist: SpotifyArtist): void => {
      void openArtist(artist.id);
    },
    [openArtist],
  );

  const handleOpenQueue = useCallback((): void => {
    setView('queue');
  }, []);

  const handleOpenStats = useCallback((): void => {
    setView('stats');
  }, []);

  const handleOpenDj = useCallback((): void => {
    setView('dj');
  }, []);

  /** Picking Liked Songs loads it into the main track list, so the panel
   *  closes the same way choosing a playlist does. */
  const handleSelectLikedSongs = useCallback((): void => {
    onSelectLikedSongs();
    onClose();
  }, [onSelectLikedSongs, onClose]);

  return (
    <div className="sp-overlay-root">
      {view === 'library' && (
        <SpotifyLibrary
          playlists={playlists}
          playlistsLoading={playlistsLoading}
          selectedPlaylistId={selectedPlaylistId}
          onSelectPlaylist={handleSelectPlaylist}
          onSelectLikedSongs={handleSelectLikedSongs}
          likedSelected={likedSelected}
          onOpenStats={handleOpenStats}
          onCreatePlaylist={onCreatePlaylist}
          onSelectAlbum={handleSelectAlbum}
          onSelectArtist={handleSelectArtist}
          searchAll={searchAll}
          searchMore={searchMore}
          onPlayTrack={handlePlayTrackFromLibrary}
          currentlyPlayingId={currentlyPlayingId}
          onOpenQueue={handleOpenQueue}
          onOpenDj={handleOpenDj}
          refreshKey={refreshKey}
        />
      )}
      {view === 'album' && selectedAlbum && (
        <AlbumDetailView
          album={selectedAlbum}
          onBack={backToLibrary}
          onPlay={(track, contextUri) => playTrack(track, contextUri)}
          currentlyPlayingId={currentlyPlayingId}
          playlists={playlists}
          userId={userId}
          onAddToPlaylist={onAddToPlaylist}
        />
      )}
      {view === 'artist' && selectedArtist && (
        <ArtistDetailView
          artist={selectedArtist.artist}
          albums={selectedArtist.albums}
          onBack={backToLibrary}
          onPlay={() => playContext(selectedArtist.artist.uri)}
          onSelectAlbum={handleSelectAlbum}
        />
      )}
      {view === 'stats' && (
        <SpotifyStats
          onBack={backToLibrary}
          onPlayTrack={handlePlayTrackFromLibrary}
          refreshKey={refreshKey}
        />
      )}
      {view === 'dj' && (
        <DjPanel
          onBack={backToLibrary}
          playlists={playlists}
          currentlyPlayingId={currentlyPlayingId}
          currentTrack={dj.currentTrack}
          live={dj.live}
          recall={dj.recall}
          onPlay={(t) => playTrack(t)}
          audible={dj.audible}
          duckGainRef={dj.duckGainRef}
          voiceGainRef={dj.voiceGainRef}
        />
      )}
      {view === 'queue' && (
        <QueueView
          onBack={backToLibrary}
          onPlay={(t) => playTrack(t)}
          currentlyPlayingId={currentlyPlayingId}
          refreshKey={refreshKey}
        />
      )}
      {albumLoading && (
        <div className="sp-overlay-floating-loader">Opening…</div>
      )}
    </div>
  );
}

interface ArtistDetailViewProps {
  artist: SpotifyArtist;
  albums: SpotifyAlbum[];
  onBack: () => void;
  onPlay: () => void;
  onSelectAlbum: (album: SpotifyAlbum) => void;
}

/**
 * An artist's page: their picture, whatever metadata survived, and their
 * discography.
 *
 * No top-tracks list and no related artists — `/artists/{id}/top-tracks` and
 * `/artists/{id}/related-artists` were both removed in Feb 2026, and there is
 * no replacement. `genres` and `followers` render only when present, since
 * post-cutover client IDs get neither.
 */
function ArtistDetailView({ artist, albums, onBack, onPlay, onSelectAlbum }: ArtistDetailViewProps) {
  const image = artist.images?.[0]?.url ?? artist.images?.[1]?.url;
  const genres = artist.genres?.slice(0, 3).join(' · ');
  return (
    <div className="sp-album-detail">
      <div className="sp-overlay-back-row">
        <button type="button" className="sp-overlay-back" onClick={onBack}>
          ← Library
        </button>
      </div>
      <header className="sp-album-detail-header">
        <div className="sp-album-detail-meta">
          {image ? (
            <img className="sp-album-detail-cover sp-artist-avatar" src={image} alt="" draggable={false} />
          ) : (
            <div className="sp-album-detail-cover sp-artist-avatar sp-library-tile-cover-fallback" />
          )}
          <div className="sp-album-detail-text">
            <div className="sp-track-header-eyebrow">Artist</div>
            <h1 className="sp-album-detail-title">{artist.name}</h1>
            <div className="sp-album-detail-sub">
              {artist.followers ? `${artist.followers.total.toLocaleString()} followers` : null}
              {artist.followers && genres ? ' · ' : null}
              {genres || null}
              {!artist.followers && !genres ? `${albums.length} releases` : null}
            </div>
            <div className="sp-track-header-actions">
              <button type="button" className="sp-track-header-play" onClick={onPlay}>
                <IconPlaySmall />
                Play
              </button>
            </div>
          </div>
        </div>
      </header>
      <div className="sp-album-detail-scroll">
        {albums.length === 0 ? (
          <div className="sp-empty-state">
            <div className="sp-empty-sub">No releases to show.</div>
          </div>
        ) : (
          <div className="sp-library-grid">
            {albums.map((album) => (
              <button
                key={album.id}
                type="button"
                className="sp-library-tile"
                onClick={() => onSelectAlbum(album)}
                title={album.name}
              >
                {pickMediumImage(album.images) ? (
                  <img
                    className="sp-library-tile-cover"
                    src={pickMediumImage(album.images)}
                    alt=""
                    loading="lazy"
                    draggable={false}
                  />
                ) : (
                  <div className="sp-library-tile-cover sp-library-tile-cover-fallback" />
                )}
                <span className="sp-library-tile-name">{album.name}</span>
                <span className="sp-library-tile-sub">
                  {album.release_date?.slice(0, 4) ?? ''}
                  {album.album_type ? ` · ${album.album_type}` : ''}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function IconPlaySmall() {
  return (
    <svg width="11" height="12" viewBox="0 0 11 12" aria-hidden="true">
      <path d="M1 1.2 9.6 6 1 10.8z" fill="currentColor" />
    </svg>
  );
}

interface AlbumDetailViewProps {
  album: AlbumWithTracks;
  onBack: () => void;
  onPlay: (track: SpotifyTrack, contextUri: string) => void;
  currentlyPlayingId: string | null;
  playlists: SpotifyPlaylist[];
  userId: string | null;
  onAddToPlaylist: (playlistId: string, track: SpotifyTrack) => Promise<void>;
}

function AlbumDetailView({
  album,
  onBack,
  onPlay,
  currentlyPlayingId,
  playlists,
  userId,
  onAddToPlaylist,
}: AlbumDetailViewProps) {
  const coverUrl = album.images[0]?.url ?? album.images[1]?.url;
  const artistNames = album.artists.map((a) => a.name).join(', ');
  const tracks = album.tracks.items;
  const year = album.release_date?.slice(0, 4);

  const [menu, setMenu] = useState<{ x: number; y: number; track: SpotifyTrack } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimerRef = useRef<number | null>(null);

  const showNotice = useCallback((text: string) => {
    setNotice(text);
    if (noticeTimerRef.current !== null) window.clearTimeout(noticeTimerRef.current);
    noticeTimerRef.current = window.setTimeout(() => {
      setNotice(null);
      noticeTimerRef.current = null;
    }, 2600);
  }, []);

  useEffect(
    () => () => {
      if (noticeTimerRef.current !== null) window.clearTimeout(noticeTimerRef.current);
    },
    [],
  );

  const closeMenu = useCallback(() => setMenu(null), []);

  // Same shape as the main track list's row menu, minus the entries that
  // can't mean anything here: there's no "Go to album" from inside the album,
  // and no source playlist to remove from.
  const menuItems = useMemo<ContextMenuItem[]>(() => {
    if (!menu) return [];
    const track = menu.track;
    const targets: ContextMenuItem[] = playlists
      .filter((p) => canEditPlaylist(p, userId))
      .map((p) => ({
        label: p.name,
        onClick: () => {
          void onAddToPlaylist(p.id, track).then(
            () => showNotice(`Added to ${p.name}`),
            (err: unknown) => {
              console.error('playlist edit failed:', err);
              // A missing scope never resolves by retrying — say what fixes it.
              showNotice(
                isMissingScopeError(err)
                  ? 'Reconnect Spotify in Settings to allow playlist edits'
                  : 'Spotify rejected that — nothing changed',
              );
            },
          );
        },
      }));
    return [
      {
        label: 'Add to playlist',
        submenu: {
          items: targets,
          filterPlaceholder: 'Find a playlist',
          emptyLabel: userId ? 'No playlists you can edit' : 'Loading your playlists…',
        },
      },
      {
        label: 'Add to queue',
        onClick: () => {
          void addToQueue(track.uri).catch((err) => {
            console.error('addToQueue failed:', err);
          });
        },
      },
      {
        separator: true,
        label: 'Copy Spotify link',
        onClick: () => {
          void navigator.clipboard
            .writeText(`https://open.spotify.com/track/${track.id}`)
            .then(() => showNotice('Link copied'))
            .catch((err) => console.error('clipboard write failed:', err));
        },
      },
    ];
  }, [menu, playlists, userId, onAddToPlaylist, showNotice]);

  return (
    <div className="sp-album-detail">
      <div className="sp-overlay-back-row">
        <button type="button" className="sp-overlay-back" onClick={onBack}>
          ← Library
        </button>
      </div>
      <header className="sp-album-detail-header">
        <div className="sp-album-detail-meta">
          {coverUrl ? (
            <img className="sp-album-detail-cover" src={coverUrl} alt="" draggable={false} />
          ) : (
            <div className="sp-album-detail-cover sp-library-tile-cover-fallback" />
          )}
          <div className="sp-album-detail-text">
            <div className="sp-track-header-eyebrow">Album</div>
            <h1 className="sp-album-detail-title">{album.name}</h1>
            <div className="sp-album-detail-sub">
              {artistNames}
              {year ? ` · ${year}` : ''} · {album.total_tracks ?? tracks.length} tracks
            </div>
          </div>
        </div>
      </header>
      <div className="sp-album-detail-scroll">
        <table className="sp-track-table">
          <thead>
            <tr>
              <th className="sp-track-index">#</th>
              <th className="sp-track-head-title">Title</th>
              <th className="sp-track-duration">Duration</th>
            </tr>
          </thead>
          <tbody>
            {tracks.map((track, index) => {
              const isPlaying = track.id === currentlyPlayingId;
              const trackForPlay = track as unknown as SpotifyTrack;
              return (
                <tr
                  key={`${track.id}-${index}`}
                  className="sp-track-row"
                  data-play="dblclick"
                  data-playing={isPlaying ? 'true' : 'false'}
                  onDoubleClick={() => onPlay(trackForPlay, album.uri)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setMenu({ x: e.clientX, y: e.clientY, track: trackForPlay });
                  }}
                >
                  <td className="sp-track-index">
                    {isPlaying ? (
                      <span className="sp-track-playing-icon">♫</span>
                    ) : (
                      <>
                        <span className="sp-track-number">{index + 1}</span>
                        <button
                          type="button"
                          className="sp-track-play-btn"
                          onClick={() => onPlay(trackForPlay, album.uri)}
                          aria-label={`Play ${track.name}`}
                          title={`Play ${track.name}`}
                        >
                          <svg width="11" height="12" viewBox="0 0 11 12" aria-hidden="true">
                            <path d="M1 1.2 9.6 6 1 10.8z" fill="currentColor" />
                          </svg>
                        </button>
                      </>
                    )}
                  </td>
                  <td className="sp-track-title-cell">
                    <div className="sp-track-text">
                      <div className="sp-track-name">{track.name}</div>
                      <div className="sp-track-artists">
                        {track.explicit ? <span className="sp-track-explicit">E</span> : null}
                        {track.artists.map((a) => a.name).join(', ')}
                      </div>
                    </div>
                  </td>
                  <td className="sp-track-duration">{formatDuration(track.duration_ms)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={closeMenu} />}
      {notice && (
        <div className="sp-track-notice" role="status">
          {notice}
        </div>
      )}
    </div>
  );
}

interface QueueViewProps {
  onBack: () => void;
  onPlay: (track: SpotifyTrack) => void;
  currentlyPlayingId: string | null;
  refreshKey: number;
}

function QueueView({ onBack, onPlay, currentlyPlayingId, refreshKey }: QueueViewProps) {
  return (
    <div className="sp-queue-wrap">
      <div className="sp-overlay-back-row">
        <button type="button" className="sp-overlay-back" onClick={onBack}>
          ← Library
        </button>
      </div>
      <SpotifyQueue
        onPlay={onPlay}
        currentlyPlayingId={currentlyPlayingId}
        refreshKey={refreshKey}
      />
    </div>
  );
}


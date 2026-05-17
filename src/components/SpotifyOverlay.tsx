import { memo, useEffect, useState } from 'react';
import { useRenderCount } from '../perf';
import { getAlbum, type AlbumWithTracks } from '../spotify/api';
import { SpotifyLibrary } from './SpotifyLibrary';
import { SpotifyQueue } from './SpotifyQueue';
import type { SpotifyAlbum, SpotifyPlaylist, SpotifyTrack } from '../spotify/types';

type View = 'library' | 'album' | 'queue';

interface Props {
  playlists: SpotifyPlaylist[];
  playlistsLoading: boolean;
  selectedPlaylistId: string | null;
  onSelectPlaylist: (playlist: SpotifyPlaylist) => void;
  searchTracks: (query: string) => Promise<SpotifyTrack[]>;
  playTrack: (track: SpotifyTrack, contextUri?: string, offsetIdx?: number) => void;
  currentlyPlayingId: string | null;
  /** True when the panel is open. Bumps refresh keys for inner views that
   *  should refetch on each open (saved albums, queue). */
  open: boolean;
  /** Called by the inner views when they want to dismiss the panel — e.g.
   *  after the user clicks a playlist tile, the parent closes the overlay
   *  so the user immediately sees the loaded tracks in the right column. */
  onClose: () => void;
}

export const SpotifyOverlay = memo(SpotifyOverlayImpl);

function SpotifyOverlayImpl({
  playlists,
  playlistsLoading,
  selectedPlaylistId,
  onSelectPlaylist,
  searchTracks,
  playTrack,
  currentlyPlayingId,
  open,
  onClose,
}: Props) {
  useRenderCount('SpotifyOverlay');
  const [view, setView] = useState<View>('library');
  const [selectedAlbum, setSelectedAlbum] = useState<AlbumWithTracks | null>(null);
  const [albumLoading, setAlbumLoading] = useState<boolean>(false);
  const [refreshKey, setRefreshKey] = useState<number>(0);

  // Bump refreshKey on every open; reset to library view too so the user
  // doesn't reopen straight into a stale drill-in.
  useEffect(() => {
    if (open) {
      setRefreshKey((k) => k + 1);
      setView('library');
      setSelectedAlbum(null);
    }
  }, [open]);

  const handleSelectPlaylist = (playlist: SpotifyPlaylist): void => {
    onSelectPlaylist(playlist);
    onClose();
  };

  const handleSelectAlbum = async (album: SpotifyAlbum): Promise<void> => {
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
  };

  const backToLibrary = (): void => {
    setSelectedAlbum(null);
    setView('library');
  };

  return (
    <div className="sp-overlay-root">
      {view === 'library' && (
        <SpotifyLibrary
          playlists={playlists}
          playlistsLoading={playlistsLoading}
          selectedPlaylistId={selectedPlaylistId}
          onSelectPlaylist={handleSelectPlaylist}
          onSelectAlbum={handleSelectAlbum}
          searchTracks={searchTracks}
          onPlayTrack={(t) => playTrack(t)}
          currentlyPlayingId={currentlyPlayingId}
          onOpenQueue={() => setView('queue')}
          refreshKey={refreshKey}
        />
      )}
      {view === 'album' && selectedAlbum && (
        <AlbumDetailView
          album={selectedAlbum}
          onBack={backToLibrary}
          onPlay={(track, contextUri, offsetIdx) => playTrack(track, contextUri, offsetIdx)}
          currentlyPlayingId={currentlyPlayingId}
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
        <div className="sp-overlay-floating-loader">Opening album…</div>
      )}
    </div>
  );
}

interface AlbumDetailViewProps {
  album: AlbumWithTracks;
  onBack: () => void;
  onPlay: (track: SpotifyTrack, contextUri: string, offsetIdx: number) => void;
  currentlyPlayingId: string | null;
}

function AlbumDetailView({ album, onBack, onPlay, currentlyPlayingId }: AlbumDetailViewProps) {
  const coverUrl = album.images[0]?.url ?? album.images[1]?.url;
  const artistNames = album.artists.map((a) => a.name).join(', ');
  const tracks = album.tracks.items;
  const year = album.release_date?.slice(0, 4);

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
              <th>#</th>
              <th>Title</th>
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
                  data-playing={isPlaying ? 'true' : 'false'}
                  onClick={() => onPlay(trackForPlay, album.uri, index)}
                >
                  <td className="sp-track-index">
                    {isPlaying ? <span className="sp-track-playing-icon">♫</span> : index + 1}
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

function formatDuration(ms: number): string {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

import { useEffect, useState } from 'react';
import { getSavedAlbums, getAlbum, type AlbumWithTracks } from '../spotify/api';
import type { SpotifyAlbum, SpotifyImage, SpotifyTrack } from '../spotify/types';

interface Props {
  /** Plays a track from a Spotify URI context with an explicit offset. */
  onPlay: (track: SpotifyTrack, contextUri: string, offsetIdx: number) => void;
  currentlyPlayingId: string | null;
  /** Refresh trigger — bump when the panel opens so we always show fresh data. */
  refreshKey: number;
}

function pickMediumImage(images: SpotifyImage[]): string | undefined {
  if (!images || images.length === 0) return undefined;
  // Spotify returns images in descending size order. Index 1 is usually
  // the ~300px version — good for grid thumbs.
  return images[1]?.url ?? images[0]?.url;
}

function formatDuration(ms: number): string {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function SpotifyAlbums({ onPlay, currentlyPlayingId, refreshKey }: Props) {
  const [albums, setAlbums] = useState<SpotifyAlbum[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [selected, setSelected] = useState<AlbumWithTracks | null>(null);
  const [detailLoading, setDetailLoading] = useState<boolean>(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getSavedAlbums(50, 0)
      .then((res) => {
        if (cancelled) return;
        setAlbums(res?.items.map((it) => it.album) ?? []);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        console.error('getSavedAlbums failed:', err);
        setAlbums([]);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  const handleAlbumClick = async (album: SpotifyAlbum): Promise<void> => {
    setDetailLoading(true);
    try {
      const full = await getAlbum(album.id);
      if (full) setSelected(full);
    } catch (err) {
      console.error('getAlbum failed:', err);
    } finally {
      setDetailLoading(false);
    }
  };

  if (selected) {
    return (
      <AlbumDetail
        album={selected}
        onBack={() => setSelected(null)}
        onPlay={onPlay}
        currentlyPlayingId={currentlyPlayingId}
      />
    );
  }

  return (
    <div className="sp-albums-view">
      {loading ? (
        <div className="sp-empty-state">
          <div className="sp-empty-sub">Loading your albums…</div>
        </div>
      ) : albums.length === 0 ? (
        <div className="sp-empty-state">
          <div className="sp-empty-title">No saved albums</div>
          <div className="sp-empty-sub">Save an album in Spotify and it'll show up here.</div>
        </div>
      ) : (
        <div className="sp-albums-grid">
          {albums.map((album) => {
            const coverUrl = pickMediumImage(album.images);
            const artistNames = album.artists.map((a) => a.name).join(', ');
            return (
              <button
                key={album.id}
                type="button"
                className="sp-album-card"
                onClick={() => handleAlbumClick(album)}
                title={`${album.name} — ${artistNames}`}
              >
                {coverUrl ? (
                  <img className="sp-album-card-cover" src={coverUrl} alt="" loading="lazy" draggable={false} />
                ) : (
                  <div className="sp-album-card-cover sp-album-card-cover-fallback" />
                )}
                <div className="sp-album-card-name">{album.name}</div>
                <div className="sp-album-card-artist">{artistNames}</div>
              </button>
            );
          })}
        </div>
      )}
      {detailLoading && (
        <div className="sp-overlay-floating-loader">Opening album…</div>
      )}
    </div>
  );
}

interface AlbumDetailProps {
  album: AlbumWithTracks;
  onBack: () => void;
  onPlay: (track: SpotifyTrack, contextUri: string, offsetIdx: number) => void;
  currentlyPlayingId: string | null;
}

function AlbumDetail({ album, onBack, onPlay, currentlyPlayingId }: AlbumDetailProps) {
  const coverUrl = album.images[0]?.url ?? album.images[1]?.url;
  const artistNames = album.artists.map((a) => a.name).join(', ');
  const tracks = album.tracks.items;
  const year = album.release_date?.slice(0, 4);

  return (
    <div className="sp-album-detail">
      <header className="sp-album-detail-header">
        <button type="button" className="sp-album-back" onClick={onBack} aria-label="Back to albums">
          ← Albums
        </button>
        <div className="sp-album-detail-meta">
          {coverUrl ? (
            <img className="sp-album-detail-cover" src={coverUrl} alt="" draggable={false} />
          ) : (
            <div className="sp-album-detail-cover sp-album-card-cover-fallback" />
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

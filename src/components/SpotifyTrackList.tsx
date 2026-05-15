import { useCallback, useEffect, useRef } from 'react';
import type { SpotifyImage, SpotifyPlaylist, SpotifyTrack } from '../spotify/types';

interface Props {
  playlist: SpotifyPlaylist | null;
  tracks: SpotifyTrack[];
  loading: boolean;
  currentlyPlayingId: string | null;
  onPlay: (track: SpotifyTrack, contextUri: string) => void;
  onLoadMore: () => void;
  hasMore: boolean;
}

function smallestImage(images: SpotifyImage[]): string | undefined {
  if (!images || images.length === 0) return undefined;
  return images[images.length - 1]?.url;
}

function formatDuration(ms: number): string {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function SpotifyTrackList({
  playlist,
  tracks,
  loading,
  currentlyPlayingId,
  onPlay,
  onLoadMore,
  hasMore,
}: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-load more tracks when the user scrolls near the bottom.
  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el || loading || !hasMore) return;
    const threshold = 300; // px from bottom
    if (el.scrollHeight - el.scrollTop - el.clientHeight < threshold) {
      onLoadMore();
    }
  }, [loading, hasMore, onLoadMore]);

  // Also re-check after the track list changes — sometimes the container
  // is too tall to need scrolling so the user can't trigger more loads.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || loading || !hasMore) return;
    if (el.scrollHeight <= el.clientHeight + 50) {
      onLoadMore();
    }
  }, [tracks.length, loading, hasMore, onLoadMore]);

  if (playlist === null) {
    return (
      <div className="sp-empty-state">
        <div className="sp-empty-title">Pick a playlist</div>
        <div className="sp-empty-sub">
          Choose one from the sidebar to see its tracks.
        </div>
      </div>
    );
  }

  const coverUrl = playlist.images[0]?.url;

  return (
    <div className="sp-track-view">
      <header className="sp-track-header">
        {coverUrl ? (
          <img
            className="sp-track-header-cover"
            src={coverUrl}
            alt=""
            loading="lazy"
            draggable={false}
          />
        ) : (
          <div className="sp-track-header-cover sp-track-header-cover-fallback" />
        )}
        <div className="sp-track-header-text">
          <div className="sp-track-header-eyebrow">Playlist</div>
          <h1 className="sp-track-header-title">{playlist.name}</h1>
          {playlist.description ? (
            <div className="sp-track-header-desc">{playlist.description}</div>
          ) : null}
          <div className="sp-track-header-meta">
            {playlist.owner.display_name ?? playlist.owner.id} ·{' '}
            {playlist.tracks.total} tracks
          </div>
        </div>
      </header>

      {loading && tracks.length === 0 ? (
        <div className="sp-empty-state">
          <div className="sp-empty-sub">Loading tracks…</div>
        </div>
      ) : tracks.length === 0 ? (
        <div className="sp-empty-state">
          <div className="sp-empty-sub">No tracks in this playlist.</div>
        </div>
      ) : (
        <div className="sp-track-scroll" ref={scrollRef} onScroll={handleScroll}>
        <table className="sp-track-table">
          <thead>
            <tr>
              <th>#</th>
              <th>Title</th>
              <th>Album</th>
              <th className="sp-track-duration">Duration</th>
            </tr>
          </thead>
          <tbody>
            {tracks.map((track, index) => {
              const isPlaying = track.id === currentlyPlayingId;
              const thumbUrl = smallestImage(track.album.images);
              const artistNames = track.artists.map((a) => a.name).join(', ');
              return (
                <tr
                  key={`${track.id}-${index}`}
                  className="sp-track-row"
                  data-playing={isPlaying ? 'true' : 'false'}
                  onClick={() => onPlay(track, playlist.uri)}
                >
                  <td className="sp-track-index">
                    {isPlaying ? (
                      <span className="sp-track-playing-icon">♫</span>
                    ) : (
                      index + 1
                    )}
                  </td>
                  <td className="sp-track-title-cell">
                    {thumbUrl ? (
                      <img
                        className="sp-track-thumb"
                        src={thumbUrl}
                        alt=""
                        loading="lazy"
                        draggable={false}
                      />
                    ) : (
                      <div className="sp-track-thumb sp-track-thumb-fallback" />
                    )}
                    <div className="sp-track-text">
                      <div className="sp-track-name">{track.name}</div>
                      <div className="sp-track-artists">
                        {track.explicit ? (
                          <span className="sp-track-explicit">E</span>
                        ) : null}
                        {artistNames}
                      </div>
                    </div>
                  </td>
                  <td className="sp-track-album">{track.album.name}</td>
                  <td className="sp-track-duration">
                    {formatDuration(track.duration_ms)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {loading && tracks.length > 0 && (
          <div className="sp-track-loading-more">Loading more tracks…</div>
        )}
        {!hasMore && tracks.length > 0 && (
          <div className="sp-track-loading-more sp-track-end">— end of playlist —</div>
        )}
        </div>
      )}
    </div>
  );
}

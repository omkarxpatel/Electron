import { useEffect, useState } from 'react';
import { getQueue } from '../spotify/api';
import type { SpotifyTrack } from '../spotify/types';
import { formatDuration } from '../shared/format';
import { smallestImage } from '../shared/image';

interface Props {
  onPlay: (track: SpotifyTrack) => void;
  currentlyPlayingId: string | null;
  /** Bumped by the parent whenever the panel opens — refetches the queue
   *  so we always show current state when the user pops the panel open. */
  refreshKey: number;
}

interface QueueState {
  currently_playing: SpotifyTrack | null;
  queue: SpotifyTrack[];
}

export function SpotifyQueue({ onPlay, currentlyPlayingId, refreshKey }: Props) {
  const [data, setData] = useState<QueueState | null>(null);
  const [loading, setLoading] = useState<boolean>(true);

  // Re-fetch whenever the panel re-opens or the currently-playing track changes.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getQueue()
      .then((res) => {
        if (cancelled) return;
        if (!res) {
          setData({ currently_playing: null, queue: [] });
        } else {
          setData({
            currently_playing: res.currently_playing,
            queue: res.queue ?? [],
          });
        }
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        console.error('getQueue failed:', err);
        setData({ currently_playing: null, queue: [] });
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [refreshKey, currentlyPlayingId]);

  if (loading && !data) {
    return (
      <div className="sp-empty-state">
        <div className="sp-empty-sub">Loading queue…</div>
      </div>
    );
  }

  const upNext = data?.queue ?? [];
  const nowPlaying = data?.currently_playing ?? null;

  return (
    <div className="sp-queue-view">
      {nowPlaying && (
        <section className="sp-queue-section">
          <h3 className="sp-queue-heading">Now Playing</h3>
          <QueueRow track={nowPlaying} highlight onClick={undefined} />
        </section>
      )}
      <section className="sp-queue-section">
        <h3 className="sp-queue-heading">
          Up Next {upNext.length > 0 ? <span className="sp-queue-count">({upNext.length})</span> : null}
        </h3>
        {upNext.length === 0 ? (
          <div className="sp-empty-sub">Nothing queued.</div>
        ) : (
          <ul className="sp-queue-list">
            {upNext.map((track, index) => (
              <li key={`${track.id}-${index}`}>
                <QueueRow
                  track={track}
                  highlight={track.id === currentlyPlayingId}
                  onClick={() => onPlay(track)}
                />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

interface QueueRowProps {
  track: SpotifyTrack;
  highlight: boolean;
  onClick: (() => void) | undefined;
}

function QueueRow({ track, highlight, onClick }: QueueRowProps) {
  const thumb = smallestImage(track.album?.images);
  const artistNames = track.artists.map((a) => a.name).join(', ');
  return (
    <button
      type="button"
      className="sp-queue-row"
      data-playing={highlight ? 'true' : 'false'}
      onClick={onClick}
      disabled={!onClick}
    >
      {thumb ? (
        <img className="sp-track-thumb" src={thumb} alt="" loading="lazy" draggable={false} />
      ) : (
        <div className="sp-track-thumb sp-track-thumb-fallback" />
      )}
      <div className="sp-track-text">
        <div className="sp-track-name">{track.name}</div>
        <div className="sp-track-artists">
          {track.explicit ? <span className="sp-track-explicit">E</span> : null}
          {artistNames}
        </div>
      </div>
      <div className="sp-queue-duration">{formatDuration(track.duration_ms)}</div>
    </button>
  );
}

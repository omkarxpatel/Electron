import { useCallback, useEffect, useState } from 'react';
import { getQueue, invalidateQueueCache, QUEUE_CHANGED_EVENT, wasUserQueued } from '../spotify/api';
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
  // Bumped to trigger a refetch from inside this component — used by the
  // window-level QUEUE_CHANGED event listener so adding a track from the
  // playlist updates the open queue panel without a full close/reopen.
  const [eventTick, setEventTick] = useState<number>(0);

  // Re-fetch whenever the panel re-opens, the currently-playing track
  // changes, or a queue mutation happens elsewhere in the app.
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
  }, [refreshKey, currentlyPlayingId, eventTick]);

  // Listen for in-app queue mutations. Spotify takes a moment to reflect a
  // POST /queue in the GET response, so we invalidate the cache and refetch
  // after a short delay rather than immediately.
  const bumpEventTick = useCallback(() => {
    invalidateQueueCache();
    window.setTimeout(() => setEventTick((n) => n + 1), 400);
  }, []);
  useEffect(() => {
    window.addEventListener(QUEUE_CHANGED_EVENT, bumpEventTick);
    return () => window.removeEventListener(QUEUE_CHANGED_EVENT, bumpEventTick);
  }, [bumpEventTick]);

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
                  source={wasUserQueued(track.uri) ? 'queued' : 'auto'}
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

type QueueRowSource = 'queued' | 'auto' | null;

interface QueueRowProps {
  track: SpotifyTrack;
  highlight: boolean;
  /** Where this row came from:
   *    'queued' = added to queue via this app (badge)
   *    'auto'   = context continuation (label)
   *    null     = no badge (e.g. now-playing row) */
  source?: QueueRowSource;
  onClick: (() => void) | undefined;
}

function QueueRow({ track, highlight, source = null, onClick }: QueueRowProps) {
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
      {source === 'queued' && (
        <span className="sp-queue-badge sp-queue-badge-queued" title="Added to queue from this app">
          Queued
        </span>
      )}
      {source === 'auto' && (
        <span className="sp-queue-badge sp-queue-badge-auto" title="Auto-continuation from the playing context">
          Auto
        </span>
      )}
      <div className="sp-queue-duration">{formatDuration(track.duration_ms)}</div>
    </button>
  );
}

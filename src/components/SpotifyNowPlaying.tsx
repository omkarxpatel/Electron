import { useEffect, useRef, useState } from 'react';
import type { SpotifyPlaybackState, SpotifyImage } from '../spotify/types';

interface Props {
  playback: SpotifyPlaybackState | null;
  togglePlay: () => void;
  next: () => void;
  previous: () => void;
  seek: (ms: number) => void;
  setVolume: (percent: number) => void;
  signOut: () => void;
  reconnect: () => void;
}

function formatTime(ms: number): string {
  const t = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(t / 60);
  const s = t % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function pickSmallestImage(images: SpotifyImage[]): SpotifyImage | null {
  if (!images || images.length === 0) return null;
  let smallest: SpotifyImage = images[0];
  let smallestArea = Number.POSITIVE_INFINITY;
  for (const img of images) {
    const w = img.width ?? Number.POSITIVE_INFINITY;
    const h = img.height ?? Number.POSITIVE_INFINITY;
    const area = w * h;
    if (area < smallestArea) {
      smallestArea = area;
      smallest = img;
    }
  }
  return smallest;
}

export function SpotifyNowPlaying({
  playback,
  togglePlay,
  next,
  previous,
  seek,
  setVolume,
  signOut,
  reconnect,
}: Props) {
  const duration = playback?.item?.duration_ms ?? 0;

  const [localProgress, setLocalProgress] = useState<number>(playback?.progress_ms ?? 0);
  const [dragging, setDragging] = useState<boolean>(false);

  /* Volume slider runs uncontrolled to avoid React re-rendering this whole
   * component (album art, progress bar, transport icons) on every pointer
   * move. We sync the DOM `value` + `--fill` style directly from polling. */
  const volumeInputRef = useRef<HTMLInputElement>(null);
  const volumeDraggingRef = useRef<boolean>(false);

  useEffect(() => {
    if (!dragging && playback?.progress_ms != null) {
      setLocalProgress(Math.min(playback.progress_ms, duration || playback.progress_ms));
    }
  }, [playback?.progress_ms, dragging, duration]);

  useEffect(() => {
    if (volumeDraggingRef.current) return;
    const v = playback?.device?.volume_percent;
    if (v == null) return;
    const input = volumeInputRef.current;
    if (!input) return;
    input.value = String(v);
    input.style.setProperty('--fill', `${v}%`);
  }, [playback?.device?.volume_percent]);

  useEffect(() => {
    if (!playback?.is_playing) return;
    const interval = setInterval(() => {
      setLocalProgress((p) => (dragging ? p : Math.min(p + 100, duration || p + 100)));
    }, 100);
    return () => clearInterval(interval);
  }, [playback?.is_playing, duration, dragging]);

  const track = playback?.item ?? null;
  const albumImage = track ? pickSmallestImage(track.album.images) : null;

  const commitSeek = (): void => {
    seek(localProgress);
    setDragging(false);
  };

  const onVolumeInput = (e: React.ChangeEvent<HTMLInputElement>): void => {
    volumeDraggingRef.current = true;
    e.currentTarget.style.setProperty('--fill', `${e.currentTarget.value}%`);
  };

  const commitVolume = (e: React.SyntheticEvent<HTMLInputElement>): void => {
    const v = Number(e.currentTarget.value);
    setVolume(v);
    volumeDraggingRef.current = false;
  };

  const progressPercent = duration > 0 ? (Math.min(localProgress, duration) / duration) * 100 : 0;

  return (
    <footer className="sp-player-bar">
      <div className="sp-player-left">
        {albumImage ? (
          <img className="sp-player-art" src={albumImage.url} alt="" />
        ) : (
          <div className="sp-player-art sp-player-art-fallback" />
        )}
        <div>
          <div className="sp-player-track">{track?.name ?? '—'}</div>
          <div className="sp-player-artist">
            {track ? track.artists.map((a) => a.name).join(', ') : ''}
          </div>
        </div>
      </div>

      <div className="sp-player-center">
        <div className="sp-player-buttons">
          <button
            type="button"
            className="sp-icon-btn"
            onClick={previous}
            aria-label="Previous"
          >
            ⏮
          </button>
          <button
            type="button"
            className="sp-icon-btn sp-icon-btn-primary"
            onClick={togglePlay}
            aria-label="Play/Pause"
          >
            {playback?.is_playing ? '⏸' : '▶'}
          </button>
          <button
            type="button"
            className="sp-icon-btn"
            onClick={next}
            aria-label="Next"
          >
            ⏭
          </button>
        </div>
        <div className="sp-player-progress">
          <span className="sp-time">{formatTime(localProgress)}</span>
          <input
            type="range"
            className="sp-progress-input"
            min={0}
            max={duration}
            value={Math.min(localProgress, duration)}
            step={1000}
            disabled={!track}
            style={{ ['--fill' as string]: `${progressPercent}%` }}
            onChange={(e) => {
              setDragging(true);
              setLocalProgress(Number(e.target.value));
            }}
            onMouseUp={commitSeek}
            onTouchEnd={commitSeek}
            onKeyUp={commitSeek}
          />
          <span className="sp-time">{formatTime(duration)}</span>
        </div>
      </div>

      <div className="sp-player-right">
        <input
          ref={volumeInputRef}
          type="range"
          className="sp-volume-input"
          min={0}
          max={100}
          defaultValue={playback?.device?.volume_percent ?? 50}
          style={{ ['--fill' as string]: `${playback?.device?.volume_percent ?? 50}%` }}
          onChange={onVolumeInput}
          onMouseUp={commitVolume}
          onTouchEnd={commitVolume}
          onKeyUp={commitVolume}
          aria-label="Volume"
        />
        <button
          type="button"
          className="sp-icon-btn sp-icon-btn-small"
          onClick={reconnect}
          aria-label="Reconnect to Spotify"
          title="Reconnect — re-trigger Spotify OAuth (use if playlists fail to load)"
        >
          ↻
        </button>
        <button
          type="button"
          className="sp-icon-btn sp-icon-btn-small"
          onClick={signOut}
          aria-label="Sign out of Spotify"
          title="Sign out"
        >
          ⏏
        </button>
      </div>
    </footer>
  );
}

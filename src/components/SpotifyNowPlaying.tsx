import { memo, useEffect, useRef } from 'react';
import { useRenderCount } from '../perf';
import type { SpotifyPlaybackState, SpotifyImage } from '../spotify/types';

interface Props {
  playback: SpotifyPlaybackState | null;
  togglePlay: () => void;
  next: () => void;
  previous: () => void;
  seek: (ms: number) => void;
  setVolume: (percent: number) => void;
  toggleShuffle: () => void;
  cycleRepeat: () => void;
  toggleSaveCurrent: () => void;
  savedCurrent: boolean | null;
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

// Past this many ms into a track, a single Previous click restarts the track
// rather than going back. A second click within DOUBLE_CLICK_MS overrides.
const RESTART_THRESHOLD_MS = 3000;
const DOUBLE_CLICK_MS = 400;
// Ignore polling for this long after a commit so the slider doesn't snap to a
// stale value while Spotify catches up.
const POLL_LOCKOUT_MS = 1100;

export const SpotifyNowPlaying = memo(SpotifyNowPlayingImpl);

function SpotifyNowPlayingImpl({
  playback,
  togglePlay,
  next,
  previous,
  seek,
  setVolume,
  toggleShuffle,
  cycleRepeat,
  toggleSaveCurrent,
  savedCurrent,
}: Props) {
  useRenderCount('SpotifyNowPlaying');
  const duration = playback?.item?.duration_ms ?? 0;
  const isPlaying = !!playback?.is_playing;

  /* ── Progress slider runs UNCONTROLLED, same pattern as the volume slider.
   *    The progress ms is stored in a ref; a RAF loop (only while playing)
   *    mutates the input's value + the elapsed-time text + the --fill CSS var
   *    directly on the DOM. No React render per tick → no cascading re-renders
   *    on the rest of the player bar (album art, transport buttons, etc.). */
  const progressInputRef = useRef<HTMLInputElement>(null);
  const elapsedTimeRef = useRef<HTMLSpanElement>(null);
  const localProgressRef = useRef<number>(playback?.progress_ms ?? 0);
  const draggingRef = useRef<boolean>(false);
  const seekLockUntilRef = useRef<number>(0);
  const lastPrevClickRef = useRef<number>(0);

  /* Volume slider — also uncontrolled. */
  const volumeInputRef = useRef<HTMLInputElement>(null);
  const volumePercentRef = useRef<HTMLSpanElement>(null);
  const volumeDraggingRef = useRef<boolean>(false);
  const volumeLockUntilRef = useRef<number>(0);

  // Apply a progress value to the slider DOM. Called by both the RAF loop and
  // the poll-sync effect; centralizing here means the rules (max clamp, fill,
  // text) live in one place.
  const applyProgressToDom = (ms: number): void => {
    localProgressRef.current = ms;
    const clamped = duration > 0 ? Math.min(ms, duration) : ms;
    const input = progressInputRef.current;
    if (input) {
      input.value = String(clamped);
      const pct = duration > 0 ? (clamped / duration) * 100 : 0;
      input.style.setProperty('--fill', `${pct}%`);
    }
    if (elapsedTimeRef.current) {
      elapsedTimeRef.current.textContent = formatTime(clamped);
    }
  };

  // Sync to authoritative poll value unless dragging or just-after-seek.
  useEffect(() => {
    if (draggingRef.current) return;
    if (Date.now() < seekLockUntilRef.current) return;
    if (playback?.progress_ms != null) {
      applyProgressToDom(playback.progress_ms);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playback?.progress_ms, duration]);

  // RAF-driven progress tick. Wakes ~60 Hz while playing; reads/writes DOM
  // directly with zero React state changes. Auto-suspends when paused.
  useEffect(() => {
    if (!isPlaying) return;
    let rafId = 0;
    let lastTick = performance.now();
    const tick = () => {
      rafId = requestAnimationFrame(tick);
      const now = performance.now();
      const dt = now - lastTick;
      lastTick = now;
      if (draggingRef.current) return;
      if (Date.now() < seekLockUntilRef.current) return;
      const max = duration > 0 ? duration : localProgressRef.current + dt;
      const next = Math.min(localProgressRef.current + dt, max);
      applyProgressToDom(next);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPlaying, duration]);

  // Volume poll-sync (unchanged behavior).
  useEffect(() => {
    if (volumeDraggingRef.current) return;
    if (Date.now() < volumeLockUntilRef.current) return;
    const v = playback?.device?.volume_percent;
    if (v == null) return;
    const input = volumeInputRef.current;
    if (input) {
      input.value = String(v);
      input.style.setProperty('--fill', `${v}%`);
    }
    if (volumePercentRef.current) {
      volumePercentRef.current.textContent = `${v}%`;
    }
  }, [playback?.device?.volume_percent]);

  const track = playback?.item ?? null;
  const albumImage = track ? pickSmallestImage(track.album.images) : null;
  const currentVolume = playback?.device?.volume_percent ?? 50;

  const commitSeek = (): void => {
    const v = Number(progressInputRef.current?.value ?? localProgressRef.current);
    seekLockUntilRef.current = Date.now() + POLL_LOCKOUT_MS;
    seek(v);
    localProgressRef.current = v;
    draggingRef.current = false;
  };

  const onProgressInput = (e: React.ChangeEvent<HTMLInputElement>): void => {
    draggingRef.current = true;
    const v = Number(e.currentTarget.value);
    const pct = duration > 0 ? (Math.min(v, duration) / duration) * 100 : 0;
    e.currentTarget.style.setProperty('--fill', `${pct}%`);
    if (elapsedTimeRef.current) {
      elapsedTimeRef.current.textContent = formatTime(v);
    }
  };

  /** Smart previous: past 3s and single-clicked → restart current track.
   *  In first 3s OR double-clicked → go to previous track. */
  const handlePrevious = (): void => {
    const now = Date.now();
    const isDoubleClick = now - lastPrevClickRef.current < DOUBLE_CLICK_MS;
    lastPrevClickRef.current = now;
    const currentMs = localProgressRef.current;
    if (isDoubleClick || currentMs <= RESTART_THRESHOLD_MS) {
      previous();
    } else {
      seekLockUntilRef.current = Date.now() + POLL_LOCKOUT_MS;
      seek(0);
      applyProgressToDom(0);
    }
  };

  const onVolumeInput = (e: React.ChangeEvent<HTMLInputElement>): void => {
    volumeDraggingRef.current = true;
    const v = Number(e.currentTarget.value);
    e.currentTarget.style.setProperty('--fill', `${v}%`);
    if (volumePercentRef.current) {
      volumePercentRef.current.textContent = `${v}%`;
    }
  };

  const commitVolume = (e: React.SyntheticEvent<HTMLInputElement>): void => {
    const v = Number(e.currentTarget.value);
    volumeLockUntilRef.current = Date.now() + POLL_LOCKOUT_MS;
    setVolume(v);
    volumeDraggingRef.current = false;
  };

  const initialProgress = playback?.progress_ms ?? 0;
  const initialFillPct = duration > 0 ? (Math.min(initialProgress, duration) / duration) * 100 : 0;

  return (
    <footer className="sp-player-bar">
      <div className="sp-player-left">
        {albumImage ? (
          <img className="sp-player-art" src={albumImage.url} alt="" />
        ) : (
          <div className="sp-player-art sp-player-art-fallback" />
        )}
        <div className="sp-player-info">
          <div className="sp-player-track">{track?.name ?? '—'}</div>
          <div className="sp-player-artist">
            {track ? track.artists.map((a) => a.name).join(', ') : ''}
          </div>
        </div>
        <button
          type="button"
          className="sp-icon-btn sp-icon-btn-heart"
          onClick={toggleSaveCurrent}
          disabled={!track || savedCurrent === null}
          aria-label={savedCurrent ? 'Remove from Liked Songs' : 'Save to Liked Songs'}
          aria-pressed={!!savedCurrent}
          title={savedCurrent ? 'Remove from Liked Songs' : 'Save to Liked Songs'}
          data-active={savedCurrent ? 'true' : 'false'}
        >
          <IconHeart filled={!!savedCurrent} />
        </button>
      </div>

      <div className="sp-player-center">
        <div className="sp-player-buttons">
          <button
            type="button"
            className="sp-icon-btn sp-icon-btn-toggle"
            onClick={toggleShuffle}
            disabled={!playback}
            aria-label="Shuffle"
            aria-pressed={!!playback?.shuffle_state}
            title={playback?.shuffle_state ? 'Shuffle on' : 'Shuffle off'}
            data-active={playback?.shuffle_state ? 'true' : 'false'}
          >
            <IconShuffle />
          </button>
          <button
            type="button"
            className="sp-icon-btn"
            onClick={handlePrevious}
            aria-label="Previous"
            title="Single-click past 3s restarts the track. Double-click or click within 3s goes to the previous track."
          >
            <IconPrev />
          </button>
          <button
            type="button"
            className="sp-icon-btn sp-icon-btn-primary"
            onClick={togglePlay}
            aria-label="Play/Pause"
          >
            {playback?.is_playing ? <IconPause /> : <IconPlay />}
          </button>
          <button
            type="button"
            className="sp-icon-btn"
            onClick={next}
            aria-label="Next"
            title="Next track"
          >
            <IconNext />
          </button>
          <button
            type="button"
            className="sp-icon-btn sp-icon-btn-toggle"
            onClick={cycleRepeat}
            disabled={!playback}
            aria-label="Repeat"
            title={
              playback?.repeat_state === 'track'
                ? 'Repeat: this track'
                : playback?.repeat_state === 'context'
                  ? 'Repeat: queue'
                  : 'Repeat off'
            }
            data-active={
              playback?.repeat_state && playback.repeat_state !== 'off' ? 'true' : 'false'
            }
          >
            <IconRepeat mode={playback?.repeat_state ?? 'off'} />
          </button>
        </div>
        <div className="sp-player-progress">
          <span ref={elapsedTimeRef} className="sp-time">
            {formatTime(initialProgress)}
          </span>
          <input
            ref={progressInputRef}
            type="range"
            className="sp-progress-input"
            min={0}
            max={duration}
            defaultValue={initialProgress}
            step={1000}
            disabled={!track}
            style={{ ['--fill' as string]: `${initialFillPct}%` }}
            onChange={onProgressInput}
            onMouseUp={commitSeek}
            onTouchEnd={commitSeek}
            onKeyUp={commitSeek}
          />
          <span className="sp-time">{formatTime(duration)}</span>
        </div>
      </div>

      <div className="sp-player-right">
        <span className="sp-volume-icon" aria-hidden>
          <IconVolume mute={currentVolume === 0} />
        </span>
        <input
          ref={volumeInputRef}
          type="range"
          className="sp-volume-input"
          min={0}
          max={100}
          defaultValue={currentVolume}
          style={{ ['--fill' as string]: `${currentVolume}%` }}
          onChange={onVolumeInput}
          onMouseUp={commitVolume}
          onTouchEnd={commitVolume}
          onKeyUp={commitVolume}
          aria-label="Volume"
        />
        <span ref={volumePercentRef} className="sp-volume-percent">
          {currentVolume}%
        </span>
      </div>
    </footer>
  );
}

/* ────────────────────────────────────────────────────────────────
   Inline SVG icons — bigger and crisper than the Unicode glyphs
   that were here before, and they inherit `currentColor` so the
   palette accent applies cleanly via CSS.
   ──────────────────────────────────────────────────────────────── */

function IconPlay() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M7 5.14v13.72c0 .79.87 1.27 1.54.85l10.8-6.86c.62-.4.62-1.31 0-1.71L8.54 4.29C7.87 3.87 7 4.35 7 5.14z" />
    </svg>
  );
}

function IconPause() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <rect x="6" y="5" width="4" height="14" rx="1" />
      <rect x="14" y="5" width="4" height="14" rx="1" />
    </svg>
  );
}

function IconPrev() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M6 6h2v12H6z" />
      <path d="M20 5.14v13.72c0 .79-.87 1.27-1.54.85L9.66 13.85a1 1 0 010-1.7l8.8-5.86c.67-.42 1.54.06 1.54.85z" />
    </svg>
  );
}

function IconNext() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M16 6h2v12h-2z" />
      <path d="M4 5.14v13.72c0 .79.87 1.27 1.54.85l8.8-5.86a1 1 0 000-1.7l-8.8-5.86C4.87 3.87 4 4.35 4 5.14z" />
    </svg>
  );
}

function IconHeart({ filled }: { filled: boolean }) {
  if (filled) {
    return (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
        <path d="M12 21s-7.5-4.6-9.5-9.5C1 7.5 4 4 7.5 4c1.9 0 3.5 1 4.5 2.5C13 5 14.6 4 16.5 4 20 4 23 7.5 21.5 11.5 19.5 16.4 12 21 12 21z" />
      </svg>
    );
  }
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" aria-hidden>
      <path d="M12 21s-7.5-4.6-9.5-9.5C1 7.5 4 4 7.5 4c1.9 0 3.5 1 4.5 2.5C13 5 14.6 4 16.5 4 20 4 23 7.5 21.5 11.5 19.5 16.4 12 21 12 21z" />
    </svg>
  );
}

function IconShuffle() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M16 4l4 4-4 4" />
      <path d="M20 8H17.5c-2 0-3.4 1-4.5 2.5L10.5 14c-1.1 1.5-2.5 2.5-4.5 2.5H4" />
      <path d="M4 8h2c2 0 3.4 1 4.5 2.5" />
      <path d="M13.5 14c1.1 1.5 2.5 2.5 4.5 2.5h2" />
      <path d="M16 20l4-4-4-4" />
    </svg>
  );
}

function IconRepeat({ mode }: { mode: 'off' | 'track' | 'context' }) {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M17 2l3 3-3 3" />
      <path d="M3 11V9a4 4 0 014-4h13" />
      <path d="M7 22l-3-3 3-3" />
      <path d="M21 13v2a4 4 0 01-4 4H4" />
      {mode === 'track' ? (
        <text x="12" y="14.5" textAnchor="middle" fontSize="7" fontWeight="700" fill="currentColor" stroke="none">1</text>
      ) : null}
    </svg>
  );
}

function IconVolume({ mute }: { mute: boolean }) {
  if (mute) {
    return (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
        <path d="M3 9v6h4l5 5V4L7 9H3z" />
        <path d="M22.5 12l-2.5 2.5 1.4 1.4L24 13.4 26.4 16l1.4-1.4L25.4 12l2.5-2.5L26.4 8 24 10.6 21.4 8 20 9.5z" transform="translate(-7 0)" />
      </svg>
    );
  }
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M3 9v6h4l5 5V4L7 9H3z" />
      <path
        d="M14 7.5c2 1 3.5 2.6 3.5 4.5s-1.5 3.5-3.5 4.5"
        stroke="currentColor"
        strokeWidth="1.8"
        fill="none"
        strokeLinecap="round"
      />
    </svg>
  );
}

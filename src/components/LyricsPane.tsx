import { useEffect, useMemo, useRef, useState } from 'react';
import { useRenderCount } from '../perf';
import type { SpotifyPlaybackState } from '../spotify/types';
import { useLyrics } from '../lyrics/useLyrics';
import { findCurrentLineIndex, type LyricLine } from '../lyrics/parseLrc';

interface Props {
  playback: SpotifyPlaybackState | null;
  /** When false, the local progress tick is paused (window hidden). */
  active?: boolean;
}

export function LyricsPane({ playback, active = true }: Props) {
  useRenderCount('LyricsPane');
  const track = playback?.item ?? null;
  const title = track?.name ?? null;
  const artist = track?.artists?.[0]?.name ?? null;
  const album = track?.album?.name;
  const durationMs = track?.duration_ms;

  const lyrics = useLyrics(title, artist, album, durationMs);

  if (!track) {
    return (
      <aside className="lyrics-pane">
        <div className="lyrics-empty">Play something to see lyrics</div>
      </aside>
    );
  }
  if (lyrics.instrumental) {
    return (
      <aside className="lyrics-pane">
        <div className="lyrics-empty">~ Instrumental ~</div>
      </aside>
    );
  }
  // Loading with no content yet — show spinner. Once we have ANY content
  // (plain from the fast path, or synced from lrclib), render it; the
  // upgrade from plain→synced happens transparently on the next render.
  const hasContent = lyrics.lines.length > 0 || !!lyrics.plain;
  if (lyrics.loading && !hasContent) {
    return (
      <aside className="lyrics-pane">
        <div className="lyrics-empty">Looking up lyrics…</div>
      </aside>
    );
  }
  if (!lyrics.found || !hasContent) {
    return (
      <aside className="lyrics-pane">
        <div className="lyrics-empty">No lyrics found for this track</div>
      </aside>
    );
  }
  if (lyrics.lines.length === 0) {
    // Plain only (fast path responded, synced hasn't / won't). Render the
    // same line-by-line layout as the synced view so visuals match — just
    // no highlight since we have no timing data.
    // Keying on track.id forces a fresh mount on song change so scrollTop
    // resets to 0 instead of staying where the previous song left off.
    return <PlainLyrics key={track.id} text={lyrics.plain ?? ''} />;
  }
  return (
    <SyncedLyrics
      key={track.id}
      lines={lyrics.lines}
      playback={playback}
      active={active}
    />
  );
}

function PlainLyrics({ text }: { text: string }) {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  return (
    <aside className="lyrics-pane lyrics-pane-synced">
      <div className="lyrics-scroll">
        <div className="lyrics-spacer" aria-hidden />
        {lines.map((line, i) => (
          <div key={i} className="lyrics-line is-near">
            {line}
          </div>
        ))}
        <div className="lyrics-spacer" aria-hidden />
      </div>
    </aside>
  );
}

interface SyncedLyricsProps {
  lines: LyricLine[];
  playback: SpotifyPlaybackState | null;
  active: boolean;
}

/**
 * Synced lyrics renderer. The elapsed-time clock is driven by a RAF loop
 * reading a ref — NOT a setInterval-driven React state. We only re-render
 * when the *current line index changes*, not on every 100 ms tick. This
 * collapses ~10 renders/sec into ~one render every few seconds (when the
 * highlighted line moves), eliminating a major source of main-thread work.
 */
function SyncedLyrics({ lines, playback, active }: SyncedLyricsProps) {
  // Precompute line start times in seconds — saves recomputing in the RAF loop.
  const startTimes = useMemo(() => {
    const out = new Float64Array(lines.length);
    // parseLrc returns LyricLine.time in seconds already.
    for (let i = 0; i < lines.length; i++) out[i] = lines[i].time;
    return out;
  }, [lines]);

  // Authoritative anchor from Spotify polling. Each poll updates these refs;
  // the RAF loop reads from them. No React render on poll.
  const anchorElapsedMsRef = useRef<number>(playback?.progress_ms ?? 0);
  const anchorReceivedAtRef = useRef<number>(performance.now());
  const isPlayingRef = useRef<boolean>(playback?.is_playing ?? false);

  useEffect(() => {
    if (playback?.progress_ms != null) {
      anchorElapsedMsRef.current = playback.progress_ms;
      anchorReceivedAtRef.current = performance.now();
    }
    isPlayingRef.current = playback?.is_playing ?? false;
  }, [playback?.progress_ms, playback?.is_playing]);

  // The ONLY piece of React state — the current line index. Updates roughly
  // once per lyric line (a few times per minute, not 10 times per second).
  const [currentIdx, setCurrentIdx] = useState<number>(-1);
  const containerRef = useRef<HTMLDivElement>(null);
  const currentIdxRef = useRef<number>(-1);

  // RAF loop: compute elapsed time from anchor + wall clock, find the current
  // line, only setState if the index changed. Throttled to ~10 Hz — lyric
  // resolution is in seconds, checking 60 ×/sec is wasted work.
  useEffect(() => {
    if (!active) return;
    let rafId = 0;
    let last = 0;
    const tick = (now: number) => {
      rafId = requestAnimationFrame(tick);
      if (now - last < 100) return;
      last = now;
      const anchor = anchorElapsedMsRef.current;
      const since = isPlayingRef.current ? performance.now() - anchorReceivedAtRef.current : 0;
      const elapsedSec = (anchor + since) / 1000;
      const idx = findCurrentLineIndexFromArray(startTimes, elapsedSec);
      if (idx !== currentIdxRef.current) {
        currentIdxRef.current = idx;
        setCurrentIdx(idx);
      }
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [active, startTimes]);

  // Scroll the current line into the vertical center of the pane on change.
  useEffect(() => {
    if (currentIdx < 0) return;
    const el = containerRef.current?.querySelector<HTMLDivElement>(
      `[data-line="${currentIdx}"]`,
    );
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [currentIdx]);

  return (
    <aside className="lyrics-pane lyrics-pane-synced" ref={containerRef}>
      <div className="lyrics-scroll">
        <div className="lyrics-spacer" aria-hidden />
        {lines.map((line, i) => {
          const distance = i - currentIdx;
          const isCurrent = distance === 0;
          // Two lines either side stay legible; further lines fade.
          let cls = 'lyrics-line';
          if (isCurrent) cls += ' is-current';
          else if (Math.abs(distance) <= 2) cls += ' is-near';
          else cls += ' is-far';
          return (
            <div key={i} data-line={i} className={cls}>
              {line.text}
            </div>
          );
        })}
        <div className="lyrics-spacer" aria-hidden />
      </div>
    </aside>
  );
}

/** Pre-sorted-array variant of findCurrentLineIndex — operates on the
 *  Float64Array of cached start times to avoid recomputing each tick. */
function findCurrentLineIndexFromArray(starts: Float64Array, elapsedSec: number): number {
  if (starts.length === 0) return -1;
  if (elapsedSec < starts[0]) return -1;
  // Linear scan — lyric counts are small (<200), and starts are sorted.
  let idx = -1;
  for (let i = 0; i < starts.length; i++) {
    if (starts[i] <= elapsedSec) idx = i;
    else break;
  }
  return idx;
}

// Re-export so consumers don't import the unused-original from the lyrics module.
export { findCurrentLineIndex };

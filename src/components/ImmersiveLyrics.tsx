import { useEffect, useRef, useState } from 'react';
import { usePlayback } from '../spotify/SpotifyProvider';
import { useLyrics } from '../lyrics/useLyrics';
import { findCurrentLineIndex } from '../lyrics/parseLrc';

/**
 * One line of synced lyrics, floated over the visualizer in immersive mode.
 *
 * Deliberately minimal: no panel, no scrollback, no next-line preview. The
 * point of visuals-only mode is the visual, so this is an accent on it rather
 * than a second thing to read. Renders nothing at all unless time-synced
 * lyrics exist — plain unsynced text has no line to be "current", and dumping
 * a paragraph over the stage would defeat the purpose.
 *
 * Clock handling mirrors LyricsPane: Spotify's `progress_ms` only arrives on
 * the 1.5s poll, so it's used as an anchor and wall-clock time is added on top
 * to interpolate between polls. Without that, lines would step in 1.5s jumps.
 */

interface Props {
  /** Paused when the window is hidden. */
  active: boolean;
}

export function ImmersiveLyrics({ active }: Props) {
  const { playback } = usePlayback();
  const track = playback?.item ?? null;
  const lyrics = useLyrics(
    track?.name ?? null,
    track?.artists?.[0]?.name ?? null,
    track?.album?.name,
    track?.duration_ms,
  );

  const lines = lyrics.lines;

  const [idx, setIdx] = useState(-1);
  const idxRef = useRef(-1);

  // Anchor + wall clock, re-synced on every poll.
  const anchorMsRef = useRef(playback?.progress_ms ?? 0);
  const anchorAtRef = useRef(performance.now());
  const playingRef = useRef(!!playback?.is_playing);

  useEffect(() => {
    if (playback?.progress_ms != null) {
      anchorMsRef.current = playback.progress_ms;
      anchorAtRef.current = performance.now();
    }
    playingRef.current = !!playback?.is_playing;
  }, [playback?.progress_ms, playback?.is_playing]);

  useEffect(() => {
    if (!active || lines.length === 0) {
      setIdx(-1);
      idxRef.current = -1;
      return;
    }
    let raf = 0;
    let last = 0;
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      // Lyric resolution is in seconds; 10 Hz is plenty and keeps this off
      // the frame budget the visualizer is using.
      if (now - last < 100) return;
      last = now;
      const since = playingRef.current ? performance.now() - anchorAtRef.current : 0;
      const next = findCurrentLineIndex(lines, (anchorMsRef.current + since) / 1000);
      if (next !== idxRef.current) {
        idxRef.current = next;
        setIdx(next);
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [active, lines]);

  const text = idx >= 0 ? (lines[idx]?.text?.trim() ?? '') : '';

  // A line has to outlive its own replacement to fade out. React swaps the
  // node the instant `idx` changes, so the outgoing text is parked here and
  // rendered alongside the incoming one until its animation finishes. Gaps
  // between lines go through the same path: `text` becomes '' and the old
  // line still gets to leave rather than blinking off.
  const [shown, setShown] = useState<{ id: number; text: string } | null>(null);
  const [leaving, setLeaving] = useState<{ id: number; text: string } | null>(null);
  const seqRef = useRef(0);

  useEffect(() => {
    setShown((prev) => {
      if (prev?.text === text) return prev;
      if (prev) setLeaving(prev);
      return text ? { id: ++seqRef.current, text } : null;
    });
  }, [text]);

  useEffect(() => {
    if (!leaving) return;
    // Must outlast the fade-out duration in CSS, or the node is pulled
    // mid-animation and the line snaps away instead of dissolving.
    const t = window.setTimeout(() => setLeaving(null), 460);
    return () => window.clearTimeout(t);
  }, [leaving]);

  if (!shown && !leaving) return null;

  return (
    <div className="immersive-lyrics" aria-hidden>
      {leaving && (
        <span key={`out-${leaving.id}`} className="is-leaving">
          {leaving.text}
        </span>
      )}
      {shown && <span key={shown.id}>{shown.text}</span>}
    </div>
  );
}

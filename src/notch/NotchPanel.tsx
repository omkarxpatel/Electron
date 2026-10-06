/**
 * The panel that hangs from the notch on hover.
 *
 * Deliberately dumb: every value it shows arrives over IPC from the main
 * renderer (see src/components/NotchBridge.tsx), and every button sends a
 * command back. It holds no Spotify session and fetches nothing.
 *
 * The two things it DOES own are the two that have to be owned here —
 * progress and the current lyric line. Both need a clock ticking at ~10 Hz,
 * and the main renderer's rAF and timers are throttled to a standstill
 * whenever it is occluded or hidden, which is precisely when this panel is
 * the thing being looked at. Measured: rAF 0/s and timers 1/s behind another
 * window. So the renderer sends anchors (a progress value, a whole lyric
 * track) and the panel interpolates against its own clock.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { NotchCommand, NotchLyricLine, NotchMetrics, NotchState } from '../types/api';

/** Progress + lyric timing refresh. Fast enough that the bar looks continuous
 *  and a lyric lands on the beat; slow enough to be free. */
const TICK_MS = 100;

const DEFAULT_ACCENT = '#6aa9ff';
/** Used when auto-tint is off, or before the first palette lands. */
const DEFAULT_AMBIENT = '#3d5a8a';

function formatTime(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const total = Math.floor(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** Index of the last line whose timestamp has passed, or -1. */
function lineAt(lines: NotchLyricLine[], seconds: number): number {
  let lo = 0;
  let hi = lines.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].time <= seconds) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

export function NotchPanel() {
  const [state, setState] = useState<NotchState | null>(null);
  const [expanded, setExpanded] = useState(false);
  /** 32 is the notched-Mac value; main overrides it with the real one. */
  const [menuBarHeight, setMenuBarHeight] = useState(32);
  const [elapsedMs, setElapsedMs] = useState(0);

  /** Where progress was when the renderer last told us, and when that was on
   *  OUR clock. Everything shown is derived from these two numbers. */
  const anchorRef = useRef({ progressMs: 0, at: 0, isPlaying: false });

  useEffect(() => {
    const api = window.api?.notch;
    if (!api) return;
    const offState = api.onState((next) => {
      setState(next);
      anchorRef.current = {
        progressMs: next?.progressMs ?? 0,
        at: performance.now(),
        isPlaying: next?.isPlaying ?? false,
      };
      setElapsedMs(next?.progressMs ?? 0);
    });
    const offExpanded = api.onExpanded(setExpanded);
    const offMetrics = api.onMetrics((m: NotchMetrics) => setMenuBarHeight(m.menuBarHeight));
    return () => {
      offState();
      offExpanded();
      offMetrics();
    };
  }, []);

  // Only tick while visible. Collapsed, nothing on screen depends on it.
  useEffect(() => {
    if (!expanded) return;
    const id = setInterval(() => {
      const a = anchorRef.current;
      setElapsedMs(a.progressMs + (a.isPlaying ? performance.now() - a.at : 0));
    }, TICK_MS);
    return () => clearInterval(id);
  }, [expanded]);

  const send = useCallback((cmd: NotchCommand) => {
    window.api?.notch?.send(cmd);
  }, []);

  const durationMs = state?.durationMs ?? 0;
  const shownMs = durationMs > 0 ? Math.min(elapsedMs, durationMs) : elapsedMs;
  const pct = durationMs > 0 ? (shownMs / durationMs) * 100 : 0;

  const lyric = useMemo(() => {
    const lines = state?.lyrics;
    if (!lines || lines.length === 0) return null;
    const i = lineAt(lines, shownMs / 1000);
    return i >= 0 ? lines[i].text : null;
    // shownMs changes every tick; lineAt is a binary search over a few
    // hundred entries, which is cheaper than memo bookkeeping would be.
  }, [state?.lyrics, shownMs]);

  const onSeek = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (durationMs <= 0) return;
      const r = e.currentTarget.getBoundingClientRect();
      const ratio = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
      const ms = Math.round(ratio * durationMs);
      // Move the bar immediately. Spotify's next poll is up to 10s away and a
      // bar that snaps back for ten seconds reads as a failed click.
      anchorRef.current = { ...anchorRef.current, progressMs: ms, at: performance.now() };
      setElapsedMs(ms);
      send({ kind: 'seek', ms });
    },
    [durationMs, send],
  );

  const accent = state?.accent || DEFAULT_ACCENT;
  const ambient = state?.ambient || DEFAULT_AMBIENT;

  return (
    <div
      className="notch-root"
      data-expanded={expanded ? 'true' : 'false'}
      style={
        {
          '--notch-accent': accent,
          '--notch-ambient': ambient,
          '--notch-menubar-h': `${menuBarHeight}px`,
        } as React.CSSProperties
      }
    >
      {/* Idle view: a black lozenge in the menu-bar band that reads as the
          notch having grown a lip. Art on one side, level bars on the other;
          the middle is left empty because that is where the camera is. */}
      <div className="notch-idle-pill" aria-hidden="true">
        {state && (
          <>
            {state.artUrl ? (
              <img className="notch-idle-art" src={state.artUrl} alt="" draggable={false} />
            ) : (
              <span className="notch-idle-art notch-idle-art-empty" />
            )}
            <span className="notch-idle-bars" data-playing={state.isPlaying ? 'true' : 'false'}>
              <i />
              <i />
              <i />
            </span>
          </>
        )}
      </div>

      <div className="notch-panel">
        {state ? (
          <>
            <div className="notch-art">
              {state.artUrl ? (
                <img src={state.artUrl} alt="" draggable={false} />
              ) : (
                <div className="notch-art-empty" />
              )}
              <SpotifyBadge />
            </div>

            <div className="notch-info">
              <div className="notch-title" title={state.title}>
                {state.title}
              </div>
              <div className="notch-artist" title={state.artist}>
                {state.artist}
              </div>
              <div className="notch-lyric">{lyric ?? ''}</div>

              <div className="notch-progress" onClick={onSeek} role="presentation">
                <div className="notch-progress-track">
                  <div className="notch-progress-fill" style={{ width: `${pct}%` }} />
                </div>
              </div>

              <div className="notch-times">
                <span>{formatTime(shownMs)}</span>
                <span>{formatTime(durationMs)}</span>
              </div>

              <div className="notch-transport">
                <button
                  className="notch-btn"
                  data-on={state.shuffle ? 'true' : 'false'}
                  onClick={() => send({ kind: 'shuffle' })}
                  aria-label="Shuffle"
                >
                  <ShuffleIcon />
                </button>
                <button
                  className="notch-btn"
                  onClick={() => send({ kind: 'previous' })}
                  aria-label="Previous"
                >
                  <PrevIcon />
                </button>
                <button
                  className="notch-btn notch-btn-play"
                  onClick={() => send({ kind: 'toggle' })}
                  aria-label={state.isPlaying ? 'Pause' : 'Play'}
                >
                  {state.isPlaying ? <PauseIcon /> : <PlayIcon />}
                </button>
                <button
                  className="notch-btn"
                  onClick={() => send({ kind: 'next' })}
                  aria-label="Next"
                >
                  <NextIcon />
                </button>
                <button
                  className="notch-btn notch-btn-heart"
                  data-on={state.saved ? 'true' : 'false'}
                  onClick={() => send({ kind: 'save' })}
                  aria-label={state.saved ? 'Remove from Liked Songs' : 'Save to Liked Songs'}
                >
                  <HeartIcon filled={state.saved === true} />
                </button>
              </div>
            </div>
          </>
        ) : (
          <div className="notch-idle">Nothing playing</div>
        )}
      </div>
    </div>
  );
}

// ── Icons ──────────────────────────────────────────────────────────────────

function SpotifyBadge() {
  return (
    <svg className="notch-badge" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="12" fill="#1DB954" />
      <path
        d="M6.4 9.6c3.4-1 8-0.8 11.1 1.1M7.2 12.6c2.9-0.85 6.7-0.65 9.3 0.95M8 15.4c2.3-0.7 5.2-0.5 7.3 0.75"
        stroke="#000"
        strokeWidth="1.7"
        strokeLinecap="round"
        fill="none"
      />
    </svg>
  );
}

function ShuffleIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M3 6h3.5c1.4 0 2.3.7 3.2 2l4.6 8c.9 1.3 1.8 2 3.2 2H21M3 18h3.5c1.4 0 2.3-.7 3.2-2M14.3 8c.9-1.3 1.8-2 3.2-2H21"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M18.5 3.2 21.8 6l-3.3 2.8zM18.5 15.2 21.8 18l-3.3 2.8z" fill="currentColor" />
    </svg>
  );
}

function PrevIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M11.5 12 20 6.2v11.6zM2.5 12 11 6.2v11.6z" fill="currentColor" />
    </svg>
  );
}

function NextIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12.5 12 4 6.2v11.6zM21.5 12 13 6.2v11.6z" fill="currentColor" />
    </svg>
  );
}

function PlayIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M6 4.5 20 12 6 19.5z" fill="currentColor" />
    </svg>
  );
}

function PauseIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="5.5" y="4" width="4.5" height="16" rx="1.4" fill="currentColor" />
      <rect x="14" y="4" width="4.5" height="16" rx="1.4" fill="currentColor" />
    </svg>
  );
}

function HeartIcon({ filled }: { filled: boolean }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M12 20.5C6.5 16.6 3 13.6 3 9.9 3 7.2 5.1 5.2 7.7 5.2c1.6 0 3.2.8 4.3 2.2 1.1-1.4 2.7-2.2 4.3-2.2 2.6 0 4.7 2 4.7 4.7 0 3.7-3.5 6.7-9 10.6z"
        fill={filled ? 'currentColor' : 'none'}
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
    </svg>
  );
}

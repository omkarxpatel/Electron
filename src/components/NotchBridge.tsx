import { useEffect, useMemo, useRef } from 'react';
import { usePlayback } from '../spotify/SpotifyProvider';
import { useLyrics } from '../lyrics/useLyrics';
import type { Palette } from '../visualizers/palettes';
import type { NotchState } from '../types/api';

/**
 * Wiring between the notch HUD (its own window) and the Spotify session
 * (this renderer). Renders nothing. Same shape as TrayBridge, and for the
 * same reason — the panel has no session of its own.
 *   ↑  now-playing, art, progress, the whole synced lyric track
 *   ↓  transport / shuffle / save / seek
 *
 * Note what is NOT sent: a current lyric line, or a ticking progress value.
 * Both are timing, and this renderer's timers are throttled to ~1 Hz whenever
 * it's occluded — which is the normal state of affairs while someone is
 * looking at the notch. The panel gets anchors and runs its own clock.
 */

interface Props {
  /** Album-art palette, already computed in App for the visualizer. Null when
   *  the user hasn't enabled auto-tint, which just means a default accent. */
  albumPalette: Palette | null;
}

export function NotchBridge({ albumPalette }: Props): null {
  const { playback, savedCurrent, togglePlay, next, previousOrRestart, seek, toggleShuffle, toggleSaveCurrent } =
    usePlayback();

  const item = playback?.item ?? null;
  const title = item?.name ?? '';
  const artist = item?.artists.map((a) => a.name).join(', ') ?? '';
  const album = item?.album?.name;
  const durationMs = item?.duration_ms ?? 0;

  const lyrics = useLyrics(title || null, artist || null, album, durationMs);

  // Read through a ref so the 1.5 s playback poll handing us new callback
  // identities doesn't tear the IPC listener down and set it up again.
  const actionsRef = useRef({ togglePlay, next, previousOrRestart, seek, toggleShuffle, toggleSaveCurrent });
  actionsRef.current = { togglePlay, next, previousOrRestart, seek, toggleShuffle, toggleSaveCurrent };

  useEffect(() => {
    return window.api?.notch?.onCommand((cmd) => {
      const a = actionsRef.current;
      switch (cmd.kind) {
        case 'toggle':
          void a.togglePlay();
          break;
        case 'next':
          void a.next();
          break;
        case 'previous':
          void a.previousOrRestart();
          break;
        case 'shuffle':
          void a.toggleShuffle();
          break;
        case 'save':
          void a.toggleSaveCurrent();
          break;
        case 'seek':
          void a.seek(cmd.ms);
          break;
      }
    });
  }, []);

  const state = useMemo<NotchState | null>(() => {
    if (!title) return null;
    return {
      title,
      artist,
      artUrl: item?.album?.images?.[0]?.url ?? null,
      accent: albumPalette?.glowColor ?? null,
      ambient: albumPalette?.ambient ?? null,
      isPlaying: playback?.is_playing === true,
      progressMs: playback?.progress_ms ?? 0,
      durationMs,
      shuffle: playback?.shuffle_state === true,
      saved: savedCurrent,
      lyrics: lyrics.lines.length > 0 ? lyrics.lines : null,
    };
  }, [
    title,
    artist,
    item?.album?.images,
    albumPalette?.glowColor,
    albumPalette?.ambient,
    playback?.is_playing,
    playback?.progress_ms,
    playback?.shuffle_state,
    durationMs,
    savedCurrent,
    lyrics.lines,
  ]);

  useEffect(() => {
    window.api?.notch?.setState(state);
  }, [state]);

  return null;
}

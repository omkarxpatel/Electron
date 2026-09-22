import { useEffect, useRef } from 'react';
import { usePlayback } from '../spotify/SpotifyProvider';

/**
 * Wiring between the menu-bar tray (main process) and the Spotify session
 * (renderer). Renders nothing.
 *
 * Both directions matter while the window is hidden, which is the whole
 * point of the tray: the renderer keeps polling and keeps its tokens, so
 * transport still works with nothing on screen.
 *   ↑  now-playing, for the tray's labels and Play/Pause wording
 *   ↓  transport commands from the tray's menu items
 */
export function TrayBridge(): null {
  const { playback, togglePlay, next, previous } = usePlayback();

  // The transport subscription is registered once. Actions are read through a
  // ref so a new callback identity from the 1.5 s playback poll doesn't tear
  // the IPC listener down and set it up again.
  const actionsRef = useRef({ togglePlay, next, previous });
  actionsRef.current = { togglePlay, next, previous };

  useEffect(() => {
    return window.api.tray.onTransport((action) => {
      const actions = actionsRef.current;
      if (action === 'toggle') void actions.togglePlay();
      else if (action === 'next') void actions.next();
      else void actions.previous();
    });
  }, []);

  // Primitive deps, so this only fires on an actual track / play-state
  // change rather than on every poll tick.
  const item = playback?.item ?? null;
  const title = item?.name ?? '';
  const artist = item?.artists.map((a) => a.name).join(', ') ?? '';
  const isPlaying = playback?.is_playing === true;

  useEffect(() => {
    window.api.tray.setNowPlaying(title ? { title, artist, isPlaying } : null);
  }, [title, artist, isPlaying]);

  return null;
}

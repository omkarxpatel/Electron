import { SpotifyNowPlaying } from './SpotifyNowPlaying';
import { usePlayback } from '../spotify/SpotifyProvider';

/**
 * Thin context-consumer wrapper around SpotifyNowPlaying.
 *
 * Pulls playback state + transport actions from PlaybackContext so the App
 * shell no longer has to thread ten props down. SpotifyNowPlaying itself
 * stays pure / memo-friendly — this wrapper exists only to break the
 * prop-drilling chain.
 */
export function NowPlayingBar() {
  const p = usePlayback();
  return (
    <SpotifyNowPlaying
      playback={p.playback}
      togglePlay={p.togglePlay}
      next={p.next}
      previous={p.previous}
      seek={p.seek}
      setVolume={p.setVolume}
      toggleShuffle={p.toggleShuffle}
      cycleRepeat={p.cycleRepeat}
      toggleSaveCurrent={p.toggleSaveCurrent}
      savedCurrent={p.savedCurrent}
    />
  );
}

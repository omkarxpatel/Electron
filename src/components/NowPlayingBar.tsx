import { SpotifyNowPlaying } from './SpotifyNowPlaying';
import { usePlayback, useLibrary } from '../spotify/SpotifyProvider';

/**
 * Thin context-consumer wrapper around SpotifyNowPlaying.
 *
 * Pulls playback state + transport actions from PlaybackContext so the App
 * shell no longer has to thread ten props down. SpotifyNowPlaying itself
 * stays pure / memo-friendly — this wrapper exists only to break the
 * prop-drilling chain.
 *
 * It also owns the "Suggested" test, because that is the one thing in the
 * player bar needing both contexts at once: playback (what's on) and library
 * (what's in the open playlist).
 */
export function NowPlayingBar() {
  const p = usePlayback();
  const lib = useLibrary();

  // Smart Shuffle splices tracks that aren't in the playlist into the queue,
  // and Spotify's API never flags which ones — the context uri stays the
  // playlist either way. So infer it: playing from the playlist we have open,
  // but the track isn't in it.
  //
  // Gated on the playlist being FULLY paged in (tracksNextOffset === null).
  // Mid-pagination, "not in the list we've loaded" doesn't mean "not in the
  // playlist", and badging on that would mislabel ordinary tracks on every
  // long playlist. Liked Songs is excluded: it plays as a uri list with no
  // context, so there is nothing to compare against.
  const trackId = p.playback?.item?.id ?? null;
  const contextUri = p.playback?.context?.uri ?? null;
  const suggested =
    trackId !== null &&
    contextUri !== null &&
    lib.source?.kind === 'playlist' &&
    lib.source.playlist.uri === contextUri &&
    lib.tracksNextOffset === null &&
    !lib.tracks.some((t) => t.id === trackId);

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
      suggested={suggested}
    />
  );
}

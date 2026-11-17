interface Props {
  visible: boolean;
  onUnmute: () => void;
}

/** A run that was cut short (a crash, a force quit) leaves the app muted on
 *  purpose: Spotify may still be playing into BlackHole. Without a visible
 *  way back, "no sound" looks like a broken app. */
export function LearnMutedBanner({ visible, onUnmute }: Props) {
  if (!visible) return null;
  return (
    <div className="learn-muted-banner" role="status">
      <span>Learning left the app muted</span>
      <button type="button" className="learn-btn" onClick={onUnmute}>
        Unmute
      </button>
    </div>
  );
}

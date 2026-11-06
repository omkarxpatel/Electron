import { useEffect, useState } from 'react';
import { useWindowPresence } from './useWindowPresence';

/**
 * Returns true when the window is "active" — i.e., visible to the user OR
 * has been hidden for less than `hideDelayMs`. The grace period prevents
 * tear-down/spin-up cost on rapid window switches.
 *
 * Use this to gate expensive UI work (RAF loops, polling intervals,
 * canvas redraws) so they go fully idle when the user switches away. Audio
 * is not affected — `AudioContext` and analyser nodes keep producing sound
 * regardless of window visibility; only the visual layer pauses.
 *
 * "Hidden" maps to: the document being hidden (window minimised or hidden,
 * the OS lockscreen), OR main reporting the window away — covered by other
 * apps, on another Space, behind a full-screen app. The document alone
 * never sees the second kind: Electron disables Chromium's occlusion
 * detection on macOS, so a covered window kept drawing at 120 Hz for nobody.
 * See electron/windowPresence.ts. It does NOT fire when the user just clicks
 * away to another app with this window still on screen; that is the
 * `background` presence, which callers handle themselves.
 *
 * `alsoHidden` lets a caller add a reason of its own under the same grace
 * period, such as the App's "pause in the background" setting.
 */
export function useVisibility(hideDelayMs = 2500, alsoHidden = false): boolean {
  const presence = useWindowPresence();
  const [documentHidden, setDocumentHidden] = useState<boolean>(
    () => typeof document !== 'undefined' && document.visibilityState === 'hidden',
  );

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const handler = () => setDocumentHidden(document.visibilityState === 'hidden');
    document.addEventListener('visibilitychange', handler);
    return () => document.removeEventListener('visibilitychange', handler);
  }, []);

  const hidden = documentHidden || presence.kind === 'away' || alsoHidden;

  // Becoming visible is immediate; going idle waits out the grace period.
  const [lapsed, setLapsed] = useState(hidden);
  useEffect(() => {
    if (!hidden) {
      setLapsed(false);
      return;
    }
    const timer = window.setTimeout(() => setLapsed(true), hideDelayMs);
    return () => window.clearTimeout(timer);
  }, [hidden, hideDelayMs]);

  return !hidden || !lapsed;
}

import { useEffect, useRef, useState } from 'react';

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
 * "Hidden" maps to: window minimized, app fully occluded by another app,
 * the OS lockscreen, or the renderer being hidden by the OS. It does NOT
 * fire when the user just clicks away to a sibling window in the same app
 * (those still receive paint events).
 */
export function useVisibility(hideDelayMs = 2500): boolean {
  const [isActive, setIsActive] = useState<boolean>(() =>
    typeof document === 'undefined' ? true : document.visibilityState !== 'hidden',
  );
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    if (typeof document === 'undefined') return;

    const clearTimer = () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };

    const handler = () => {
      if (document.visibilityState === 'hidden') {
        if (timerRef.current !== null) return;
        timerRef.current = window.setTimeout(() => {
          setIsActive(false);
          timerRef.current = null;
        }, hideDelayMs);
      } else {
        clearTimer();
        setIsActive(true);
      }
    };

    document.addEventListener('visibilitychange', handler);
    return () => {
      document.removeEventListener('visibilitychange', handler);
      clearTimer();
    };
  }, [hideDelayMs]);

  return isActive;
}

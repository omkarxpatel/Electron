import { useEffect } from 'react';
import { usePlayback } from './SpotifyProvider';

/**
 * Global transport keys: Space toggles playback, ← / → change track.
 *
 * Deliberately a short list. Every key claimed here is one the rest of the
 * UI can no longer use, and the app is full of text fields, sliders and
 * scrollable lists that all have a prior claim on these three.
 *
 * ⌘F is NOT handled here — it filters the open track list and lives with
 * that component, since it does nothing without one.
 */

/**
 * Whether the key should be left alone because the user is interacting with
 * a control that already means something by it.
 *
 * - Text fields: Space types a space, arrows move the caret. Stealing Space
 *   here would pause the music every time you searched for a song with a
 *   space in its name.
 * - Range inputs (the EQ bands, volume): arrows nudge the value.
 * - Buttons and links: Space and Enter activate the focused control, which
 *   is the platform behaviour and what screen-reader users expect.
 */
function shouldIgnore(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.tagName !== 'string') return false;
  if (el.isContentEditable) return true;
  switch (el.tagName) {
    case 'INPUT':
    case 'TEXTAREA':
    case 'SELECT':
    case 'BUTTON':
    case 'A':
      return true;
    default:
      return false;
  }
}

export function useTransportShortcuts(): void {
  const { togglePlay, next, previous } = usePlayback();

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // Modifier combos belong to other handlers (⌘F, ⌘Q, the dev-tools
      // shortcut). Only bare presses are transport.
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      if (shouldIgnore(e.target)) return;

      switch (e.key) {
        case ' ':
          // Space scrolls the nearest scrollable ancestor otherwise, which
          // would jump the track list on every play/pause.
          e.preventDefault();
          void togglePlay();
          break;
        case 'ArrowLeft':
          e.preventDefault();
          void previous();
          break;
        case 'ArrowRight':
          e.preventDefault();
          void next();
          break;
        default:
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [togglePlay, next, previous]);
}

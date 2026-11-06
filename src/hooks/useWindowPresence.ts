import { useEffect, useState } from 'react';
import type { WindowPresence } from '../types/api';

const FOCUSED: WindowPresence = { kind: 'focused' };

function isPresence(value: unknown): value is WindowPresence {
  const kind = (value as { kind?: unknown } | null)?.kind;
  return kind === 'focused' || kind === 'background' || kind === 'away';
}

/**
 * Who can see the main window, as main works it out — see
 * electron/windowPresence.ts. The page cannot tell on its own: Electron turns
 * off Chromium's occlusion detection on macOS, so a covered window still
 * reports `document.visibilityState === 'visible'`.
 *
 * Falls back to `focused` when nothing answers, as in a capture harness:
 * drawing for nobody wastes CPU, but freezing the visuals in front of someone
 * watching them is a bug they can see.
 */
export function useWindowPresence(): WindowPresence {
  const [presence, setPresence] = useState<WindowPresence>(() => {
    const initial: unknown = window.api.windowPresence?.getInitialState();
    return isPresence(initial) ? initial : FOCUSED;
  });

  useEffect(
    () =>
      window.api.windowPresence?.onState((next) => {
        if (isPresence(next)) setPresence(next);
      }),
    [],
  );

  return presence;
}

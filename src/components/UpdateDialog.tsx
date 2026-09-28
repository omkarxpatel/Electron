import { memo, useCallback, useEffect, useRef, useState } from 'react';
import {
  dismissVersion,
  downloadUpdate,
  openReleasePage,
  parseReleaseNotes,
  useUpdateState,
} from '../lib/updateService';

/**
 * The "an update is available" prompt, asked inside our own window.
 *
 * This used to be `dialog.showMessageBox` in the main process. A native alert
 * takes a plain string, so it could not show the release notes at all — which
 * is why the notes were rendered in the top strip instead, where a few bullets
 * of prose got clipped by the strip's height. The question and the answer to
 * "what is in it?" were two different pieces of UI, one of them cut off.
 *
 * So the notes live here, next to the buttons they inform. The top banner no
 * longer renders `available` at all; it picks up again at `downloading`, where
 * progress is the useful thing to show.
 *
 * Deliberately NOT an OS-modal. Closing it (Escape, or the ×) leaves the app
 * usable and the update still pending — Settings → About continues to offer
 * it. A prompt that has to be answered before you can touch your equaliser is
 * worse than one you can put down, given nothing here is urgent.
 */

export const UpdateDialog = memo(UpdateDialogImpl);

function UpdateDialogImpl() {
  const state = useUpdateState();
  /** Closed by the user, per version. Checks repeat on a timer and re-push
   *  the same `available` state, which would otherwise re-open a dialog they
   *  just put away. */
  const [closedFor, setClosedFor] = useState<string | null>(null);
  const primaryRef = useRef<HTMLButtonElement | null>(null);

  const version = state.kind === 'available' ? state.version : null;
  const open = version !== null && version !== closedFor;

  const close = useCallback(() => setClosedFor(version), [version]);

  // Escape closes, and the primary action takes focus on open so the whole
  // thing is keyboard-reachable without a tab through the app behind it.
  useEffect(() => {
    if (!open) return;
    primaryRef.current?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, close]);

  if (!open || state.kind !== 'available') return null;

  const notes = parseReleaseNotes(state.releaseNotes);

  return (
    <div className="update-dialog-backdrop" role="presentation">
      <div
        className="update-dialog"
        role="dialog"
        aria-modal="false"
        aria-labelledby="update-dialog-title"
      >
        <button
          type="button"
          className="update-dialog-close"
          onClick={close}
          aria-label="Close"
          title="Close — the update stays available under Settings → About"
        >
          ×
        </button>

        <h2 className="update-dialog-title" id="update-dialog-title">
          Version {state.version} is available
        </h2>

        {notes.length > 0 ? (
          <ul className="update-dialog-notes">
            {notes.map((item, i) => (
              <li key={i}>{item}</li>
            ))}
          </ul>
        ) : (
          // Releases published before the notes asset existed have none, and
          // an update you can't read about is still worth taking.
          <p className="update-dialog-sub">
            No release notes were published for this version.
          </p>
        )}

        <p className="update-dialog-sub">
          It downloads in the background. Installing restarts the app — your
          Spotify sign-in, EQ settings and visualizer presets are preserved.
        </p>

        <div className="update-dialog-actions">
          <button
            type="button"
            ref={primaryRef}
            className="update-dialog-btn is-primary"
            onClick={() => void downloadUpdate(true)}
          >
            Install now
          </button>
          <button
            type="button"
            className="update-dialog-btn"
            onClick={() => void downloadUpdate(false)}
          >
            Install when I quit
          </button>
          <button
            type="button"
            className="update-dialog-btn"
            onClick={() => void dismissVersion(state.version)}
            title="You won't be asked again until a newer version is released"
          >
            Skip this version
          </button>
        </div>

        <button
          type="button"
          className="update-dialog-link"
          onClick={() => void openReleasePage(state.releasePageUrl)}
        >
          View release on GitHub
        </button>
      </div>
    </div>
  );
}

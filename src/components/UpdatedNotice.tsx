/**
 * "Here's what you just got" — shown once, after an update installed itself.
 *
 * This exists because automatic updates remove the one moment the user would
 * otherwise have read the notes: the prompt. A release that installs itself
 * while they are working is a release they never agreed to and never saw
 * described, and silently changing an app under someone is how a feature
 * becomes a bug report. Install without asking, then say what changed.
 *
 * Deliberately NOT an `UpdateState`. That union is mirrored in five places
 * (main, api.d.ts, updateService, UpdateBanner, UpdateDialog — and
 * `formatStateSummary` is an exhaustive switch over it), and this is not a
 * state of the update machine anyway: the update it describes finished in a
 * previous process. Modelling it as one would also put it at the mercy of
 * the state machine, which broadcasts `checking` 8s after launch and would
 * wipe the notice off the screen mid-read.
 *
 * Borrows the banner's markup and classes rather than growing its own: it is
 * the same strip in the same place saying a related thing, and a second set
 * of styles for that would drift.
 */

import { useCallback, useEffect, useState } from 'react';
import type { JustInstalled } from '../types/api';
import { parseReleaseNotes } from '../lib/updateService';

/** Matches the banner's own cap. Past this it is a changelog, not a notice. */
const MAX_NOTES = 4;

export function UpdatedNotice() {
  const [info, setInfo] = useState<JustInstalled | null>(null);

  useEffect(() => {
    let alive = true;
    void window.api.update
      .getJustInstalled()
      .then((record) => {
        if (alive) setInfo(record);
      })
      // A notice nobody can show is not worth an error path; the version is
      // in Settings either way.
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  const dismiss = useCallback(() => {
    // Clear it on disk first so it cannot come back on the next launch, then
    // take it off screen. The other order would show it twice if the write
    // failed, which is the more annoying of the two failures.
    void window.api.update.acknowledgeInstalled().catch(() => undefined);
    setInfo(null);
  }, []);

  if (info === null) return null;

  const items = parseReleaseNotes(info.notes);
  const shown = items.slice(0, MAX_NOTES);

  return (
    <div className="update-banner" data-state="installed" role="status">
      <div className="update-banner-text">
        <strong>Updated to v{info.version}</strong>
        {shown.length > 0 ? (
          <ul className="update-banner-notes">
            {shown.map((item, i) => (
              <li key={i}>{item}</li>
            ))}
            {items.length > shown.length && (
              <li className="update-banner-notes-more">
                and {items.length - shown.length} more
              </li>
            )}
          </ul>
        ) : (
          <span className="update-banner-sub">
            No release notes were published for this version.
          </span>
        )}
      </div>
      <div className="update-banner-actions">
        <button
          type="button"
          className="update-banner-dismiss"
          onClick={dismiss}
          aria-label="Dismiss"
          title="Dismiss"
        >
          ×
        </button>
      </div>
    </div>
  );
}

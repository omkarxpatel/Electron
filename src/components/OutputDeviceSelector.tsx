import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SinkVolumeState } from '../types/api';
import { useDismissOnOutside } from '../hooks/useDismissOnOutside';
import {
  FEEDBACK_NOTE,
  FEEDBACK_REASON,
  isSameDevice,
  resolveGroupId,
} from '../audio/deviceConflict';

/**
 * Picks where the processed audio is sent (AudioContext.setSinkId).
 *
 * Separate from AudioSourceSelector because input source and output sink are
 * orthogonal — input chooses what we listen to, output chooses where the
 * processed stream plays. The two must usually differ when BlackHole is the
 * system output, otherwise the playback feeds straight back into capture.
 */

interface Props {
  outputDeviceId: string | null;
  onSelect: (id: string | null) => void;
  /** Whether this device's hardware volume is currently being held at unity.
   *  Surfaced rather than done silently — we are changing a system setting
   *  the user did not ask us to touch, so they get to see it. */
  sinkVolume: SinkVolumeState;
  /** The device currently being captured, or null when nothing is. Outputs on
   *  the same physical device are offered but not selectable — see
   *  deviceConflict.ts. */
  inputDeviceId: string | null;
}

/** What we did to this device's volume, or couldn't. `null` when there is
 *  nothing worth saying. Written to be read at a glance in the menu, so it
 *  stays to two short sentences however tempting the detail is. */
function pinNote(
  state: SinkVolumeState,
): { tone: string; text: string; detail: string } | null {
  switch (state.kind) {
    case 'pinned':
      return {
        tone: 'ok',
        text: 'Output held at 100%',
        detail:
          `Raised from ${Math.round(state.originalVolume * 100)}% — the menu bar ` +
          `slider can't reach this device, so its level was capping the app. ` +
          `Restored when Live stops.`,
      };
    case 'unsupported':
      return {
        tone: 'warn',
        text: 'Output level may be capped',
        detail: `${state.reason}, so it can't be lifted.`,
      };
    case 'error':
      return { tone: 'warn', text: "Couldn't set output level", detail: state.message };
    default:
      return null;
  }
}

export const OutputDeviceSelector = memo(OutputDeviceSelectorImpl);

function OutputDeviceSelectorImpl({
  outputDeviceId,
  onSelect,
  sinkVolume,
  inputDeviceId,
}: Props) {
  const [allDevices, setAllDevices] = useState<MediaDeviceInfo[]>([]);
  /** Whether a listing has landed yet. `allDevices` starts empty, and until
   *  the first enumeration resolves an empty list means "not asked", not
   *  "gone" — without this the chosen device would flash as disconnected on
   *  every launch. */
  const [listed, setListed] = useState(false);
  const [open, setOpen] = useState(false);
  const [permissionNeeded, setPermissionNeeded] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  /** The chosen device's name, from the last time it was in the list. Once it
   *  disconnects it is no longer enumerated, so this is the only place left
   *  to read its name from. */
  const lastSeenRef = useRef<{ id: string; label: string } | null>(null);

  const close = useCallback(() => setOpen(false), []);
  useDismissOnOutside(rootRef, open, close);

  useEffect(() => {
    let cancelled = false;
    async function refresh() {
      const all = await navigator.mediaDevices.enumerateDevices();
      if (cancelled) return;
      setAllDevices(all);
      setListed(true);
      const outputs = all.filter((d) => d.kind === 'audiooutput');
      setPermissionNeeded(outputs.length > 0 && outputs.every((d) => !d.label));
    }
    refresh();
    const handler = () => refresh();
    navigator.mediaDevices.addEventListener('devicechange', handler);
    return () => {
      cancelled = true;
      navigator.mediaDevices.removeEventListener('devicechange', handler);
    };
  }, []);

  async function requestPermission() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
      setAllDevices(await navigator.mediaDevices.enumerateDevices());
      setPermissionNeeded(false);
    } catch {
      // ignore
    }
  }

  const devices = useMemo(
    () => allDevices.filter((d) => d.kind === 'audiooutput'),
    [allDevices],
  );

  // Every output on this group is the input device wearing its other hat.
  const inputGroup = resolveGroupId(allDevices, 'audioinput', inputDeviceId);
  // "System default" is not a device of its own — it routes to whatever the OS
  // is pointing at, which in this app's own setup is usually BlackHole, i.e.
  // the very thing we are capturing.
  const defaultBlocked = isSameDevice(
    resolveGroupId(allDevices, 'audiooutput', 'default'),
    inputGroup,
  );

  // Blocking the rows stops a NEW collision being picked; it does nothing for
  // one we are already sitting in. That is not a corner case — the app ships
  // with output unset, and unset means the OS default, which in this app's own
  // setup is the BlackHole we are capturing. So say it, or the only feedback
  // the user gets is the actual feedback.
  const currentBlocked = isSameDevice(
    resolveGroupId(allDevices, 'audiooutput', outputDeviceId ?? 'default'),
    inputGroup,
  );

  const note = pinNote(sinkVolume);
  const selected = devices.find((d) => d.deviceId === outputDeviceId);
  if (selected?.label && outputDeviceId) {
    lastSeenRef.current = { id: outputDeviceId, label: selected.label };
  }
  const lastSeenLabel =
    lastSeenRef.current && lastSeenRef.current.id === outputDeviceId ? lastSeenRef.current.label : null;

  /* A device is chosen and the list, read with permission, doesn't have it:
   * it disconnected. This used to fall through to "System default", which is
   * not what the app was doing — it was still set to the missing device, and
   * still is, so that it can go back to it on reconnect (see the device-return
   * re-apply in useAudioEngine). Telling someone whose AirPods just died that
   * they are on the system default is exactly the wrong thing to show them. */
  const missing = outputDeviceId !== null && listed && !permissionNeeded && !selected;
  const missingLabel = `${lastSeenLabel ?? 'Saved output'} — disconnected`;

  const buttonLabel = selected
    ? selected.label || `Output (${selected.deviceId.slice(0, 8)})`
    : outputDeviceId === null
      ? 'System default'
      : missing
        ? missingLabel
        : // Chosen, but not listed yet. Neutral rather than a claim either way.
          (lastSeenLabel ?? 'Output');

  return (
    <div className="audio-source-selector" ref={rootRef}>
      <button
        className={`source-btn ghost ${outputDeviceId ? 'is-active' : ''}`}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title="Where processed audio plays. Pick a real speaker/headphone if system output is BlackHole."
      >
        <span className="source-icon" aria-hidden>🔊</span>
        <span>{buttonLabel}</span>
        <span className="caret" aria-hidden>▾</span>
      </button>

      {open && (
        <div className="source-dropdown" role="listbox">
          {/* Inside the menu rather than under the button. Floating below the
              button it sat over the window permanently, which is a lot of
              standing furniture for something you only need when you're
              wondering what happened to your output level. */}
          {currentBlocked && (
            <div className="sink-pin-note is-warn">
              <span className="sink-pin-note-text">Playing into the input</span>
              <span className="sink-pin-note-detail">
                {FEEDBACK_REASON} Pick one of the devices below.
              </span>
            </div>
          )}
          {note && (
            <div className={`sink-pin-note is-${note.tone}`}>
              <span className="sink-pin-note-text">{note.text}</span>
              <span className="sink-pin-note-detail">{note.detail}</span>
            </div>
          )}
          {permissionNeeded ? (
            <button className="source-row" onClick={requestPermission}>
              Grant audio access to list devices
            </button>
          ) : (
            <>
              <button
                role="option"
                aria-selected={outputDeviceId === null}
                disabled={defaultBlocked}
                title={defaultBlocked ? FEEDBACK_REASON : undefined}
                className={`source-row ${outputDeviceId === null ? 'is-active' : ''} ${
                  defaultBlocked ? 'is-blocked' : ''
                }`}
                onClick={() => {
                  onSelect(null);
                  setOpen(false);
                }}
              >
                System default
                {defaultBlocked && <span className="source-row-note">{FEEDBACK_NOTE}</span>}
              </button>
              {/* The chosen device, while it's gone. Shown so the menu agrees
                  with the button rather than offering no row selected at all,
                  and disabled because there is nothing to pick — it is
                  already the choice. */}
              {missing && (
                <button
                  role="option"
                  aria-selected
                  disabled
                  title="Not connected. Audio goes back to this device when it reconnects."
                  className="source-row is-active is-blocked"
                >
                  {missingLabel}
                </button>
              )}
              {devices.length === 0 ? (
                <div className="source-row source-row-empty">No output devices</div>
              ) : (
                devices.map((d) => {
                  const blocked = isSameDevice(d.groupId, inputGroup);
                  return (
                    <button
                      key={d.deviceId}
                      role="option"
                      aria-selected={outputDeviceId === d.deviceId}
                      disabled={blocked}
                      title={blocked ? FEEDBACK_REASON : undefined}
                      className={`source-row ${
                        outputDeviceId === d.deviceId ? 'is-active' : ''
                      } ${blocked ? 'is-blocked' : ''}`}
                      onClick={() => {
                        onSelect(d.deviceId);
                        setOpen(false);
                      }}
                    >
                      {d.label || `Output (${d.deviceId.slice(0, 8)})`}
                      {blocked && <span className="source-row-note">{FEEDBACK_NOTE}</span>}
                    </button>
                  );
                })
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

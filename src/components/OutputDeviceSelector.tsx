import { memo, useEffect, useState } from 'react';
import type { SinkVolumeState } from '../types/api';

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
}

/** What we did to this device's volume, or couldn't. `null` when there is
 *  nothing worth saying. Written to be READ, not hovered — it sits in the
 *  menu now, so it has to be short enough to take in at a glance. */
function pinNote(
  state: SinkVolumeState,
): { tone: string; text: string; detail: string } | null {
  switch (state.kind) {
    case 'pinned': {
      const was = `${Math.round(state.originalVolume * 100)}%`;
      return {
        tone: 'ok',
        text: 'Output held at 100%',
        detail:
          `Raised from ${was} because the menu bar slider can't reach this ` +
          `device while your system output goes somewhere else — its level was ` +
          `capping how loud the app could get.` +
          (state.compensatedDevice
            ? ` ${state.compensatedDevice} was turned down to match, so nothing got louder.`
            : '') +
          ' Restored when Live stops.',
      };
    }
    case 'unsupported':
      return {
        tone: 'warn',
        text: 'Output level may be capped',
        detail:
          `${state.reason}, so it can't be lifted. If this device sounds quiet, ` +
          `set its volume before you point system output elsewhere.`,
      };
    case 'error':
      return { tone: 'warn', text: "Couldn't set output level", detail: state.message };
    default:
      return null;
  }
}

export const OutputDeviceSelector = memo(OutputDeviceSelectorImpl);

function OutputDeviceSelectorImpl({ outputDeviceId, onSelect, sinkVolume }: Props) {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [open, setOpen] = useState(false);
  const [permissionNeeded, setPermissionNeeded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function refresh() {
      const all = await navigator.mediaDevices.enumerateDevices();
      if (cancelled) return;
      const outputs = all.filter((d) => d.kind === 'audiooutput');
      setDevices(outputs);
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
      const all = await navigator.mediaDevices.enumerateDevices();
      setDevices(all.filter((d) => d.kind === 'audiooutput'));
      setPermissionNeeded(false);
    } catch {
      // ignore
    }
  }

  const note = pinNote(sinkVolume);
  const selected = devices.find((d) => d.deviceId === outputDeviceId);
  const buttonLabel = selected
    ? selected.label || `Output (${selected.deviceId.slice(0, 8)})`
    : 'System default';

  return (
    <div className="audio-source-selector">
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
                className={`source-row ${outputDeviceId === null ? 'is-active' : ''}`}
                onClick={() => {
                  onSelect(null);
                  setOpen(false);
                }}
              >
                System default
              </button>
              {devices.length === 0 ? (
                <div className="source-row source-row-empty">No output devices</div>
              ) : (
                devices.map((d) => (
                  <button
                    key={d.deviceId}
                    role="option"
                    aria-selected={outputDeviceId === d.deviceId}
                    className={`source-row ${outputDeviceId === d.deviceId ? 'is-active' : ''}`}
                    onClick={() => {
                      onSelect(d.deviceId);
                      setOpen(false);
                    }}
                  >
                    {d.label || `Output (${d.deviceId.slice(0, 8)})`}
                  </button>
                ))
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

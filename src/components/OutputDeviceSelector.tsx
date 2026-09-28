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

/** One line of plain language about what we did (or couldn't do) to the
 *  device's volume. `null` when there is nothing worth saying. */
function pinNote(state: SinkVolumeState): { tone: string; text: string; detail: string } | null {
  switch (state.kind) {
    case 'pinned':
      return {
        tone: 'ok',
        text: state.compensatedDevice
          ? `Output held at 100% — volume moved to the slider`
          : `Output held at 100% (was ${Math.round(state.originalVolume * 100)}%)`,
        detail:
          `macOS's volume slider only controls the default output device, so it ` +
          `can't reach ${state.deviceName} — and whatever level that device was ` +
          `left at becomes a ceiling on how loud this app can get. ` +
          `${state.deviceName} was raised from ${Math.round(state.originalVolume * 100)}% ` +
          `to 100%` +
          (state.compensatedDevice
            ? `, and ${state.compensatedDevice} was turned down by the same amount so ` +
              `nothing suddenly got louder. The menu bar slider now sets your volume ` +
              `over its full range.`
            : `. Use the menu bar slider to set volume as normal.`) +
          ` ${state.deviceName} is restored when Live stops.`,
      };
    case 'unsupported':
      return {
        tone: 'warn',
        text: 'Output level may be capped',
        detail:
          `${state.deviceName} ${state.reason}, so its level can't be lifted. If this ` +
          `device sounds quiet, set its volume before selecting it as the system output.`,
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

      {note && (
        <div className={`sink-pin-note is-${note.tone}`} title={note.detail}>
          {note.text}
        </div>
      )}

      {open && (
        <div className="source-dropdown" role="listbox">
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

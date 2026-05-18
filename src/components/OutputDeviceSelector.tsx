import { memo, useEffect, useState } from 'react';

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
}

export const OutputDeviceSelector = memo(OutputDeviceSelectorImpl);

function OutputDeviceSelectorImpl({ outputDeviceId, onSelect }: Props) {
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

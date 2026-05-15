import { useEffect, useState } from 'react';
import type { SourceMode } from '../audio/useAudioSource';

interface Props {
  mode: SourceMode;
  deviceId: string | null;
  busy: boolean;
  error: string | null;
  onUseSystemAudio: () => void;
  onUseDevice: (id: string) => void;
  onDisconnect: () => void;
}

export function AudioSourceSelector({
  mode,
  deviceId,
  busy,
  error,
  onUseSystemAudio,
  onUseDevice,
  onDisconnect,
}: Props) {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [showDevices, setShowDevices] = useState(false);
  const [permissionNeeded, setPermissionNeeded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function refresh() {
      const all = await navigator.mediaDevices.enumerateDevices();
      if (cancelled) return;
      const inputs = all.filter((d) => d.kind === 'audioinput');
      setDevices(inputs);
      setPermissionNeeded(inputs.length > 0 && inputs.every((d) => !d.label));
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
      setDevices(all.filter((d) => d.kind === 'audioinput'));
      setPermissionNeeded(false);
    } catch {
      // ignore
    }
  }

  const activeLabel =
    mode === 'system'
      ? 'System Audio'
      : mode === 'device'
      ? devices.find((d) => d.deviceId === deviceId)?.label ?? 'Audio input'
      : 'No source';

  return (
    <div className="audio-source-selector">
      <button
        className={`source-btn primary ${mode === 'system' ? 'is-active' : ''}`}
        onClick={onUseSystemAudio}
        disabled={busy}
        title="Capture system audio directly (no virtual audio device needed)"
      >
        <span className="source-icon" aria-hidden>🖥</span>
        <span>System Audio</span>
      </button>

      <button
        className="source-btn ghost"
        onClick={() => setShowDevices((v) => !v)}
        aria-expanded={showDevices}
        title="Use a specific input device (BlackHole, microphone, etc.)"
      >
        {mode === 'device' ? activeLabel : 'Device…'}
        <span className="caret" aria-hidden>▾</span>
      </button>

      {showDevices && (
        <div className="source-dropdown" role="listbox">
          {permissionNeeded ? (
            <button className="source-row" onClick={requestPermission}>
              Grant microphone access
            </button>
          ) : devices.length === 0 ? (
            <div className="source-row source-row-empty">No input devices</div>
          ) : (
            devices.map((d) => (
              <button
                key={d.deviceId}
                role="option"
                aria-selected={mode === 'device' && deviceId === d.deviceId}
                className={`source-row ${mode === 'device' && deviceId === d.deviceId ? 'is-active' : ''}`}
                onClick={() => {
                  onUseDevice(d.deviceId);
                  setShowDevices(false);
                }}
              >
                {d.label || `Input (${d.deviceId.slice(0, 8)})`}
              </button>
            ))
          )}
          {mode !== 'none' && (
            <button
              className="source-row source-row-disconnect"
              onClick={() => {
                onDisconnect();
                setShowDevices(false);
              }}
            >
              Disconnect
            </button>
          )}
        </div>
      )}

      {error && <div className="source-error">⚠ {error}</div>}
    </div>
  );
}

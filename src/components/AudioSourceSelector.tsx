import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SourceMode } from '../audio/useAudioSource';
import { useDismissOnOutside } from '../hooks/useDismissOnOutside';
import {
  FEEDBACK_NOTE,
  FEEDBACK_REASON,
  isSameDevice,
  resolveGroupId,
} from '../audio/deviceConflict';

interface Props {
  mode: SourceMode;
  deviceId: string | null;
  busy: boolean;
  error: string | null;
  onUseSystemAudio: () => void;
  onUseDevice: (id: string) => void;
  onDisconnect: () => void;
  /** Where processed audio is playing. Inputs on the same physical device are
   *  offered but not selectable — see deviceConflict.ts. `'default'` stands
   *  for the OS default output, which is what "System default" routes to. */
  outputDeviceId: string;
}

export const AudioSourceSelector = memo(AudioSourceSelectorImpl);

function AudioSourceSelectorImpl({
  mode,
  deviceId,
  busy,
  error,
  onUseSystemAudio,
  onUseDevice,
  onDisconnect,
  outputDeviceId,
}: Props) {
  const [allDevices, setAllDevices] = useState<MediaDeviceInfo[]>([]);
  const [showDevices, setShowDevices] = useState(false);
  const [permissionNeeded, setPermissionNeeded] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const closeDevices = useCallback(() => setShowDevices(false), []);
  useDismissOnOutside(rootRef, showDevices, closeDevices);

  useEffect(() => {
    let cancelled = false;
    async function refresh() {
      const all = await navigator.mediaDevices.enumerateDevices();
      if (cancelled) return;
      setAllDevices(all);
      const inputs = all.filter((d) => d.kind === 'audioinput');
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
      setAllDevices(await navigator.mediaDevices.enumerateDevices());
      setPermissionNeeded(false);
    } catch {
      // ignore
    }
  }

  const devices = useMemo(
    () => allDevices.filter((d) => d.kind === 'audioinput'),
    [allDevices],
  );

  // Every input on this group is the output device wearing its other hat.
  const outputGroup = resolveGroupId(allDevices, 'audiooutput', outputDeviceId);

  const activeLabel =
    mode === 'system'
      ? 'System Audio'
      : mode === 'device'
      ? devices.find((d) => d.deviceId === deviceId)?.label ?? 'Audio input'
      : 'No source';

  return (
    <div className="audio-source-selector" ref={rootRef}>
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
            devices.map((d) => {
              const blocked = isSameDevice(d.groupId, outputGroup);
              return (
                <button
                  key={d.deviceId}
                  role="option"
                  aria-selected={mode === 'device' && deviceId === d.deviceId}
                  disabled={blocked}
                  title={blocked ? FEEDBACK_REASON : undefined}
                  className={`source-row ${
                    mode === 'device' && deviceId === d.deviceId ? 'is-active' : ''
                  } ${blocked ? 'is-blocked' : ''}`}
                  onClick={() => {
                    onUseDevice(d.deviceId);
                    setShowDevices(false);
                  }}
                >
                  {d.label || `Input (${d.deviceId.slice(0, 8)})`}
                  {blocked && <span className="source-row-note">{FEEDBACK_NOTE}</span>}
                </button>
              );
            })
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

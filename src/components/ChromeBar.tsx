import { memo, useCallback, useState } from 'react';
import { AudioSourceSelector } from './AudioSourceSelector';
import { OutputDeviceSelector } from './OutputDeviceSelector';
import type { SourceMode } from '../audio/useAudioSource';
import type { SinkVolumeState } from '../types/api';

/**
 * Top app bar: brand + audio source + audio output + settings gear.
 *
 * All state lives in the parent — this component is a pure layout slot so
 * memoization is straightforward and the wider app doesn't re-render when
 * (e.g.) the playback poll dispatches new state.
 */

interface Props {
  // Audio source
  sourceMode: SourceMode;
  sourceDeviceId: string | null;
  sourceBusy: boolean;
  sourceError: string | null;
  onUseSystemAudio: () => void;
  onUseDevice: (id: string) => void;
  onDisconnect: () => void;
  // Audio output
  outputDeviceId: string | null;
  onSelectOutput: (id: string | null) => void;
  sinkVolume: SinkVolumeState;
  // Settings drawer
  panelOpen: boolean;
  onTogglePanel: () => void;
  // Visuals-only mode
  onEnterImmersive: () => void;
}

export const ChromeBar = memo(ChromeBarImpl);

function ChromeBarImpl({
  sourceMode,
  sourceDeviceId,
  sourceBusy,
  sourceError,
  onUseSystemAudio,
  onUseDevice,
  onDisconnect,
  outputDeviceId,
  onSelectOutput,
  sinkVolume,
  panelOpen,
  onTogglePanel,
  onEnterImmersive,
}: Props) {
  return (
    <header className="topbar">
      <div className="brand">
        <ReloadLogo />
        <div className="title">Electron</div>
      </div>
      <div className="topbar-right">
        <AudioSourceSelector
          mode={sourceMode}
          deviceId={sourceDeviceId}
          busy={sourceBusy}
          error={sourceError}
          onUseSystemAudio={onUseSystemAudio}
          onUseDevice={onUseDevice}
          onDisconnect={onDisconnect}
          // null here means "System default", which is not a non-choice — it
          // routes to the OS default output, the device enumerateDevices()
          // lists under the id `default`.
          outputDeviceId={outputDeviceId ?? 'default'}
        />
        <OutputDeviceSelector
          outputDeviceId={outputDeviceId}
          onSelect={onSelectOutput}
          sinkVolume={sinkVolume}
          // Only 'device' mode captures a device. System-audio capture takes
          // whatever the OS plays, so there is no one device to collide with.
          inputDeviceId={sourceMode === 'device' ? sourceDeviceId : null}
        />
        <button
          className="icon-button"
          onClick={onEnterImmersive}
          aria-label="Visuals only"
          title="Visuals-only mode — hides the EQ and panels (Esc to exit)"
        >
          <ExpandIcon />
        </button>
        <button
          className="icon-button gear-button"
          onClick={onTogglePanel}
          aria-label="Settings"
          aria-pressed={panelOpen}
        >
          <GearIcon />
        </button>
      </div>
    </header>
  );
}

function ExpandIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M6 1.5H1.5V6M10 1.5H14.5V6M10 14.5H14.5V10M6 14.5H1.5V10"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * The brand mark, which turns into a reload control when you reach for it.
 *
 * It is the escape hatch for the states the UI has no button for: an audio
 * graph that has stopped, a visualizer that froze, a bundle left stale by an
 * update. Quitting and reopening did that already — this is the same thing
 * without losing the window, and it is parked on the logo because that is
 * dead space in the title bar rather than another icon to learn.
 *
 * The bars do not become the arrow: four straight lines and a circle share
 * no point for point morph worth writing. They hand over instead — the bars
 * drop back and turn away as the arrow turns in — which at this size reads
 * as one mark changing its mind.
 */
function ReloadLogo() {
  const [reloading, setReloading] = useState(false);

  const reload = useCallback((): void => {
    setReloading(true);
    // The page is torn down from under us, so there is no success path to
    // handle and nothing to sequence after it. A rejection only means the
    // reload never started, which leaves the spinner lying.
    void window.api.app.reload().catch((err) => {
      console.error('ChromeBar: reload failed', err);
      setReloading(false);
    });
  }, []);

  return (
    <button
      type="button"
      className="brand-reload"
      data-reloading={reloading ? 'true' : 'false'}
      onClick={reload}
      aria-label="Reload the app"
      title="Reload the app"
    >
      <LogoIcon />
      <RefreshIcon />
    </button>
  );
}

function LogoIcon() {
  return (
    <svg
      className="brand-logo"
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <line x1="5" y1="15" x2="5" y2="9" />
      <line x1="10" y1="18" x2="10" y2="6" />
      <line x1="14.5" y1="16" x2="14.5" y2="8" />
      <line x1="19" y1="14" x2="19" y2="10" />
    </svg>
  );
}

function RefreshIcon() {
  return (
    <svg
      className="brand-refresh"
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M20 12a8 8 0 1 1-2.34-5.66" />
      <polyline points="20 4 20 10 14 10" />
    </svg>
  );
}

function GearIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

import { memo } from 'react';
import { AudioSourceSelector } from './AudioSourceSelector';
import { OutputDeviceSelector } from './OutputDeviceSelector';
import type { SourceMode } from '../audio/useAudioSource';

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
  // Settings drawer
  panelOpen: boolean;
  onTogglePanel: () => void;
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
  panelOpen,
  onTogglePanel,
}: Props) {
  return (
    <header className="topbar">
      <div className="brand">
        <LogoIcon />
        <div className="title">Audio Visualizer & Modifier</div>
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
        />
        <OutputDeviceSelector
          outputDeviceId={outputDeviceId}
          onSelect={onSelectOutput}
        />
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

function GearIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { AudioSourceSelector } from './components/AudioSourceSelector';
import { AudioStats } from './components/AudioStats';
import { OutputDeviceSelector } from './components/OutputDeviceSelector';
import { SettingsPanel } from './components/SettingsPanel';
import { SpotifyOnboarding } from './components/SpotifyOnboarding';
import { SpotifyPlaylistList } from './components/SpotifyPlaylistList';
import { SpotifyTrackList } from './components/SpotifyTrackList';
import { SpotifyNowPlaying } from './components/SpotifyNowPlaying';
import { EqPanel } from './components/EqPanel';
import { useAudioEngine } from './audio/useAudioEngine';
import { useAudioOutput } from './audio/useAudioOutput';
import { useAudioSource } from './audio/useAudioSource';
import { useSettings } from './state/settings';
import { useSpotify } from './spotify/useSpotify';
import { useEQ } from './state/eq';
import { useEnhancer } from './state/enhancer';
import { PALETTES } from './visualizers/palettes';
import { WaveformVisualizer } from './visualizers';
import './App.css';

const PLAYTHROUGH_KEY = 'av.eq.playthrough';

export function App() {
  const [panelOpen, setPanelOpen] = useState(false);
  const [playthrough, setPlaythrough] = useState<boolean>(
    () => localStorage.getItem(PLAYTHROUGH_KEY) === 'true',
  );
  const { settings, update, reset } = useSettings();
  const eq = useEQ();
  const enhancer = useEnhancer();
  const audioSource = useAudioSource();
  const audioOutput = useAudioOutput();
  const { analyser, analyserL, analyserR } = useAudioEngine(
    audioSource.stream,
    eq.state,
    enhancer.state,
    playthrough && !!audioSource.stream,
    audioOutput.outputDeviceId,
  );
  const spotify = useSpotify();
  const hasSource = audioSource.stream !== null;

  useEffect(() => {
    localStorage.setItem(PLAYTHROUGH_KEY, String(playthrough));
  }, [playthrough]);

  // When Live toggles while we're already capturing system audio, re-acquire
  // the stream with the matching loopback mode. Live ON → `loopbackWithMute`
  // (system muted at speakers, our app plays processed). Live OFF → `loopback`
  // (system plays normally, we just visualize).
  const prevPlaythroughRef = useRef(playthrough);
  useEffect(() => {
    const prev = prevPlaythroughRef.current;
    prevPlaythroughRef.current = playthrough;
    if (audioSource.mode === 'system' && prev !== playthrough) {
      void audioSource.useSystemAudio(playthrough);
    }
  }, [playthrough, audioSource.mode, audioSource.useSystemAudio]);

  const needsOnboarding = !spotify.clientId || !spotify.authed;
  const showPlayerBar = spotify.authed;
  const currentlyPlayingId = spotify.playback?.item?.id ?? null;

  // Drive the whole app's accent color off the active visualizer palette.
  // Every component that highlights with green now uses var(--accent),
  // so switching palette in Settings re-themes the whole UI.
  const palette = PALETTES[settings.palette];
  const accent = palette.glowColor;
  const accentBright = palette.stops[0]?.color ?? accent;
  const themeStyle: CSSProperties = {
    ['--accent' as string]: accent,
    ['--accent-bright' as string]: accentBright,
    ['--accent-bg' as string]: palette.ambient,
    ['--accent-border' as string]: hexToRgba(accent, 0.5),
    ['--accent-soft-bg' as string]: hexToRgba(accent, 0.15),
    ['--accent-glow' as string]: hexToRgba(accent, 0.4),
  };

  return (
    <div className="app" style={themeStyle}>
      <header className="topbar">
        <div className="brand">
          <LogoIcon />
          <div className="title">Audio Visualizer & Modifier</div>
        </div>
        <div className="topbar-right">
          <AudioSourceSelector
            mode={audioSource.mode}
            deviceId={audioSource.deviceId}
            busy={audioSource.busy}
            error={audioSource.error}
            onUseSystemAudio={() => audioSource.useSystemAudio(playthrough)}
            onUseDevice={audioSource.useDevice}
            onDisconnect={audioSource.disconnect}
          />
          <OutputDeviceSelector
            outputDeviceId={audioOutput.outputDeviceId}
            onSelect={audioOutput.setOutputDevice}
          />
          <button
            className="icon-button gear-button"
            onClick={() => setPanelOpen((v) => !v)}
            aria-label="Settings"
            aria-pressed={panelOpen}
          >
            <GearIcon />
          </button>
        </div>
      </header>

      <main className={`main-area ${showPlayerBar ? 'has-player-bar' : ''}`}>
        {needsOnboarding ? (
          <SpotifyOnboarding
            clientId={spotify.clientId}
            authed={spotify.authed}
            authing={spotify.authing}
            authError={spotify.authError}
            saveClientId={spotify.saveClientId}
            connect={spotify.connect}
          />
        ) : (
          <div className="workspace">
            <EqPanel
              state={eq.state}
              setBand={eq.setBand}
              setPreamp={eq.setPreamp}
              setBandCount={eq.setBandCount}
              applyPreset={eq.applyPreset}
              toggleBypass={eq.toggleBypass}
              reset={eq.reset}
              playthrough={playthrough}
              togglePlaythrough={() => setPlaythrough((v) => !v)}
              playthroughDisabled={!hasSource}
              enhancerState={enhancer.state}
              setBass={enhancer.setBass}
              setMid={enhancer.setMid}
              setTreble={enhancer.setTreble}
              setVolume={enhancer.setVolume}
              setBalance={enhancer.setBalance}
              toggleEnhancerBypass={enhancer.toggleBypass}
              resetEnhancer={enhancer.reset}
              accent={accent}
              analyser={analyser}
            />

            <div className="workspace-right">
              <SpotifyPlaylistList
                playlists={spotify.playlists}
                selectedId={spotify.selectedPlaylist?.id ?? null}
                loading={spotify.playlistsLoading}
                onSelect={spotify.selectPlaylist}
                onReconnect={spotify.connect}
                authing={spotify.authing}
              />

              <SpotifyTrackList
                playlist={spotify.selectedPlaylist}
                tracks={spotify.tracks}
                loading={spotify.tracksLoading}
                currentlyPlayingId={currentlyPlayingId}
                onPlay={spotify.playTrack}
                onLoadMore={spotify.loadMoreTracks}
                hasMore={spotify.tracksNextOffset !== null}
              />
            </div>
          </div>
        )}
      </main>

      {analyser && !needsOnboarding && (
        <div className="viz-banner">
          <WaveformVisualizer analyser={analyser} settings={settings} />
          <AudioStats analyser={analyser} analyserL={analyserL} analyserR={analyserR} />
        </div>
      )}

      {showPlayerBar && (
        <SpotifyNowPlaying
          playback={spotify.playback}
          togglePlay={spotify.togglePlay}
          next={spotify.next}
          previous={spotify.previous}
          seek={spotify.seek}
          setVolume={spotify.setVolume}
          signOut={spotify.signOut}
          reconnect={spotify.connect}
        />
      )}

      <SettingsPanel
        open={panelOpen}
        onClose={() => setPanelOpen(false)}
        settings={settings}
        update={update}
        reset={reset}
      />
    </div>
  );
}

/** Convert a hex color (#rrggbb) to an rgba string with the given alpha. */
function hexToRgba(hex: string, alpha: number): string {
  if (!hex.startsWith('#') || hex.length !== 7) return `rgba(29, 215, 96, ${alpha})`;
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
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

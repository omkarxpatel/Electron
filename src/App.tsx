import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { ChromeBar } from './components/ChromeBar';
import { SettingsPanel } from './components/SettingsPanel';
import { SpotifyOnboarding } from './components/SpotifyOnboarding';
import { NowPlayingBar } from './components/NowPlayingBar';
import { SpotifySection } from './components/SpotifySection';
import { VisualizerBanner } from './components/VisualizerBanner';
import { EqSection } from './components/EqSection';
import { useAudioEngine } from './audio/useAudioEngine';
import { useAudioOutput } from './audio/useAudioOutput';
import { useAudioSource } from './audio/useAudioSource';
import { useAutoSelectDevices } from './audio/useAutoSelectDevices';
import { useVisibility } from './hooks/useVisibility';
import { PerfOverlay, useRenderCount } from './perf';
import { useSettings } from './state/settings';
import { SpotifyProvider, useLibrary } from './spotify/SpotifyProvider';
import { useEQ } from './state/eq';
import { useEnhancer } from './state/enhancer';
import { PALETTES } from './visualizers/palettes';
import { hexToRgba } from './shared/color';
import './App.css';

const PLAYTHROUGH_KEY = 'av.eq.playthrough';

export function App() {
  return (
    <SpotifyProvider>
      <AppContent />
    </SpotifyProvider>
  );
}

function AppContent() {
  useRenderCount('App');
  const [panelOpen, setPanelOpen] = useState(false);
  const [playthrough, setPlaythrough] = useState<boolean>(
    () => localStorage.getItem(PLAYTHROUGH_KEY) === 'true',
  );
  const { settings, update, reset } = useSettings();
  const eq = useEQ();
  const enhancer = useEnhancer();
  const audioSource = useAudioSource();
  const audioOutput = useAudioOutput();
  useAutoSelectDevices({
    onUseDevice: audioSource.useDevice,
    onSelectOutput: audioOutput.setOutputDevice,
  });
  // When the window is hidden, after a brief grace period we mark the app
  // inactive — visual loops (canvas RAF, halo, activity bars, audio stats)
  // gate on this and fully suspend, so the app uses no rendering CPU/GPU
  // while it's not on screen. Audio playback is unaffected.
  const isActive = useVisibility(2500);
  // BlackHole compensation — virtual driver routes audio at ~6 dB lower
  // than direct system capture, so we apply +6 dB pre-EQ when the user's
  // active input is a BlackHole channel. Auto-detected from the device label.
  const [inputCompensationDb, setInputCompensationDb] = useState<number>(0);
  useEffect(() => {
    if (audioSource.mode !== 'device' || !audioSource.deviceId) {
      setInputCompensationDb(0);
      return;
    }
    let cancelled = false;
    navigator.mediaDevices
      .enumerateDevices()
      .then((devs) => {
        if (cancelled) return;
        const dev = devs.find((d) => d.deviceId === audioSource.deviceId);
        const isBlackHole = !!dev && /blackhole/i.test(dev.label);
        // Full +6 dB to match perceived parity with direct system capture.
        // The post-master limiter (now at -1 dBFS) catches the resulting peaks
        // without crushing average loudness.
        setInputCompensationDb(isBlackHole ? 6 : 0);
      })
      .catch(() => {
        if (!cancelled) setInputCompensationDb(0);
      });
    return () => {
      cancelled = true;
    };
  }, [audioSource.mode, audioSource.deviceId]);
  // Shared per-band AI delta buffer — written by useAiEnhancer, read each
  // tick by useAudioEngine to add on top of the user's baseline EQ values.
  const aiDeltaRef = useRef<number[]>(new Array(eq.state.bandCount).fill(0));
  // Latest user baseline mirrored into a ref so the AI engine can read it
  // each tick without re-running its effect on every slider move.
  const baselineRef = useRef<number[]>(eq.state.bands);
  baselineRef.current = eq.state.bands;
  const { analyser, analyserL, analyserR, preEqAnalyserL, preEqAnalyserR } = useAudioEngine(
    audioSource.stream,
    eq.state,
    enhancer.state,
    playthrough && !!audioSource.stream,
    audioOutput.outputDeviceId,
    aiDeltaRef,
    eq.state.aiEnhance,
    0.08,
    inputCompensationDb,
  );
  const library = useLibrary();
  const hasSource = audioSource.stream !== null;

  useEffect(() => {
    localStorage.setItem(PLAYTHROUGH_KEY, String(playthrough));
  }, [playthrough]);

  // Reflect Live state in the window title so a glance at the macOS title bar
  // (or Cmd+Tab preview) tells the user whether audio is currently being
  // processed through the EQ chain. Restores on unmount.
  useEffect(() => {
    const base = 'Audio Visualizer & Modifier';
    document.title = playthrough && hasSource ? `${base} — Live` : base;
    return () => {
      document.title = base;
    };
  }, [playthrough, hasSource]);

  // Wire macOS App menu → Settings… (and Cmd+,) to open the Settings drawer.
  // Subscribes once on mount; the preload returns an unsubscribe for cleanup.
  useEffect(() => {
    return window.api.appEvents.onPreferences(() => setPanelOpen(true));
  }, []);

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

  // Stable wrapper so memo'd AudioSourceSelector doesn't re-render on every
  // App tick. The inline `() => audioSource.useSystemAudio(playthrough)` was
  // a fresh function each render.
  const handleUseSystemAudio = useCallback((): void => {
    void audioSource.useSystemAudio(playthrough);
  }, [audioSource.useSystemAudio, playthrough]);

  const needsOnboarding = !library.clientId || !library.authed;
  const showPlayerBar = library.authed;

  // Drive the whole app's accent color off the active visualizer palette.
  // Every component that highlights with green now uses var(--accent),
  // so switching palette in Settings re-themes the whole UI.
  // Memoized so the root <div> doesn't get a new style object identity on
  // every parent render (which would force descendants to reconcile).
  const { accent, themeStyle } = useMemo(() => {
    const palette = PALETTES[settings.palette];
    const accentColor = palette.glowColor;
    const accentBright = palette.stops[0]?.color ?? accentColor;
    const style: CSSProperties = {
      ['--accent' as string]: accentColor,
      ['--accent-bright' as string]: accentBright,
      ['--accent-bg' as string]: palette.ambient,
      ['--accent-border' as string]: hexToRgba(accentColor, 0.5),
      ['--accent-soft-bg' as string]: hexToRgba(accentColor, 0.15),
      ['--accent-glow' as string]: hexToRgba(accentColor, 0.4),
    };
    return { accent: accentColor, themeStyle: style };
  }, [settings.palette]);

  const handleTogglePanel = useCallback((): void => {
    setPanelOpen((v) => !v);
  }, []);
  const handleTogglePlaythrough = useCallback((): void => {
    setPlaythrough((v) => !v);
  }, []);

  return (
    <div className="app" style={themeStyle}>
      <ChromeBar
        sourceMode={audioSource.mode}
        sourceDeviceId={audioSource.deviceId}
        sourceBusy={audioSource.busy}
        sourceError={audioSource.error}
        onUseSystemAudio={handleUseSystemAudio}
        onUseDevice={audioSource.useDevice}
        onDisconnect={audioSource.disconnect}
        outputDeviceId={audioOutput.outputDeviceId}
        onSelectOutput={audioOutput.setOutputDevice}
        panelOpen={panelOpen}
        onTogglePanel={handleTogglePanel}
      />

      <main className={`main-area ${showPlayerBar ? 'has-player-bar' : ''}`}>
        {needsOnboarding ? (
          <SpotifyOnboarding
            clientId={library.clientId}
            authed={library.authed}
            authing={library.authing}
            authError={library.authError}
            saveClientId={library.saveClientId}
            connect={library.connect}
          />
        ) : (
          <div className="workspace">
            <EqSection
              eq={eq}
              enhancer={enhancer}
              preEqAnalyserL={preEqAnalyserL}
              preEqAnalyserR={preEqAnalyserR}
              analyser={analyser}
              aiDeltaRef={aiDeltaRef}
              baselineRef={baselineRef}
              active={isActive}
              playthrough={playthrough}
              togglePlaythrough={handleTogglePlaythrough}
              hasSource={hasSource}
              accent={accent}
            />

            <SpotifySection active={isActive} />
          </div>
        )}
      </main>

      {analyser && !needsOnboarding && (
        <VisualizerBanner
          analyser={analyser}
          analyserL={analyserL}
          analyserR={analyserR}
          settings={settings}
          active={isActive}
        />
      )}

      {showPlayerBar && <NowPlayingBar />}

      <SettingsPanel
        open={panelOpen}
        onClose={() => setPanelOpen(false)}
        settings={settings}
        update={update}
        reset={reset}
        spotifyAuthed={library.authed}
        onReconnectSpotify={library.connect}
        onSignOutSpotify={library.signOut}
      />

      <PerfOverlay />
    </div>
  );
}


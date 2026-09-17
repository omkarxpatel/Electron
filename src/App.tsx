import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { ChromeBar } from './components/ChromeBar';
import { SettingsPanel } from './components/SettingsPanel';
import { SpotifyOnboarding } from './components/SpotifyOnboarding';
import { NowPlayingBar } from './components/NowPlayingBar';
import { SpotifySection } from './components/SpotifySection';
import { UpdateBanner } from './components/UpdateBanner';
import { VisualizerBanner } from './components/VisualizerBanner';
import { ImmersiveLyrics } from './components/ImmersiveLyrics';
import { EqSection } from './components/EqSection';
import { useAudioEngine } from './audio/useAudioEngine';
import { useAudioOutput } from './audio/useAudioOutput';
import { useAudioSource } from './audio/useAudioSource';
import { useAutoSelectDevices } from './audio/useAutoSelectDevices';
import { useVisibility } from './hooks/useVisibility';
import { PerfOverlay, useRenderCount } from './perf';
import { useSettings } from './state/settings';
import { SpotifyProvider, useLibrary, usePlayback } from './spotify/SpotifyProvider';
import { useEQ } from './state/eq';
import { useEnhancer } from './state/enhancer';
import { PALETTES, buildCustomPalette } from './visualizers/palettes';
import { useAlbumPalette } from './visualizers/useAlbumPalette';
import { pickMediumImage } from './shared/image';
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
  const { settings, resolved, update, updateVisual, reset, resetActiveProfile } =
    useSettings();
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
  // NOTE: there used to be an automatic +6 dB "BlackHole compensation" here.
  // It was removed — it sat at inputGain, UPSTREAM of the -1 dBFS / ratio-20
  // limiter, so the limiter clawed it straight back on anything loud:
  //   peak -30 dBFS → +6.00 dB delivered
  //   peak   0 dBFS → +0.30 dB delivered
  // i.e. it did nothing for max loudness (the actual complaint) while acting
  // as an unintended ~6:1 compressor — 6.65 dB of gain reduction on peaks with
  // a 2 ms attack, which is audible pumping on transients. BlackHole is a
  // bit-transparent loopback; it does not attenuate, so there was no input
  // deficit to compensate for in the first place. Perceived quietness in the
  // BlackHole path comes from the OUTPUT side: with system output pointed at
  // BlackHole, the macOS volume slider no longer reaches the built-in
  // speakers, so they stay at whatever hardware level they were left at.
  // That is fixed in Audio MIDI Setup, not with digital gain.
  // Shared per-band AI delta buffer — written by useAiEnhancer, read each
  // tick by useAudioEngine to add on top of the user's baseline EQ values.
  const aiDeltaRef = useRef<number[]>(new Array(eq.state.bandCount).fill(0));
  // Latest user baseline mirrored into a ref so the AI engine can read it
  // each tick without re-running its effect on every slider move.
  const baselineRef = useRef<number[]>(eq.state.bands);
  baselineRef.current = eq.state.bands;
  const { analyser, analyserL, analyserR, preEqAnalyserL, preEqAnalyserR } =
    useAudioEngine(
    audioSource.stream,
    eq.state,
    enhancer.state,
    playthrough && !!audioSource.stream,
    audioOutput.outputDeviceId,
    aiDeltaRef,
    eq.state.aiEnhance,
    0.08,
  );
  const library = useLibrary();
  // Subscribing to playback re-renders AppContent on each 1.5s poll, but
  // App's heavy children are memoized and the only prop that flows from
  // playback (`albumPalette`) only changes when the album image URL changes —
  // i.e. once per song. The Settings toggle gates the whole hook so users
  // who don't opt in pay only a context subscription cost.
  const playback = usePlayback();
  const albumImageUrl = useMemo(
    () => pickMediumImage(playback.playback?.item?.album?.images) ?? null,
    [playback.playback?.item?.album?.images],
  );
  const albumPalette = useAlbumPalette(albumImageUrl, settings.autoTintFromAlbumArt);
  const hasSource = audioSource.stream !== null;

  useEffect(() => {
    localStorage.setItem(PLAYTHROUGH_KEY, String(playthrough));
  }, [playthrough]);

  // Reflect Live state in the window title so a glance at the macOS title bar
  // (or Cmd+Tab preview) tells the user whether audio is currently being
  // processed through the EQ chain. Restores on unmount.
  useEffect(() => {
    const base = 'Electron';
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

  // Drive the whole app's accent color off the effective palette — either a
  // synthesized one extracted from the current album art (when "Auto-tint
  // from album art" is on AND a Spotify track is playing) or the user's
  // chosen static palette from Settings. Every component that highlights
  // with green uses var(--accent), so switching either source re-themes the
  // whole UI.
  // Memoized so the root <div> doesn't get a new style object identity on
  // every parent render (which would force descendants to reconcile).
  // 'custom' is synthesized from the user's three stops rather than looked
  // up, so edits take effect without a palette-table entry per color combo.
  const basePalette = useMemo(
    () =>
      settings.palette === 'custom'
        ? buildCustomPalette(settings.customColors)
        : PALETTES[settings.palette],
    [settings.palette, settings.customColors],
  );
  const effectivePalette = albumPalette ?? basePalette;
  const { accent, themeStyle } = useMemo(() => {
    const accentColor = effectivePalette.glowColor;
    const accentBright = effectivePalette.stops[0]?.color ?? accentColor;
    const style: CSSProperties = {
      ['--accent' as string]: accentColor,
      ['--accent-bright' as string]: accentBright,
      ['--accent-bg' as string]: effectivePalette.ambient,
      ['--accent-border' as string]: hexToRgba(accentColor, 0.5),
      ['--accent-soft-bg' as string]: hexToRgba(accentColor, 0.15),
      ['--accent-glow' as string]: hexToRgba(accentColor, 0.4),
    };
    return { accent: accentColor, themeStyle: style };
  }, [effectivePalette]);

  // Esc leaves visuals-only mode. Registered only while immersive so we
  // don't add a global key listener for a mode that is usually off, and so
  // Esc keeps its normal meaning (closing the settings panel) otherwise.
  useEffect(() => {
    if (!settings.immersive) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      // One Esc should undo one thing. With the drawer open, Esc closes it
      // and stays immersive; a second Esc leaves immersive.
      if (panelOpen) setPanelOpen(false);
      else update('immersive', false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [settings.immersive, panelOpen, update]);

  const handleEnterImmersive = useCallback((): void => {
    update('immersive', true);
  }, [update]);
  const handleTogglePanel = useCallback((): void => {
    setPanelOpen((v) => !v);
  }, []);
  const handleTogglePlaythrough = useCallback((): void => {
    setPlaythrough((v) => !v);
  }, []);

  return (
    <div className="app" data-immersive={settings.immersive ? 'true' : 'false'} style={themeStyle}>
      {settings.albumArtBackdrop && albumImageUrl && (
        // key forces a fresh element per track so the fade-in replays instead
        // of the browser swapping src on a already-opaque image.
        <div className="album-backdrop" key={albumImageUrl} aria-hidden>
          <img src={albumImageUrl} alt="" />
        </div>
      )}
      <UpdateBanner />
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
        onEnterImmersive={handleEnterImmersive}
      />

      <main className={`main-area ${showPlayerBar ? 'has-player-bar' : ''}`}>
        {needsOnboarding ? (
          <SpotifyOnboarding
            clientId={library.clientId}
            authed={library.authed}
            authing={library.authing}
            authError={library.authError}
            saveClientId={library.saveClientId}
            resetClientId={library.resetClientId}
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
              analyserL={analyserL}
              analyserR={analyserR}
              aiDeltaRef={aiDeltaRef}
              baselineRef={baselineRef}
              active={isActive}
              playthrough={playthrough}
              togglePlaythrough={handleTogglePlaythrough}
              hasSource={hasSource}
              accent={accent}
              paletteId={settings.palette}
              paletteOverride={albumPalette}
            />

            <SpotifySection active={isActive} showLyrics={settings.showLyrics} />
          </div>
        )}
      </main>

      {analyser && !needsOnboarding && (
        <VisualizerBanner
          analyser={analyser}
          analyserL={analyserL}
          analyserR={analyserR}
          settings={resolved}
          active={isActive}
          paletteOverride={albumPalette}
        />
      )}

      {showPlayerBar && <NowPlayingBar />}

      <SettingsPanel
        open={panelOpen}
        onClose={() => setPanelOpen(false)}
        settings={resolved}
        update={update}
        updateVisual={updateVisual}
        resetActiveProfile={resetActiveProfile}
        reset={reset}
        spotifyAuthed={library.authed}
        onReconnectSpotify={library.connect}
        onSignOutSpotify={library.signOut}
      />

      {settings.immersive && settings.showLyrics && <ImmersiveLyrics active={isActive} />}

      {settings.immersive && (
        <div className="immersive-controls">
          <button
            className="immersive-chip"
            onClick={handleTogglePanel}
            aria-pressed={panelOpen}
            title="Visual settings"
          >
            Settings
          </button>
          <button
            className="immersive-chip"
            onClick={() => update('immersive', false)}
            title="Exit visuals-only mode (Esc)"
          >
            Exit visuals
          </button>
        </div>
      )}

      <PerfOverlay />
    </div>
  );
}


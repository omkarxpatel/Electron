import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { ChromeBar } from './components/ChromeBar';
import { SettingsPanel } from './components/SettingsPanel';
import { SpotifyOnboarding } from './components/SpotifyOnboarding';
import { NowPlayingBar } from './components/NowPlayingBar';
import { SpotifySection } from './components/SpotifySection';
import { SectionBoundary } from './components/SectionBoundary';
import { TrayBridge } from './components/TrayBridge';
import { NotchBridge } from './components/NotchBridge';
import { UpdateBanner } from './components/UpdateBanner';
import { UpdatedNotice } from './components/UpdatedNotice';
import { UpdateDialog } from './components/UpdateDialog';
import { VisualizerBanner } from './components/VisualizerBanner';
import { ImmersiveLyrics } from './components/ImmersiveLyrics';
import { EqSection } from './components/EqSection';
import type { AiEffectTargets } from './audio/useAiEnhancer';
import type { DjBridge } from './components/SpotifySection';
import type { LiveMeasurement } from './components/DjPanel';
import { useTrackMemory } from './state/trackMemory';
import { useAudioEngine } from './audio/useAudioEngine';
import { useAudioOutput } from './audio/useAudioOutput';
import { useAudioSource } from './audio/useAudioSource';
import { useSinkVolumePin } from './audio/useSinkVolumePin';
import { useAutoSelectDevices } from './audio/useAutoSelectDevices';
import { useVisibility } from './hooks/useVisibility';
import { PerfOverlay, useRenderCount } from './perf';
import { useSettings } from './state/settings';
import { useQuality } from './state/quality';
import { SpotifyProvider, useLibrary, usePlayback } from './spotify/SpotifyProvider';
import { useEQ } from './state/eq';
import { useEnhancer } from './state/enhancer';
import { useEffectsRack } from './state/effects';
import { PALETTES, buildCustomPalette } from './visualizers/palettes';
import { useAlbumPalette } from './visualizers/useAlbumPalette';
import { pickMediumImage } from './shared/image';
import { hexToRgba } from './shared/color';
import './App.css';

/** Spotify's own normalisation reference, so the two agree rather than fight. */
const AUTO_LEVEL_TARGET_LUFS = -14;
/** Most a track may be moved. Beyond this the correction costs more headroom
 *  than the level difference is worth, and the limiter is downstream. */
const AUTO_LEVEL_MAX_DB = 6;

const PLAYTHROUGH_KEY = 'av.eq.playthrough';
const RIGHT_COLLAPSED_KEY = 'av.rightPanel.collapsed';

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
  const effects = useEffectsRack();
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
  // Machine capability -> render scale and frame cap. Resolves asynchronously
  // from main; until it does, `knobs` is full quality, so a slow profile read
  // can never make the visualizer start out degraded.
  const quality = useQuality();
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
  // Shared AI effect targets — same arrangement as aiDeltaRef: written by
  // useAiEnhancer, read each tick by useAudioEngine.
  const aiEffectsRef = useRef<AiEffectTargets>({
    active: false,
    width: 100,
    exciter: 0,
    exciterFreq: 90,
  });
  // One instance, shared by the enhancer (which writes it) and Settings
  // (which reports its size and clears it) — a second would hold its own
  // copy of the store and the two would diverge on the first commit.
  const trackMemory = useTrackMemory(settings.rememberTracks);
  // Subscribing to playback re-renders AppContent on each 1.5s poll, but
  // App's heavy children are memoized and the only prop that flows from
  // playback (`albumPalette`) only changes when the album image URL changes —
  // i.e. once per song. Declared above the audio engine because the level
  // match below has to reach it.
  const playback = usePlayback();
  /**
   * Level match for the current track.
   *
   * Only acts on a track already in memory: integrated loudness is a
   * property of the whole track, so there is nothing honest to apply until
   * one has been heard through. Deriving it live from short-term loudness
   * instead would be a compressor, not a level match, and would pump.
   *
   * -14 LUFS is Spotify's own reference, so with their normalisation on this
   * is close to a no-op and with it off it brings everything to the same
   * place. Clamped because a wildly quiet master should be brought up some
   * of the way, not all of it — the headroom is not free and the limiter is
   * downstream.
   */
  const autoLevelDb = useMemo(() => {
    if (!settings.autoLevel) return 0;
    const known = trackMemory.recall(playback.playback?.item?.id ?? null);
    if (!known || known.lufs === null) return 0;
    const wanted = AUTO_LEVEL_TARGET_LUFS - known.lufs;
    return Math.max(-AUTO_LEVEL_MAX_DB, Math.min(AUTO_LEVEL_MAX_DB, wanted));
  }, [settings.autoLevel, trackMemory, playback.playback?.item?.id]);

  /**
   * Live key and tempo of the playing track, pushed up by the enhancer.
   *
   * The DJ view needs to know what it is mixing OUT of, and the stored
   * profile only exists once a track has been played through — so on a first
   * listen the live reading is the only reading there is. Just the two
   * numbers, not the whole enhancer status, because the rest of it moves
   * several times a second and App re-rendering at that rate would be a
   * needless cost.
   */
  const [liveMeasurement, setLiveMeasurement] = useState<LiveMeasurement | null>(null);

  const {
    analyser, analyserL, analyserR, preEqAnalyserL, preEqAnalyserR,
    chromaAnalyser, limiter, loudnessTapRef, onsetTapRef, duckGainRef, voiceGainRef,
  } =
    useAudioEngine(
    audioSource.stream,
    eq.state,
    enhancer.state,
    effects.state,
    playthrough && !!audioSource.stream,
    audioOutput.outputDeviceId,
    aiDeltaRef,
    eq.state.aiEnhance,
    0.08,
    aiEffectsRef,
    autoLevelDb,
  );
  // Hold the output device at unity while we're actually playing through it.
  // The macOS slider only reaches the DEFAULT output device, so once system
  // output is BlackHole nothing can reach our sink and it stays frozen at
  // whatever level it held — a hard ceiling on how loud the app can get.
  const sinkVolume = useSinkVolumePin(
    audioOutput.outputDeviceId,
    playthrough && !!audioSource.stream,
  );
  const library = useLibrary();
  const albumImageUrl = useMemo(
    () => pickMediumImage(playback.playback?.item?.album?.images) ?? null,
    [playback.playback?.item?.album?.images],
  );
  const albumPalette = useAlbumPalette(albumImageUrl, settings.autoTintFromAlbumArt);
  const hasSource = audioSource.stream !== null;

  useEffect(() => {
    localStorage.setItem(PLAYTHROUGH_KEY, String(playthrough));
  }, [playthrough]);

  // Tell main whether sound is actually coming out of us. A release marked
  // `silent` may restart the app once the machine goes unattended, and
  // "unattended" is measured from keyboard and mouse — which says nothing
  // about someone listening with the window in the background.
  const audioActive = playthrough && !!audioSource.stream;

  /**
   * What the overlay's DJ view needs, gathered in one object.
   *
   * Assembled here because App owns the only `useTrackMemory` instance and
   * the audio graph's nodes are its refs — SpotifySection reads everything
   * else from context, but neither of those is in a context.
   *
   * `audible` is the same flag the rest of the app uses for "we are the ones
   * making the sound". When it is false the user is listening to Spotify
   * directly, so there is nothing to duck and nowhere to put a voice, and the
   * commentary degrades to text.
   */
  const djBridge = useMemo<DjBridge>(
    () => ({
      currentTrack: playback.playback?.item ?? null,
      live: liveMeasurement,
      recall: trackMemory.recall,
      audible: audioActive,
      duckGainRef,
      voiceGainRef,
    }),
    [playback.playback?.item, liveMeasurement, trackMemory.recall, audioActive, duckGainRef, voiceGainRef],
  );
  useEffect(() => {
    window.api.update.setActivity(audioActive);
  }, [audioActive]);

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

  // Collapse the right column so the visualizer + EQ get the whole width.
  // Lives on `.app` rather than `.workspace` because HoverOverlayPanel is
  // fixed-positioned and has to stop short of the right column — it reads
  // the same --right-col-w, and a class further down wouldn't reach it.
  //
  // Persisted, like playthrough above: this is a layout choice about how you
  // want the app to look, and it survived neither a relaunch nor one of dev
  // mode's reloads.
  const [rightCollapsed, setRightCollapsed] = useState<boolean>(
    () => localStorage.getItem(RIGHT_COLLAPSED_KEY) === 'true',
  );
  const toggleRightCollapsed = useCallback((): void => {
    setRightCollapsed((v) => !v);
  }, []);
  useEffect(() => {
    localStorage.setItem(RIGHT_COLLAPSED_KEY, String(rightCollapsed));
  }, [rightCollapsed]);

  return (
    <div
      className="app"
      data-immersive={settings.immersive ? 'true' : 'false'}
      data-right-collapsed={rightCollapsed ? 'true' : 'false'}
      style={themeStyle}
    >
      {settings.albumArtBackdrop && albumImageUrl && (
        // key forces a fresh element per track so the fade-in replays instead
        // of the browser swapping src on a already-opaque image.
        <div className="album-backdrop" key={albumImageUrl} aria-hidden>
          <img src={albumImageUrl} alt="" />
        </div>
      )}
      <UpdateBanner />
      <UpdatedNotice />
      <UpdateDialog />
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
        sinkVolume={sinkVolume}
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
              onMeasurement={setLiveMeasurement}
              trackMemory={trackMemory}
              loudnessTapRef={loudnessTapRef}
              onsetTapRef={onsetTapRef}
              eq={eq}
              enhancer={enhancer}
              effects={effects}
              preEqAnalyserL={preEqAnalyserL}
              preEqAnalyserR={preEqAnalyserR}
              chromaAnalyser={chromaAnalyser}
              analyser={analyser}
              analyserL={analyserL}
              analyserR={analyserR}
              limiter={limiter}
              aiDeltaRef={aiDeltaRef}
              aiEffectsRef={aiEffectsRef}
              baselineRef={baselineRef}
              active={isActive}
              playthrough={playthrough}
              togglePlaythrough={handleTogglePlaythrough}
              hasSource={hasSource}
              accent={accent}
              paletteId={settings.palette}
              paletteOverride={albumPalette}
            />

            <SectionBoundary label="Spotify panel">
              <SpotifySection
                dj={djBridge}
                active={isActive}
                showLyrics={settings.showLyrics}
                collapsed={rightCollapsed}
                onToggleCollapsed={toggleRightCollapsed}
              />
            </SectionBoundary>
          </div>
        )}
      </main>

      {analyser && !needsOnboarding && (
        <SectionBoundary label="visualizer">
        <VisualizerBanner
          analyser={analyser}
          analyserL={analyserL}
          analyserR={analyserR}
          settings={resolved}
          active={isActive}
          paletteOverride={albumPalette}
          quality={quality.knobs}
        />
        </SectionBoundary>
      )}

      {showPlayerBar && (
        <SectionBoundary label="player bar">
          <NowPlayingBar />
        </SectionBoundary>
      )}

      <SettingsPanel
        trackMemory={trackMemory}
        open={panelOpen}
        onClose={() => setPanelOpen(false)}
        settings={resolved}
        update={update}
        updateVisual={updateVisual}
        resetActiveProfile={resetActiveProfile}
        reset={reset}
        quality={quality}
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

      <TrayBridge />
      <NotchBridge albumPalette={albumPalette} />

      <PerfOverlay />
    </div>
  );
}


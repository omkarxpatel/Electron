import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { ChromeBar } from './components/ChromeBar';
import { SettingsPanel } from './components/SettingsPanel';
import { SpotifyOnboarding } from './components/SpotifyOnboarding';
import { NowPlayingBar } from './components/NowPlayingBar';
import { SpotifySection } from './components/SpotifySection';
import { VisualizerBanner } from './components/VisualizerBanner';
import { EqPanel } from './components/EqPanel';
import { useAiEnhancer } from './audio/useAiEnhancer';
import { useAudioEngine } from './audio/useAudioEngine';
import { useAudioOutput } from './audio/useAudioOutput';
import { useAudioSource } from './audio/useAudioSource';
import { useAutoSelectDevices } from './audio/useAutoSelectDevices';
import { useVisibility } from './hooks/useVisibility';
import { PerfOverlay, useRenderCount } from './perf';
import { frequenciesFor } from './state/eq';
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
  // Per-band AI delta mirrored from the engine's ref into React state so
  // the slider thumbs visually follow the AI's adjustments. Updated 10×/sec.
  const [aiDelta, setAiDelta] = useState<number[]>(
    () => new Array(eq.state.bandCount).fill(0),
  );
  // Transient per-band "just nudged" flags — true for ~500ms after a >0.05dB
  // change, drives the slider-pulse animation.
  const [bandAutoActive, setBandAutoActive] = useState<boolean[]>(
    () => new Array(eq.state.bandCount).fill(false),
  );
  const flashClearTimersRef = useRef<number[]>([]);
  // Last AI-delta value we actually dispatched to React state. The AI tick
  // fires 10×/sec but band values usually drift by tiny fractional dBs; we
  // only dispatch when any band has moved by a perceptible amount. This
  // collapses 10 renders/sec down to roughly 1–2/sec under normal use, which
  // is the single biggest source of render cascade in the app.
  const lastDispatchedAiDeltaRef = useRef<number[]>([]);
  const AI_DELTA_THRESHOLD_DB = 0.05;
  // Stable bandFreqs reference (frequenciesFor builds a fresh array each call);
  // useAiEnhancer's effect deps include this so an unstable identity would
  // tear down + rebuild the engine on every render.
  const aiBandFreqs = useMemo(
    () => frequenciesFor(eq.state.bandCount),
    [eq.state.bandCount],
  );
  const aiHandle = useAiEnhancer({
    analyserL: preEqAnalyserL,
    analyserR: preEqAnalyserR,
    enabled: eq.state.aiEnhance,
    bandCount: eq.state.bandCount,
    locked: eq.state.locked,
    deltaRef: aiDeltaRef,
    baselineRef,
    bandFreqs: aiBandFreqs,
    onTick: (deltas, flashed) => {
      // Threshold-diff: only setState when band values have moved enough
      // to be visually distinguishable on the slider thumb.
      const last = lastDispatchedAiDeltaRef.current;
      let shouldDispatch = last.length !== deltas.length;
      if (!shouldDispatch) {
        for (let i = 0; i < deltas.length; i++) {
          if (Math.abs(deltas[i] - last[i]) > AI_DELTA_THRESHOLD_DB) {
            shouldDispatch = true;
            break;
          }
        }
      }
      if (shouldDispatch) {
        // `deltas` is the engine's reusable snapshot buffer (same ref every
        // tick) — copy here so React state gets a new identity for memo'd
        // downstream components.
        const fresh = deltas.slice();
        lastDispatchedAiDeltaRef.current = fresh;
        setAiDelta(fresh);
      }
      if (flashed.some(Boolean)) {
        // `flashed` is the engine's reusable buffer — snapshot before queuing
        // the setBandAutoActive functional update, otherwise the next tick
        // could mutate it before React processes our update.
        const flashedSnap = flashed.slice();
        setBandAutoActive((prev) => {
          const next = prev.length === flashedSnap.length ? prev.slice() : new Array(flashedSnap.length).fill(false);
          for (let i = 0; i < flashedSnap.length; i++) {
            if (flashedSnap[i]) next[i] = true;
          }
          return next;
        });
        for (let i = 0; i < flashedSnap.length; i++) {
          if (!flashedSnap[i]) continue;
          if (flashClearTimersRef.current[i]) window.clearTimeout(flashClearTimersRef.current[i]);
          flashClearTimersRef.current[i] = window.setTimeout(() => {
            setBandAutoActive((prev) => {
              if (!prev[i]) return prev;
              const next = prev.slice();
              next[i] = false;
              return next;
            });
          }, 520);
        }
      }
    },
  });
  // `aiHandle` is a fresh object each render (the hook returns a literal),
  // so capture its current `noteUserTouch` in a ref. Lets the setBand wrapper
  // below stay stable across renders.
  const aiNoteUserTouchRef = useRef(aiHandle.noteUserTouch);
  aiNoteUserTouchRef.current = aiHandle.noteUserTouch;
  // Stable wrapper for EqPanel.setBand. `eq.setBand` is already useCallback'd
  // in useEQ, so this useCallback truly stabilizes across renders.
  const handleSetBand = useCallback(
    (i: number, v: number) => {
      aiNoteUserTouchRef.current(i);
      eq.setBand(i, v);
    },
    [eq.setBand],
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
            <EqPanel
              state={eq.state}
              setBand={handleSetBand}
              setPreamp={eq.setPreamp}
              setBandCount={eq.setBandCount}
              applyPreset={eq.applyPreset}
              toggleBypass={eq.toggleBypass}
              toggleBandLock={eq.toggleBandLock}
              toggleAiEnhance={eq.toggleAiEnhance}
              bandAutoActive={bandAutoActive}
              aiDelta={aiDelta}
              active={isActive}
              reset={eq.reset}
              playthrough={playthrough}
              togglePlaythrough={handleTogglePlaythrough}
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


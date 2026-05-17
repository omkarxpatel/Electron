import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { AudioSourceSelector } from './components/AudioSourceSelector';
import { AudioStats } from './components/AudioStats';
import { OutputDeviceSelector } from './components/OutputDeviceSelector';
import { SettingsPanel } from './components/SettingsPanel';
import { SpotifyOnboarding } from './components/SpotifyOnboarding';
import { LyricsPane } from './components/LyricsPane';
import { prefetchLyrics } from './lyrics/useLyrics';
import { getQueue } from './spotify/api';
import { HoverOverlayPanel } from './components/HoverOverlayPanel';
import { SpotifyOverlay } from './components/SpotifyOverlay';
import { SpotifyTrackList } from './components/SpotifyTrackList';
import { SpotifyNowPlaying } from './components/SpotifyNowPlaying';
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
import { useSpotify } from './spotify/useSpotify';
import { useEQ } from './state/eq';
import { useEnhancer } from './state/enhancer';
import { PALETTES } from './visualizers/palettes';
import { WaveformVisualizer } from './visualizers';
import './App.css';

const PLAYTHROUGH_KEY = 'av.eq.playthrough';

export function App() {
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
  const spotify = useSpotify();
  const hasSource = audioSource.stream !== null;

  /* ── Spotify overlay panel: hover-open with a 300ms close grace period.
   *    Trigger lives in the playlist sidebar (music icon); panel is the
   *    HoverOverlayPanel mounted at the App level. Both elements share these
   *    handlers so moving the cursor between them keeps the panel open. */
  const [overlayOpen, setOverlayOpen] = useState<boolean>(false);
  const overlayCloseTimerRef = useRef<number | null>(null);
  const cancelOverlayClose = useCallback((): void => {
    if (overlayCloseTimerRef.current !== null) {
      window.clearTimeout(overlayCloseTimerRef.current);
      overlayCloseTimerRef.current = null;
    }
  }, []);
  const requestOverlayClose = useCallback((): void => {
    cancelOverlayClose();
    overlayCloseTimerRef.current = window.setTimeout(() => {
      setOverlayOpen(false);
      overlayCloseTimerRef.current = null;
    }, 300);
  }, [cancelOverlayClose]);
  const openOverlay = useCallback((): void => {
    cancelOverlayClose();
    setOverlayOpen(true);
  }, [cancelOverlayClose]);
  const closeOverlay = useCallback((): void => {
    cancelOverlayClose();
    setOverlayOpen(false);
  }, [cancelOverlayClose]);
  useEffect(() => () => cancelOverlayClose(), [cancelOverlayClose]);
  // Stable trigger-props object — only changes when `overlayOpen` flips.
  // Without useMemo here the music-icon button received fresh handler refs
  // every parent render, which defeats its memoization potential.
  const overlayTriggerProps = useMemo(
    () => ({
      onMouseEnter: openOverlay,
      onMouseLeave: requestOverlayClose,
      onClick: () => (overlayOpen ? closeOverlay() : openOverlay()),
      'aria-expanded': overlayOpen,
    }),
    [overlayOpen, openOverlay, requestOverlayClose, closeOverlay],
  );

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
  // Derived from the playback object; cached so it has stable identity until
  // the actual track changes (the playback poll dispatches new playback
  // objects on relevant changes, so memo depends on item.id explicitly).
  const playingItemId = spotify.playback?.item?.id;
  const currentlyPlayingId = useMemo(() => playingItemId ?? null, [playingItemId]);

  // Lyrics prefetch — whenever the current track changes, fetch the queue
  // and prime the lyrics cache for the next ~2 upcoming tracks. By the time
  // the user advances, those lyrics are already in memory and render instantly.
  useEffect(() => {
    if (!spotify.authed || !currentlyPlayingId) return;
    let cancelled = false;
    // Slight delay so the queue is up-to-date after the track change has
    // propagated through Spotify's servers.
    const t = window.setTimeout(() => {
      void getQueue()
        .then((q) => {
          if (cancelled || !q) return;
          for (const upcoming of q.queue.slice(0, 2)) {
            if (!upcoming) continue;
            const title = upcoming.name;
            const artist = upcoming.artists?.[0]?.name;
            if (!title || !artist) continue;
            prefetchLyrics(title, artist, upcoming.album?.name, upcoming.duration_ms);
          }
        })
        .catch(() => {
          /* queue read failures aren't worth surfacing — silent skip */
        });
    }, 600);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [spotify.authed, currentlyPlayingId]);

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
              <div className="sp-right-header">
                <button
                  type="button"
                  className="sp-right-music-icon"
                  data-active={overlayOpen ? 'true' : 'false'}
                  aria-label="Open Spotify library"
                  title="Hover to open library, search & queue"
                  {...overlayTriggerProps}
                >
                  <IconLibrary />
                </button>
              </div>

              <SpotifyTrackList
                playlist={spotify.selectedPlaylist}
                tracks={spotify.tracks}
                loading={spotify.tracksLoading}
                currentlyPlayingId={currentlyPlayingId}
                onPlay={spotify.playTrack}
                onLoadMore={spotify.loadMoreTracks}
                hasMore={spotify.tracksNextOffset !== null}
              />

              <LyricsPane playback={spotify.playback} active={isActive} />
            </div>
          </div>
        )}
      </main>

      {analyser && !needsOnboarding && (
        <div className="viz-banner">
          <WaveformVisualizer analyser={analyser} settings={settings} active={isActive} />
          <AudioStats analyser={analyser} analyserL={analyserL} analyserR={analyserR} active={isActive} />
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
          toggleShuffle={spotify.toggleShuffle}
          cycleRepeat={spotify.cycleRepeat}
          toggleSaveCurrent={spotify.toggleSaveCurrent}
          savedCurrent={spotify.savedCurrent}
        />
      )}

      {!needsOnboarding && (
        <HoverOverlayPanel
          title="Spotify"
          open={overlayOpen}
          onMouseEnter={openOverlay}
          onMouseLeave={requestOverlayClose}
          onClose={closeOverlay}
        >
          <SpotifyOverlay
            playlists={spotify.playlists}
            playlistsLoading={spotify.playlistsLoading}
            selectedPlaylistId={spotify.selectedPlaylist?.id ?? null}
            onSelectPlaylist={spotify.selectPlaylist}
            searchTracks={spotify.searchTracks}
            playTrack={spotify.playTrack}
            currentlyPlayingId={currentlyPlayingId}
            open={overlayOpen}
            onClose={closeOverlay}
          />
        </HoverOverlayPanel>
      )}

      <SettingsPanel
        open={panelOpen}
        onClose={() => setPanelOpen(false)}
        settings={settings}
        update={update}
        reset={reset}
        spotifyAuthed={spotify.authed}
        onReconnectSpotify={spotify.connect}
        onSignOutSpotify={spotify.signOut}
      />

      <PerfOverlay />
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

function IconLibrary() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M9 18V5l12-2v13" />
      <circle cx="6" cy="18" r="3" />
      <circle cx="18" cy="16" r="3" />
    </svg>
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

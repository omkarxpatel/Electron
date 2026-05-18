import { useCallback, useMemo, useRef, useState } from 'react';
import { EqPanel } from './EqPanel';
import { useAiEnhancer } from '../audio/useAiEnhancer';
import { frequenciesFor, type UseEQReturn } from '../state/eq';
import type { UseEnhancerReturn } from '../state/enhancer';

/**
 * Owns the AI-Enhancer plumbing (useAiEnhancer + the threshold-diff onTick
 * that throttles 10 Hz engine ticks down to 1–2 React renders/sec) and the
 * stable handleSetBand wrapper that notifies the AI of user touches.
 *
 * Does NOT own useEQ / useEnhancer — App still calls those so the audio
 * engine (which lives in App) can see fresh eq + enhancer state directly
 * without a context round-trip on every slider tick.
 *
 * Reading order inside EqSection (avoids the AI engine doing useless work):
 *   - aiHandle.noteUserTouch reaches handleSetBand via a ref bridge — the
 *     hook returns a fresh object literal each render, so we can't read it
 *     directly inside a stable useCallback.
 *   - aiDelta / bandAutoActive setState updates flow ONLY when band values
 *     have moved by > 0.05 dB (visually distinguishable on the slider thumb).
 */

interface Props {
  eq: UseEQReturn;
  enhancer: UseEnhancerReturn;
  /** Pre-EQ analyser nodes feeding the AI Enhancer's FFT. Null when the
   *  audio graph hasn't built yet (no stream). */
  preEqAnalyserL: AnalyserNode | null;
  preEqAnalyserR: AnalyserNode | null;
  /** Post-EQ analyser — drives the response-curve halo + per-band activity. */
  analyser: AnalyserNode | null;
  /** Shared per-band AI delta ref. The audio engine reads it each tick to
   *  add on top of the user's baseline; useAiEnhancer writes to it. */
  aiDeltaRef: { current: number[] };
  /** Shared baseline ref — the audio engine + AI engine both read it. */
  baselineRef: { current: number[] };
  /** When false, the response-curve halo + band-activity RAF loops pause. */
  active: boolean;
  /** Live (playthrough) state, owned by App because the audio source toggle
   *  also depends on it. */
  playthrough: boolean;
  togglePlaythrough: () => void;
  hasSource: boolean;
  accent: string;
}

const AI_DELTA_THRESHOLD_DB = 0.05;

export function EqSection({
  eq,
  enhancer,
  preEqAnalyserL,
  preEqAnalyserR,
  analyser,
  aiDeltaRef,
  baselineRef,
  active,
  playthrough,
  togglePlaythrough,
  hasSource,
  accent,
}: Props) {
  // Per-band AI delta mirrored from the engine's ref into React state so
  // the slider thumbs visually follow the AI's adjustments. Updated 10×/sec
  // upstream, throttled below the AI_DELTA_THRESHOLD before reaching state.
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
  // collapses 10 renders/sec down to roughly 1–2/sec under normal use.
  const lastDispatchedAiDeltaRef = useRef<number[]>([]);
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
          const next =
            prev.length === flashedSnap.length
              ? prev.slice()
              : new Array(flashedSnap.length).fill(false);
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

  return (
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
      active={active}
      reset={eq.reset}
      playthrough={playthrough}
      togglePlaythrough={togglePlaythrough}
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
  );
}

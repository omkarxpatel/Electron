import { useEffect, useRef, useState } from 'react';
import type { EQState } from '../state/eq';
import { frequenciesFor, qFor } from '../state/eq';
import type { EnhancerState } from '../state/enhancer';

interface AudioEngineState {
  analyser: AnalyserNode | null;
  analyserL: AnalyserNode | null;
  analyserR: AnalyserNode | null;
  error: string | null;
  status: 'Idle' | 'Connecting' | 'Listening' | 'Error';
}

const PARAM_RAMP = 0.02; // 20 ms smoothing on parameter changes — avoids zipper noise

/**
 * Build and manage the audio graph:
 *
 *   [device input] → MediaStreamSource
 *                       │
 *                       ▼
 *                  PreampGain
 *                       │
 *           ┌───────────┴────────────────┐
 *           ▼ EQ band 0 .. N-1 (biquads) │  ← rebuilt when bandCount changes
 *                       │                │
 *                       ▼                │
 *           ┌──────────────────┐         │
 *           │ Enhancer:        │         │
 *           │  Bass shelf      │         │
 *           │  Treble shelf    │         │
 *           │  Loudness comp   │         │
 *           │  Makeup gain     │         │
 *           └──────────────────┘         │
 *                       │                │
 *                       ▼                │
 *                   AnalyserNode  ──► (visualizer reads here)
 *                       │
 *                       ▼
 *        ctx.destination  (only when `playthrough` is true)
 *
 * The chain is rebuilt when `deviceId` or `bandCount` change (graph-shape
 * level changes). Slider/preset moves apply through `setTargetAtTime` so
 * they don't click and don't rebuild anything.
 */
type AudioContextWithSink = AudioContext & {
  setSinkId?: (sinkId: string | { type: 'none' }) => Promise<void>;
};

export function useAudioEngine(
  stream: MediaStream | null,
  eqState: EQState,
  enhancerState: EnhancerState,
  playthrough: boolean,
  outputDeviceId: string | null,
): AudioEngineState {
  const [analyser, setAnalyser] = useState<AnalyserNode | null>(null);
  const [analyserL, setAnalyserL] = useState<AnalyserNode | null>(null);
  const [analyserR, setAnalyserR] = useState<AnalyserNode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<AudioEngineState['status']>('Idle');

  const ctxRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const preampRef = useRef<GainNode | null>(null);
  const filtersRef = useRef<BiquadFilterNode[]>([]);
  const bassShelfRef = useRef<BiquadFilterNode | null>(null);
  const midPeakRef = useRef<BiquadFilterNode | null>(null);
  const trebleShelfRef = useRef<BiquadFilterNode | null>(null);
  const pannerRef = useRef<StereoPannerNode | null>(null);
  const masterGainRef = useRef<GainNode | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const splitterRef = useRef<ChannelSplitterNode | null>(null);
  const analyserLRef = useRef<AnalyserNode | null>(null);
  const analyserRRef = useRef<AnalyserNode | null>(null);
  const destinationConnectedRef = useRef(false);

  // Keep refs to the latest state so the graph-build effect can apply current
  // params on rebuild without becoming dependent on them.
  const eqStateRef = useRef(eqState);
  eqStateRef.current = eqState;
  const enhancerStateRef = useRef(enhancerState);
  enhancerStateRef.current = enhancerState;

  /* ─────────────────────────────────────────────────────────────
     Build / tear down the audio graph.
     Re-runs when `deviceId` OR `bandCount` changes (graph shape).
     ───────────────────────────────────────────────────────────── */

  useEffect(() => {
    if (!stream) {
      setAnalyser(null);
      setStatus('Idle');
      return;
    }

    let cancelled = false;
    setStatus('Connecting');
    setError(null);

    (async () => {
      try {
        if (cancelled) return;

        const ctx = new AudioContext({ latencyHint: 'interactive' });
        const source = ctx.createMediaStreamSource(stream);
        const preamp = ctx.createGain();
        preamp.gain.value = 1;

        const eqSnapshot = eqStateRef.current;
        const freqs = frequenciesFor(eqSnapshot.bandCount);
        const Q = qFor(eqSnapshot.bandCount);

        // Build the EQ filters dynamically based on current bandCount.
        const filters: BiquadFilterNode[] = [];
        for (let i = 0; i < freqs.length; i++) {
          const f = ctx.createBiquadFilter();
          f.frequency.value = freqs[i];
          if (i === 0) f.type = 'lowshelf';
          else if (i === freqs.length - 1) f.type = 'highshelf';
          else f.type = 'peaking';
          f.Q.value = Q;
          f.gain.value = 0;
          filters.push(f);
        }

        // Enhancer nodes — always present, set to neutral by default.
        const bassShelf = ctx.createBiquadFilter();
        bassShelf.type = 'lowshelf';
        bassShelf.frequency.value = 80;
        bassShelf.gain.value = 0;

        const midPeak = ctx.createBiquadFilter();
        midPeak.type = 'peaking';
        midPeak.frequency.value = 1000;
        midPeak.Q.value = 1;
        midPeak.gain.value = 0;

        const trebleShelf = ctx.createBiquadFilter();
        trebleShelf.type = 'highshelf';
        trebleShelf.frequency.value = 10000;
        trebleShelf.gain.value = 0;

        const panner = ctx.createStereoPanner();
        panner.pan.value = 0;

        const masterGain = ctx.createGain();
        masterGain.gain.value = 1;

        const analyserNode = ctx.createAnalyser();
        analyserNode.fftSize = 2048;
        analyserNode.smoothingTimeConstant = 0.8;

        // Parallel stereo-channel analysers — for L/R correlation
        // (stereo width / phase) measurement in AudioStats.
        const splitter = ctx.createChannelSplitter(2);
        const analyserLNode = ctx.createAnalyser();
        const analyserRNode = ctx.createAnalyser();
        analyserLNode.fftSize = 1024;
        analyserRNode.fftSize = 1024;
        analyserLNode.smoothingTimeConstant = 0.5;
        analyserRNode.smoothingTimeConstant = 0.5;

        // Wire the chain: source → preamp → eq filters → bass → mid → treble → panner → volume → analyser.
        source.connect(preamp);
        let prev: AudioNode = preamp;
        for (const f of filters) {
          prev.connect(f);
          prev = f;
        }
        prev.connect(bassShelf);
        bassShelf.connect(midPeak);
        midPeak.connect(trebleShelf);
        trebleShelf.connect(panner);
        panner.connect(masterGain);
        masterGain.connect(analyserNode);
        // Tap stereo channels in parallel (doesn't affect the main chain).
        masterGain.connect(splitter);
        splitter.connect(analyserLNode, 0, 0);
        splitter.connect(analyserRNode, 1, 0);

        // Stash refs
        ctxRef.current = ctx;
        sourceRef.current = source;
        preampRef.current = preamp;
        filtersRef.current = filters;
        bassShelfRef.current = bassShelf;
        midPeakRef.current = midPeak;
        trebleShelfRef.current = trebleShelf;
        pannerRef.current = panner;
        masterGainRef.current = masterGain;
        analyserRef.current = analyserNode;
        splitterRef.current = splitter;
        analyserLRef.current = analyserLNode;
        analyserRRef.current = analyserRNode;
        destinationConnectedRef.current = false;

        // Apply current state to fresh nodes.
        applyEqState(ctx, preamp, filters, eqStateRef.current);
        applyEnhancerState(
          ctx,
          bassShelf,
          midPeak,
          trebleShelf,
          panner,
          masterGain,
          enhancerStateRef.current,
        );

        setAnalyser(analyserNode);
        setAnalyserL(analyserLNode);
        setAnalyserR(analyserRNode);
        setStatus('Listening');
      } catch (err) {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        setError(`Could not open audio device: ${message}`);
        setStatus('Error');
      }
    })();

    return () => {
      cancelled = true;
      try {
        if (destinationConnectedRef.current && analyserRef.current && ctxRef.current) {
          analyserRef.current.disconnect(ctxRef.current.destination);
        }
      } catch {
        // ignore
      }
      analyserRef.current?.disconnect();
      analyserLRef.current?.disconnect();
      analyserRRef.current?.disconnect();
      splitterRef.current?.disconnect();
      masterGainRef.current?.disconnect();
      pannerRef.current?.disconnect();
      trebleShelfRef.current?.disconnect();
      midPeakRef.current?.disconnect();
      bassShelfRef.current?.disconnect();
      filtersRef.current.forEach((f) => f.disconnect());
      preampRef.current?.disconnect();
      sourceRef.current?.disconnect();
      // Note: stream lifecycle is owned by useAudioSource — we don't stop tracks here.
      ctxRef.current?.close().catch(() => {});

      ctxRef.current = null;
      sourceRef.current = null;
      preampRef.current = null;
      filtersRef.current = [];
      bassShelfRef.current = null;
      midPeakRef.current = null;
      trebleShelfRef.current = null;
      pannerRef.current = null;
      masterGainRef.current = null;
      analyserRef.current = null;
      analyserLRef.current = null;
      analyserRRef.current = null;
      splitterRef.current = null;
      destinationConnectedRef.current = false;
    };
  }, [stream, eqState.bandCount]);

  /* ─────────────────────────────────────────────────────────────
     Slider/preset/bypass changes — update node params in place.
     ───────────────────────────────────────────────────────────── */

  useEffect(() => {
    const ctx = ctxRef.current;
    const preamp = preampRef.current;
    const filters = filtersRef.current;
    if (!ctx || !preamp || filters.length === 0) return;
    applyEqState(ctx, preamp, filters, eqState);
  }, [eqState]);

  useEffect(() => {
    const ctx = ctxRef.current;
    const bassShelf = bassShelfRef.current;
    const midPeak = midPeakRef.current;
    const trebleShelf = trebleShelfRef.current;
    const panner = pannerRef.current;
    const masterGain = masterGainRef.current;
    if (!ctx || !bassShelf || !midPeak || !trebleShelf || !panner || !masterGain) return;
    applyEnhancerState(ctx, bassShelf, midPeak, trebleShelf, panner, masterGain, enhancerState);
  }, [enhancerState]);

  /* ─────────────────────────────────────────────────────────────
     Output sink routing — sends ctx.destination to a specific
     audiooutput device instead of following the OS default. Needed
     when the OS default is a virtual device (e.g. BlackHole) and
     using it for playback would feed back into our own capture.
     Runs after a fresh graph build (analyser dep) and on user
     changes (outputDeviceId dep).
     ───────────────────────────────────────────────────────────── */

  useEffect(() => {
    const ctx = ctxRef.current as AudioContextWithSink | null;
    if (!ctx || typeof ctx.setSinkId !== 'function') return;
    ctx.setSinkId(outputDeviceId ?? '').catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      setError(`Could not switch output device: ${message}`);
    });
  }, [outputDeviceId, analyser]);

  /* ─────────────────────────────────────────────────────────────
     Playthrough toggle.
     ───────────────────────────────────────────────────────────── */

  useEffect(() => {
    const ctx = ctxRef.current;
    const analyserNode = analyserRef.current;
    if (!ctx || !analyserNode) return;

    if (playthrough && !destinationConnectedRef.current) {
      analyserNode.connect(ctx.destination);
      destinationConnectedRef.current = true;
    } else if (!playthrough && destinationConnectedRef.current) {
      try {
        analyserNode.disconnect(ctx.destination);
      } catch {
        // ignore
      }
      destinationConnectedRef.current = false;
    }
  }, [playthrough, analyser]);

  return { analyser, analyserL, analyserR, error, status };
}

function applyEqState(
  ctx: AudioContext,
  preamp: GainNode,
  filters: BiquadFilterNode[],
  state: EQState,
): void {
  const now = ctx.currentTime;
  if (state.bypass) {
    preamp.gain.setTargetAtTime(1, now, PARAM_RAMP);
    for (const f of filters) f.gain.setTargetAtTime(0, now, PARAM_RAMP);
    return;
  }
  preamp.gain.setTargetAtTime(Math.pow(10, state.preamp / 20), now, PARAM_RAMP);
  for (let i = 0; i < filters.length; i++) {
    filters[i].gain.setTargetAtTime(state.bands[i] ?? 0, now, PARAM_RAMP);
  }
}

function applyEnhancerState(
  ctx: AudioContext,
  bassShelf: BiquadFilterNode,
  midPeak: BiquadFilterNode,
  trebleShelf: BiquadFilterNode,
  panner: StereoPannerNode,
  masterGain: GainNode,
  state: EnhancerState,
): void {
  const now = ctx.currentTime;
  if (state.bypass) {
    bassShelf.gain.setTargetAtTime(0, now, PARAM_RAMP);
    midPeak.gain.setTargetAtTime(0, now, PARAM_RAMP);
    trebleShelf.gain.setTargetAtTime(0, now, PARAM_RAMP);
    panner.pan.setTargetAtTime(0, now, PARAM_RAMP);
    masterGain.gain.setTargetAtTime(1, now, PARAM_RAMP);
    return;
  }
  bassShelf.gain.setTargetAtTime(state.bass, now, PARAM_RAMP);
  midPeak.gain.setTargetAtTime(state.mid, now, PARAM_RAMP);
  trebleShelf.gain.setTargetAtTime(state.treble, now, PARAM_RAMP);
  panner.pan.setTargetAtTime(state.balance / 100, now, PARAM_RAMP);
  masterGain.gain.setTargetAtTime(state.volume / 100, now, PARAM_RAMP);
}

import { useEffect, useRef, useState } from 'react';
import type { EQState } from '../state/eq';
import { frequenciesFor, qFor } from '../state/eq';
import type { EnhancerState } from '../state/enhancer';
import type { EffectsState } from '../state/effects';
import { buildEffectsChain, type EffectsChain } from './effectsGraph';
import { buildBandCoefs, logSpacedFrequencies, responseCurveDb } from './biquadResponse';

interface AudioEngineState {
  analyser: AnalyserNode | null;
  analyserL: AnalyserNode | null;
  analyserR: AnalyserNode | null;
  /** Stereo analysers tapped BEFORE the EQ filters. Used by the AI enhancer
   *  so its analysis isn't a closed feedback loop with its own corrections. */
  preEqAnalyserL: AnalyserNode | null;
  preEqAnalyserR: AnalyserNode | null;
  /** Peak catcher node, exposed so the UI can read live gain reduction
   *  (`.reduction`) without reaching into the graph. */
  limiter: DynamicsCompressorNode | null;
  /** Headroom the auto-trim is currently giving back, in dB (>= 0). Surfaced
   *  so the Enhancer can show that a boost moved tone, not level. */
  autoTrimDb: number;
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
  effectsState: EffectsState,
  playthrough: boolean,
  outputDeviceId: string | null,
  /** Optional AI Enhancer per-band delta (length === eqState.bandCount).
   *  Added on top of the user's baseline band values when applying gains. */
  aiDeltaRef: { current: number[] } | null = null,
  aiEnabled = false,
  aiSetTargetTau: number = PARAM_RAMP,
  /** Input compensation gain in dB, applied right after the MediaStreamSource
   *  (before the preamp / EQ / analysers). Used to lift quiet virtual inputs
   *  like BlackHole back to parity with direct system audio. Default 0 dB. */
  inputCompensationDb = 0,
): AudioEngineState {
  const [analyser, setAnalyser] = useState<AnalyserNode | null>(null);
  const [analyserL, setAnalyserL] = useState<AnalyserNode | null>(null);
  const [analyserR, setAnalyserR] = useState<AnalyserNode | null>(null);
  const [preEqAnalyserL, setPreEqAnalyserL] = useState<AnalyserNode | null>(null);
  const [preEqAnalyserR, setPreEqAnalyserR] = useState<AnalyserNode | null>(null);
  const [limiter, setLimiter] = useState<DynamicsCompressorNode | null>(null);
  const [autoTrimDb, setAutoTrimDb] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<AudioEngineState['status']>('Idle');

  const ctxRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const inputGainRef = useRef<GainNode | null>(null);
  const preampRef = useRef<GainNode | null>(null);
  const filtersRef = useRef<BiquadFilterNode[]>([]);
  const bassShelfRef = useRef<BiquadFilterNode | null>(null);
  const midPeakRef = useRef<BiquadFilterNode | null>(null);
  const trebleShelfRef = useRef<BiquadFilterNode | null>(null);
  const pannerRef = useRef<StereoPannerNode | null>(null);
  const masterGainRef = useRef<GainNode | null>(null);
  /** Peak catcher sitting BEFORE masterGain (see the wiring comment below).
   *  Scope is stage-overflow only: preamp + EQ + enhancer can stack +30 dB
   *  cumulative, and this keeps that from hard-clipping. It deliberately does
   *  NOT protect against the user's volume knob, which is downstream and is a
   *  literal multiplier by design.
   *
   *  Corollary, and the reason this note is emphatic: any gain applied
   *  UPSTREAM of this node is subject to being clawed back. At threshold -1
   *  dBFS / ratio 20, loud material keeps ~5 % of whatever you add here. Do
   *  not put loudness compensation before this node — it will behave as a
   *  compressor, not as gain. That bug shipped once already. */
  const limiterRef = useRef<DynamicsCompressorNode | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const splitterRef = useRef<ChannelSplitterNode | null>(null);
  const analyserLRef = useRef<AnalyserNode | null>(null);
  const analyserRRef = useRef<AnalyserNode | null>(null);
  const preEqSplitterRef = useRef<ChannelSplitterNode | null>(null);
  const preEqAnalyserLRef = useRef<AnalyserNode | null>(null);
  const preEqAnalyserRRef = useRef<AnalyserNode | null>(null);
  /** Whether the pre-EQ analyser branch is currently fed by the preamp.
   *  Detached when AI is off so the analyser nodes idle (no FFT overhead). */
  const preEqAttachedRef = useRef(false);
  /** Live mirror of aiEnabled so the graph-build effect can read it without
   *  taking it as a dep (which would force a rebuild every toggle). */
  const aiEnabledRef = useRef(aiEnabled);
  aiEnabledRef.current = aiEnabled;
  const destinationConnectedRef = useRef(false);

  // Keep refs to the latest state so the graph-build effect can apply current
  // params on rebuild without becoming dependent on them.
  const eqStateRef = useRef(eqState);
  eqStateRef.current = eqState;
  // Read at graph-build time only. Keeping effects out of the build effect's
  // deps is deliberate: a width tweak must not tear down and rebuild the
  // whole AudioContext.
  const effectsStateRef = useRef(effectsState);
  effectsStateRef.current = effectsState;
  const effectsChainRef = useRef<EffectsChain | null>(null);
  /** A/B compare taps. `abProcessed` carries the full chain, `abRaw` carries
   *  the untouched input; exactly one is open at a time. */
  const abProcessedRef = useRef<GainNode | null>(null);
  const abRawRef = useRef<GainNode | null>(null);
  const enhancerStateRef = useRef(enhancerState);
  enhancerStateRef.current = enhancerState;

  /* ─────────────────────────────────────────────────────────────
     Build / tear down the audio graph.
     Re-runs when `deviceId` OR `bandCount` changes (graph shape).
     ───────────────────────────────────────────────────────────── */

  useEffect(() => {
    if (!stream) {
      setAnalyser(null);
      setAnalyserL(null);
      setAnalyserR(null);
      setPreEqAnalyserL(null);
      setPreEqAnalyserR(null);
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
        // Input compensation lifts quiet virtual inputs (e.g., BlackHole) up
        // to direct-system-audio parity BEFORE anything downstream sees them.
        // Initialized to current compensation value; updated via the effect
        // below as the user switches between input devices.
        const inputGain = ctx.createGain();
        inputGain.gain.value = Math.pow(10, inputCompensationDb / 20);
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

        // Limiter — interim peak catcher via DynamicsCompressor. True
        // brick-wall limiting requires an AudioWorklet (Phase 4).
        const limiter = ctx.createDynamicsCompressor();
        // Tuned as a peak catcher, not a loudness compressor:
        //   threshold -1 dBFS = digital headroom ceiling, only true peaks engage
        //   knee 2          = soft transition over ±1 dB around threshold
        //   ratio 20        = effectively brick-wall for typical music transients
        //   attack 0.002s   = grabs fast enough to catch the first sample peak
        //   release 0.05s   = recovers in ~50ms so steady-state material isn't held down
        // Previous release of 0.25s held GR for a quarter second after each peak,
        // costing ~3 dB of average loudness on mastered music. Phase 4 will
        // replace this with a real lookahead brick-wall AudioWorklet.
        limiter.threshold.value = -1;
        limiter.knee.value = 2;
        limiter.ratio.value = 20;
        limiter.attack.value = 0.002;
        limiter.release.value = 0.05;

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

        // Pre-EQ stereo analysers — tapped between preamp and EQ filters so
        // the AI Enhancer analyses the source music, NOT its own corrections.
        // Without this, a band boost from the engine would increase that
        // band's measured energy → engine cuts it back → closed feedback loop.
        const preEqSplitter = ctx.createChannelSplitter(2);
        const preEqAnalyserLNode = ctx.createAnalyser();
        const preEqAnalyserRNode = ctx.createAnalyser();
        // 1024 FFT (~47 Hz bins at 48 kHz) is plenty for the AI's ISO-10-band
        // aggregation — bins are aggregated into ~octave-wide bands anyway, so
        // halving the FFT size cuts those analysers' work in half with no
        // measurable difference in classification or correction quality.
        preEqAnalyserLNode.fftSize = 1024;
        preEqAnalyserRNode.fftSize = 1024;
        preEqAnalyserLNode.smoothingTimeConstant = 0.5;
        preEqAnalyserRNode.smoothingTimeConstant = 0.5;

        // Wire the chain:
        //   source → inputGain → preamp → eq filters → bass → mid → treble
        //         → panner → limiter → analyser → splitter (taps)
        //                                    └─→ masterGain → destination
        //
        // The limiter sits BEFORE masterGain so it only protects against
        // stage-overflow (preamp + EQ + enhancer can stack +30+ dB cumulative)
        // without compressing the user's volume knob. masterGain is the LAST
        // stage before the destination, so the volume control is a literal
        // multiplier: 250 % = 2.5×, even if that drives the digital output
        // above 0 dBFS and clips. The user asked for it explicitly — they get
        // it. The OS / hardware soft-clips loud transients, the user backs
        // off the knob if they don't like it.
        //
        // The analyser + stereo splitter tap from the LIMITED signal so the
        // visualizer reflects the audio content, not the user's chosen output
        // amplitude. (If we tapped after masterGain, the visualizer would die
        // at volume = 0 even though the audio is fine.)
        source.connect(inputGain);
        inputGain.connect(preamp);
        // Pre-EQ analyser splitter is wired but its FEED FROM PREAMP is
        // attached/detached dynamically based on `aiEnabled` — see the effect
        // below. When AI is off, these analyser nodes receive no audio and
        // their internal sliding buffers fall idle (no FFT work, no overhead).
        preEqSplitter.connect(preEqAnalyserLNode, 0, 0);
        preEqSplitter.connect(preEqAnalyserRNode, 1, 0);
        if (aiEnabledRef.current) {
          preamp.connect(preEqSplitter);
          preEqAttachedRef.current = true;
        } else {
          preEqAttachedRef.current = false;
        }
        let prev: AudioNode = preamp;
        for (const f of filters) {
          prev.connect(f);
          prev = f;
        }
        prev.connect(bassShelf);
        bassShelf.connect(midPeak);
        midPeak.connect(trebleShelf);

        // Effects rack (width / exciter / reverb) sits after the tone shelves
        // and before the panner, so everything it adds is still caught by the
        // limiter downstream.
        const effectsChain = buildEffectsChain(ctx, effectsStateRef.current);
        trebleShelf.connect(effectsChain.input);
        effectsChain.output.connect(panner);

        // A/B compare. Both taps sum into the limiter and exactly one is open,
        // so the switch lands BEFORE the limiter and masterGain — you're
        // comparing EQ + enhancer + effects against nothing, with the same
        // protection and the same volume knob on either side. The analysers
        // hang off the limiter, so the visualizer follows what you hear.
        const abProcessed = ctx.createGain();
        const abRaw = ctx.createGain();
        const bypassing = effectsStateRef.current.abBypass;
        abProcessed.gain.value = bypassing ? 0 : 1;
        abRaw.gain.value = bypassing ? 1 : 0;
        panner.connect(abProcessed);
        abProcessed.connect(limiter);
        inputGain.connect(abRaw);
        abRaw.connect(limiter);

        limiter.connect(analyserNode);
        limiter.connect(splitter);
        analyserNode.connect(masterGain);
        splitter.connect(analyserLNode, 0, 0);
        splitter.connect(analyserRNode, 1, 0);

        // Stash refs
        ctxRef.current = ctx;
        sourceRef.current = source;
        inputGainRef.current = inputGain;
        preampRef.current = preamp;
        filtersRef.current = filters;
        bassShelfRef.current = bassShelf;
        midPeakRef.current = midPeak;
        trebleShelfRef.current = trebleShelf;
        pannerRef.current = panner;
        effectsChainRef.current = effectsChain;
        abProcessedRef.current = abProcessed;
        abRawRef.current = abRaw;
        masterGainRef.current = masterGain;
        limiterRef.current = limiter;
        setLimiter(limiter);
        analyserRef.current = analyserNode;
        splitterRef.current = splitter;
        analyserLRef.current = analyserLNode;
        analyserRRef.current = analyserRNode;
        preEqSplitterRef.current = preEqSplitter;
        preEqAnalyserLRef.current = preEqAnalyserLNode;
        preEqAnalyserRRef.current = preEqAnalyserRNode;
        destinationConnectedRef.current = false;

        // Apply current state to fresh nodes. Reset prev-applied so the
        // first apply writes every band.
        prevAppliedBandsRef.current = null;
        setAutoTrimDb(
          applyEqState(ctx, preamp, filters, eqStateRef.current, enhancerStateRef.current, aiEnabledRef.current, prevAppliedBandsRef),
        );
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
        setPreEqAnalyserL(preEqAnalyserLNode);
        setPreEqAnalyserR(preEqAnalyserRNode);
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
      effectsChainRef.current?.dispose();
      effectsChainRef.current = null;
      abProcessedRef.current = null;
      abRawRef.current = null;
      masterGainRef.current = null;
      analyserRef.current = null;
      analyserLRef.current = null;
      analyserRRef.current = null;
      splitterRef.current = null;
      limiterRef.current = null;
      setLimiter(null);
      destinationConnectedRef.current = false;
    };
  }, [stream, eqState.bandCount]);

  /* ─────────────────────────────────────────────────────────────
     Slider/preset/bypass changes — update node params in place.
     When AI Enhance is on, the AI tick below is the sole writer to
     filter.gain (it reads eqStateRef.current and writes base+delta).
     If THIS effect also ran, the two would alternate setTargetAtTime
     calls every 100 ms and the slider thumb would visibly jitter.
     Gate accordingly. Preamp + bypass are still applied either way.
     ───────────────────────────────────────────────────────────── */

  /** Previous baseline band values — used to only re-schedule the bands
   *  whose gain has actually changed. Avoids 31 setTargetAtTime calls on
   *  every single-band drag tick. Initialised lazily; first apply after a
   *  graph rebuild always writes every band. */
  const prevAppliedBandsRef = useRef<number[] | null>(null);

  useEffect(() => {
    const ctx = ctxRef.current;
    const preamp = preampRef.current;
    const filters = filtersRef.current;
    if (!ctx || !preamp || filters.length === 0) return;
    setAutoTrimDb(
      applyEqState(ctx, preamp, filters, eqState, enhancerState, aiEnabled, prevAppliedBandsRef),
    );
  }, [eqState, enhancerState, aiEnabled]);

  /* Input compensation — smoothly ramp the input-gain node when the
   * compensation value changes (e.g. user switched from BlackHole to mic). */
  useEffect(() => {
    const ctx = ctxRef.current;
    const inputGain = inputGainRef.current;
    if (!ctx || !inputGain) return;
    const linear = Math.pow(10, inputCompensationDb / 20);
    inputGain.gain.setTargetAtTime(linear, ctx.currentTime, PARAM_RAMP);
  }, [inputCompensationDb]);

  /* Effects rack — the graph-build effect deliberately ignores effectsState
   * (a width tweak must not rebuild the AudioContext), so this is the only
   * thing keeping the rack's nodes in sync with the UI. */
  useEffect(() => {
    effectsChainRef.current?.apply(effectsState);
  }, [effectsState]);

  /* Reverb decay is the one expensive change: it regenerates the impulse
   * response, allocating sampleRate x decay x 2 floats — megabytes at the
   * top of the range. Debounced so dragging the slider builds one buffer
   * when you let go rather than sixty on the way there. */
  useEffect(() => {
    const chain = effectsChainRef.current;
    if (!chain) return;
    const decay = effectsState.reverbDecay;
    const t = window.setTimeout(() => chain.setDecay(decay), 150);
    return () => window.clearTimeout(t);
  }, [effectsState.reverbDecay]);

  /* A/B compare crossfade. Ramped rather than switched so the flip doesn't
   * click — which would itself colour the comparison. */
  useEffect(() => {
    const ctx = ctxRef.current;
    const processed = abProcessedRef.current;
    const raw = abRawRef.current;
    if (!ctx || !processed || !raw) return;
    const now = ctx.currentTime;
    processed.gain.setTargetAtTime(effectsState.abBypass ? 0 : 1, now, PARAM_RAMP);
    raw.gain.setTargetAtTime(effectsState.abBypass ? 1 : 0, now, PARAM_RAMP);
  }, [effectsState.abBypass]);

  /* Pre-EQ analyser attach/detach — only feed the AI analyser splitter when
   * the enhancer is enabled. When disabled, the splitter receives no audio
   * and the downstream AnalyserNodes don't maintain any sliding buffer or
   * burn CPU, fully offloading AI overhead. */
  useEffect(() => {
    const preamp = preampRef.current;
    const splitter = preEqSplitterRef.current;
    if (!preamp || !splitter) return;
    if (aiEnabled && !preEqAttachedRef.current) {
      try {
        preamp.connect(splitter);
        preEqAttachedRef.current = true;
      } catch {
        // Already connected — ignore.
      }
    } else if (!aiEnabled && preEqAttachedRef.current) {
      try {
        preamp.disconnect(splitter);
      } catch {
        // Not connected — ignore.
      }
      preEqAttachedRef.current = false;
    }
  }, [aiEnabled, analyser]);

  /* AI Enhancer tick — when on, re-apply baseline + delta every 100 ms so
   * the continuously-changing AI delta drives the filter gains. When off,
   * deltaRef contents are zero and the regular eqState effect above handles
   * everything. */
  useEffect(() => {
    if (!aiEnabled || !aiDeltaRef) return;
    const id = window.setInterval(() => {
      const ctx = ctxRef.current;
      const filters = filtersRef.current;
      if (!ctx || filters.length === 0) return;
      const s = eqStateRef.current;
      if (s.bypass) return;
      const delta = aiDeltaRef.current;
      const now = ctx.currentTime;
      // Keep prevAppliedBandsRef in sync with what we're actually scheduling.
      // Critical for the AI-off transition: when the user disables AI, the
      // eqState effect runs with its dirty-band diff. If we didn't track the
      // AI-influenced values here, the diff would compare stale baseline-vs-
      // baseline and skip — leaving filters stuck at base+delta until the
      // user moves a slider.
      let prev = prevAppliedBandsRef.current;
      if (prev === null || prev.length !== filters.length) {
        prev = new Array(filters.length).fill(0);
        prevAppliedBandsRef.current = prev;
      }
      for (let i = 0; i < filters.length; i++) {
        const base = s.bands[i] ?? 0;
        const d = delta[i] ?? 0;
        const v = base + d;
        filters[i].gain.setTargetAtTime(v, now, aiSetTargetTau);
        prev[i] = v;
      }
    }, 100);
    return () => window.clearInterval(id);
  }, [aiEnabled, aiDeltaRef, aiSetTargetTau]);

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
     Context liveness.

     If the audio hardware stalls or gets reset while the app sits
     idle, Chromium parks the context in 'suspended' and the explicit
     sink stops applying. Neither `stream` identity nor
     `outputDeviceId` changes, so the graph-build and sink effects
     above never re-run — playback stays dead until the user re-picks
     a device by hand. Resume on statechange, and re-check on window
     focus for the case where the context was already parked before
     we attached (no event left to catch).

     Re-assert the sink only after an actual resume: setSinkId on a
     healthy context is an audible glitch, so we don't do it on every
     focus.
     ───────────────────────────────────────────────────────────── */

  useEffect(() => {
    const ctx = ctxRef.current as AudioContextWithSink | null;
    if (!ctx) return;

    const heal = () => {
      if (ctx.state !== 'suspended') return;
      ctx
        .resume()
        .then(() => {
          if (typeof ctx.setSinkId === 'function') {
            return ctx.setSinkId(outputDeviceId ?? '');
          }
        })
        .catch(() => {
          // Context closed underneath us, or the sink vanished. The
          // graph rebuild that follows a source recovery covers both.
        });
    };

    ctx.addEventListener('statechange', heal);
    window.addEventListener('focus', heal);
    heal();
    return () => {
      ctx.removeEventListener('statechange', heal);
      window.removeEventListener('focus', heal);
    };
  }, [outputDeviceId, analyser]);

  /* ─────────────────────────────────────────────────────────────
     Playthrough toggle.
     ───────────────────────────────────────────────────────────── */

  useEffect(() => {
    const ctx = ctxRef.current;
    const masterGain = masterGainRef.current;
    if (!ctx || !masterGain) return;

    if (playthrough && !destinationConnectedRef.current) {
      masterGain.connect(ctx.destination);
      destinationConnectedRef.current = true;
    } else if (!playthrough && destinationConnectedRef.current) {
      try {
        masterGain.disconnect(ctx.destination);
      } catch {
        // ignore
      }
      destinationConnectedRef.current = false;
    }
  }, [playthrough, analyser]);

  return {
    analyser,
    analyserL,
    analyserR,
    preEqAnalyserL,
    preEqAnalyserR,
    limiter,
    autoTrimDb,
    error,
    status,
  };
}

/** Probe grid for the auto-trim peak search. 96 log-spaced points over
 *  20 Hz–20 kHz is ~1/7-octave — fine enough to land on a cascade peak to
 *  within ~0.1 dB, cheap enough to run on every slider tick. */
const TRIM_PROBE_FREQS = logSpacedFrequencies(96);

/**
 * Peak gain (dB) of the tone section: the EQ band cascade plus the
 * enhancer's bass/treble shelves. Never negative — we only ever give
 * headroom back, never add gain.
 *
 * Why this exists: overlapping biquads sum. Ten 1-octave bands at +6 dB
 * (Q 1.41, with shelves on the ends) peak around +9 dB, not +6. That excess
 * lands on a master already mixed to ~-1 dBFS, so it goes straight into the
 * limiter — measured ~8.4 dB of gain reduction for ~0.5 dB of real level.
 * The result is an accidental compressor: pumping, smeared transients, and
 * a curve that sounds worse than bypass. Trimming the preamp by the cascade
 * peak makes a boost change TONE rather than LEVEL, which is what the
 * sliders claim to do, and keeps the limiter idle on normal material.
 */
function toneSectionPeakDb(
  bands: number[],
  bandFreqs: number[],
  q: number,
  enhancerBassDb: number,
  enhancerTrebleDb: number,
  enhancerMidDb: number,
  sampleRate: number,
): number {
  const set = buildBandCoefs(
    bands,
    bandFreqs,
    q,
    0,
    enhancerBassDb,
    enhancerTrebleDb,
    enhancerMidDb,
    sampleRate,
  );
  let peak = 0;
  for (let i = 0; i < TRIM_PROBE_FREQS.length; i++) {
    const v = responseCurveDb(TRIM_PROBE_FREQS[i], set, sampleRate);
    if (v > peak) peak = v;
  }
  return peak;
}

function applyEqState(
  ctx: AudioContext,
  preamp: GainNode,
  filters: BiquadFilterNode[],
  state: EQState,
  enhancerState: EnhancerState,
  aiEnabled: boolean,
  prevAppliedRef: { current: number[] | null },
): number {
  const now = ctx.currentTime;
  if (state.bypass) {
    preamp.gain.setTargetAtTime(1, now, PARAM_RAMP);
    // Force-zero all bands regardless of diff (bypass overrides any in-flight ramp).
    for (const f of filters) f.gain.setTargetAtTime(0, now, PARAM_RAMP);
    prevAppliedRef.current = new Array(filters.length).fill(0);
    return 0;
  }
  // Auto headroom trim. Applied to the NODE only — `state.preamp` is a
  // user-facing control and stays exactly where the user put it, so the UI
  // keeps reading back their own value. Their preamp and this trim simply
  // sum in dB before hitting the gain node.
  const enhBypassed = enhancerState.bypass;
  const trimDb = toneSectionPeakDb(
    state.bands,
    frequenciesFor(state.bandCount),
    qFor(state.bandCount),
    enhBypassed ? 0 : enhancerState.bass,
    enhBypassed ? 0 : enhancerState.treble,
    enhBypassed ? 0 : enhancerState.mid,
    ctx.sampleRate,
  );
  preamp.gain.setTargetAtTime(Math.pow(10, (state.preamp - trimDb) / 20), now, PARAM_RAMP);
  // When AI is on, the AI tick owns filter gains — don't write them here.
  if (aiEnabled) return trimDb;
  // Per-band dirty diff. First call after a graph rebuild OR bandCount change
  // writes all bands; subsequent calls only write bands whose value moved.
  const prev = prevAppliedRef.current;
  const fresh = prev === null || prev.length !== filters.length;
  if (fresh) {
    const next = new Array(filters.length).fill(0);
    for (let i = 0; i < filters.length; i++) {
      const v = state.bands[i] ?? 0;
      filters[i].gain.setTargetAtTime(v, now, PARAM_RAMP);
      next[i] = v;
    }
    prevAppliedRef.current = next;
    return trimDb;
  }
  for (let i = 0; i < filters.length; i++) {
    const v = state.bands[i] ?? 0;
    if (v !== prev[i]) {
      filters[i].gain.setTargetAtTime(v, now, PARAM_RAMP);
      prev[i] = v;
    }
  }
  return trimDb;
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

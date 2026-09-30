import { channelWeight, createQuarterMeter, kWeightingStages, type QuarterMeter } from './loudness';

/**
 * Real-time BS.1770 loudness, measured on the audio thread.
 *
 * Why a worklet and not the AnalyserNode we already have: an analyser hands
 * back `fftSize` samples whenever you ask, which at 10 Hz and 1024 samples is
 * a ~21% duty cycle of the actual signal. You cannot build BS.1770's
 * contiguous 400 ms gating blocks out of disjoint snippets, and the
 * K-weighting filters would be re-entered with stale state on every gap. Any
 * number that came out of that would not be LUFS, whatever we called it.
 *
 * So the audio thread does the part that has to see every sample — two
 * biquads and a sum of squares — and posts one number per 100 ms quarter.
 * The gating stays on the main thread in `createQuarterMeter`, which is the
 * same code path `createLoudnessMeter` uses, so there is one implementation
 * of it rather than two.
 *
 * The filter coefficients are computed here by `kWeightingStages` and handed
 * across, so the worklet holds no loudness knowledge at all — it can't drift
 * from the standard because it doesn't implement it.
 */

const PROCESSOR_NAME = 'loudness-tap';

/**
 * Plain JS, not TypeScript: this is loaded as a module by
 * `audioWorklet.addModule`, which takes a URL rather than a bundle entry.
 * Shipping it as a Blob keeps it out of the Vite build graph entirely — no
 * extra entry point, no worklet plugin, and no chance of the bundler
 * rewriting it into something `AudioWorkletGlobalScope` can't evaluate.
 */
const PROCESSOR_SOURCE = `
class LoudnessTapProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = options.processorOptions;
    this.shelf = o.shelf;
    this.hp = o.hp;
    this.weights = o.weights;
    this.quarterSamples = o.quarterSamples;
    // Direct form I state, 8 doubles per channel: shelf x1 x2 y1 y2, then hp.
    this.state = new Float64Array(0);
    this.accum = 0;
    this.fill = 0;
    this.port.onmessage = (e) => {
      if (e.data === 'reset') {
        this.state.fill(0);
        this.accum = 0;
        this.fill = 0;
      }
    };
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const channels = input.length;
    const frames = input[0].length;
    if (this.state.length !== channels * 8) this.state = new Float64Array(channels * 8);

    const st = this.state;
    const sh = this.shelf;
    const hp = this.hp;
    const w = this.weights;

    for (let n = 0; n < frames; n++) {
      let weighted = 0;
      for (let c = 0; c < channels; c++) {
        const b = c * 8;
        const x = input[c][n];

        // Stage 1 — high shelf.
        const y1 = sh.b0 * x + sh.b1 * st[b] + sh.b2 * st[b + 1] - sh.a1 * st[b + 2] - sh.a2 * st[b + 3];
        st[b + 1] = st[b];
        st[b] = x;
        st[b + 3] = st[b + 2];
        st[b + 2] = y1;

        // Stage 2 — high pass.
        const y2 = hp.b0 * y1 + hp.b1 * st[b + 4] + hp.b2 * st[b + 5] - hp.a1 * st[b + 6] - hp.a2 * st[b + 7];
        st[b + 5] = st[b + 4];
        st[b + 4] = y1;
        st[b + 7] = st[b + 6];
        st[b + 6] = y2;

        weighted += (w[c] === undefined ? 1 : w[c]) * y2 * y2;
      }
      this.accum += weighted;
      if (++this.fill === this.quarterSamples) {
        this.port.postMessage({ z: this.accum, n: this.quarterSamples });
        this.accum = 0;
        this.fill = 0;
      }
    }
    return true;
  }
}
registerProcessor(${JSON.stringify(PROCESSOR_NAME)}, LoudnessTapProcessor);
`;

/** `registerProcessor` throws on a duplicate name, and a rebuilt graph may
 *  reuse a context. Registration is per-context, so remember which ones. */
const registered = new WeakSet<BaseAudioContext>();

async function ensureRegistered(ctx: BaseAudioContext): Promise<void> {
  if (registered.has(ctx)) return;
  const url = URL.createObjectURL(new Blob([PROCESSOR_SOURCE], { type: 'application/javascript' }));
  try {
    await ctx.audioWorklet.addModule(url);
    registered.add(ctx);
  } finally {
    URL.revokeObjectURL(url);
  }
}

export interface LoudnessTap {
  /** Connect the signal to measure into this. */
  node: AudioWorkletNode;
  /** Gated loudness over everything since the last `reset`. */
  meter: QuarterMeter;
  /** Start a fresh measurement — call on a track change, or the next track
   *  inherits this one's integrated figure. */
  reset(): void;
  dispose(): void;
}

/**
 * Build the tap. Returns null if AudioWorklet is unavailable or the module
 * fails to load, which callers treat as "no loudness data" rather than an
 * error — every feature built on this degrades to the behaviour it had
 * before the measurement existed.
 *
 * Takes a BaseAudioContext rather than an AudioContext because only
 * `sampleRate` and `audioWorklet` are used, and `check:loudness-tap` drives
 * it from an OfflineAudioContext — deterministic, faster than real time, and
 * no dependence on there being an output device.
 */
export async function createLoudnessTap(ctx: BaseAudioContext): Promise<LoudnessTap | null> {
  if (!ctx.audioWorklet) return null;
  try {
    await ensureRegistered(ctx);
  } catch {
    return null;
  }

  const [shelf, hp] = kWeightingStages(ctx.sampleRate);
  const channels = 2;
  const quarterSamples = Math.round(ctx.sampleRate * 0.1);
  const meter = createQuarterMeter();

  let node: AudioWorkletNode;
  try {
    node = new AudioWorkletNode(ctx, PROCESSOR_NAME, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: channels,
      channelCountMode: 'explicit',
      processorOptions: {
        shelf,
        hp,
        // Computed here so the standard's channel weights live in one place.
        weights: Array.from({ length: channels }, (_, i) => channelWeight(i)),
        quarterSamples,
      },
    });
  } catch {
    return null;
  }

  node.port.onmessage = (e: MessageEvent<{ z: number; n: number }>) => {
    meter.pushQuarter(e.data.z, e.data.n);
  };

  return {
    node,
    meter,
    reset(): void {
      meter.reset();
      node.port.postMessage('reset');
    },
    dispose(): void {
      node.port.onmessage = null;
      try {
        node.disconnect();
      } catch {
        // Already detached during teardown.
      }
    },
  };
}

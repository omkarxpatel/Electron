/**
 * Onset envelope, measured on the audio thread.
 *
 * Feeds `tempo.ts`. Separate from the loudness tap on purpose: they measure
 * different things on different schedules, and one processor doing both
 * would be named after whichever job it got first. Two trivial processors
 * on the same input cost less than one confusing one.
 *
 * Why the audio thread at all — the same reason as the loudness tap, only
 * more so. Tempo is entirely about *when*, so the envelope's spacing has to
 * be exact. A `setInterval` reading an AnalyserNode wanders by tens of
 * milliseconds under load, and at 120 BPM a 20 ms wander is 4% of a beat;
 * it smears the autocorrelation peak across several BPM. One sample per
 * fixed block of audio is exact by construction.
 *
 * The detector is a two-band log-energy flux. No FFT: splitting at 200 Hz
 * separates the kick from everything above it, which is most of what
 * carries the beat, and the log makes the envelope behave the same on a
 * quiet passage as a loud one. That is cheap enough to run per sample
 * without an FFT on the audio thread.
 */

const PROCESSOR_NAME = 'onset-tap';

/**
 * Samples per envelope point. 512 gives 93.75 Hz at 48 kHz — fine enough
 * that a beat lands within a few milliseconds of its true position, coarse
 * enough that a 14 second history is only ~1300 numbers to autocorrelate.
 */
export const ONSET_HOP = 512;

/**
 * How much history is kept, in seconds.
 *
 * Long enough for the slowest tempo in range to repeat many times — at
 * 70 BPM that is 16 beats — because an autocorrelation over two or three
 * periods is fitting noise. Short enough that the estimate follows a track
 * rather than averaging across a whole set.
 */
export const ONSET_HISTORY_SECONDS = 14;

/** Crossover between the two bands, in Hz. Below is the kick. */
const SPLIT_HZ = 200;

const PROCESSOR_SOURCE = `
class OnsetTapProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = options.processorOptions;
    this.hop = o.hop;
    // One-pole lowpass coefficient. The complement of the lowpass is the
    // high band, so one filter state gives both.
    this.a = o.lowpassA;
    this.lp = new Float64Array(0);
    this.sumLow = 0;
    this.sumHigh = 0;
    this.fill = 0;
    this.prevLow = 0;
    this.prevHigh = 0;
    this.primed = false;
    this.port.onmessage = (e) => {
      if (e.data === 'reset') {
        this.lp.fill(0);
        this.sumLow = 0;
        this.sumHigh = 0;
        this.fill = 0;
        this.primed = false;
      }
    };
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const channels = input.length;
    const frames = input[0].length;
    if (this.lp.length !== channels) this.lp = new Float64Array(channels);

    for (let n = 0; n < frames; n++) {
      let low = 0;
      let high = 0;
      for (let c = 0; c < channels; c++) {
        const x = input[c][n];
        this.lp[c] += this.a * (x - this.lp[c]);
        low += this.lp[c];
        high += x - this.lp[c];
      }
      this.sumLow += low * low;
      this.sumHigh += high * high;

      if (++this.fill === this.hop) {
        // Log energy: an onset is a RATIO of energies, not a difference, so
        // the envelope reads the same on a quiet verse as a loud chorus.
        const eLow = Math.log(this.sumLow / this.hop + 1e-10);
        const eHigh = Math.log(this.sumHigh / this.hop + 1e-10);
        // Half-wave rectified: only rises are onsets. Falls are decay.
        let flux = 0;
        if (this.primed) {
          const dLow = eLow - this.prevLow;
          const dHigh = eHigh - this.prevHigh;
          if (dLow > 0) flux += dLow;
          if (dHigh > 0) flux += dHigh;
        }
        this.prevLow = eLow;
        this.prevHigh = eHigh;
        this.primed = true;
        this.port.postMessage(flux);
        this.sumLow = 0;
        this.sumHigh = 0;
        this.fill = 0;
      }
    }
    return true;
  }
}
registerProcessor(${JSON.stringify(PROCESSOR_NAME)}, OnsetTapProcessor);
`;

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

export interface OnsetTap {
  node: AudioWorkletNode;
  /** Envelope rate in Hz — what `estimateTempo` needs to turn lags into BPM. */
  envelopeHz: number;
  /**
   * The history, oldest first. Returns null until it has filled — a partial
   * buffer padded with zeros would read as a long silence followed by
   * music, which correlates at the buffer length rather than the beat.
   */
  envelope(): Float64Array | null;
  reset(): void;
  dispose(): void;
}

export async function createOnsetTap(ctx: BaseAudioContext): Promise<OnsetTap | null> {
  if (!ctx.audioWorklet) return null;
  try {
    await ensureRegistered(ctx);
  } catch {
    return null;
  }

  const envelopeHz = ctx.sampleRate / ONSET_HOP;
  const capacity = Math.ceil(envelopeHz * ONSET_HISTORY_SECONDS);
  const ring = new Float64Array(capacity);
  let write = 0;
  let filled = 0;

  // One-pole lowpass, as a plain time constant rather than a biquad: the
  // split only has to separate the kick from the rest, and the slope is
  // irrelevant to whether an onset is detected.
  const lowpassA = 1 - Math.exp((-2 * Math.PI * SPLIT_HZ) / ctx.sampleRate);

  let node: AudioWorkletNode;
  try {
    node = new AudioWorkletNode(ctx, PROCESSOR_NAME, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: 2,
      channelCountMode: 'explicit',
      processorOptions: { hop: ONSET_HOP, lowpassA },
    });
  } catch {
    return null;
  }

  node.port.onmessage = (e: MessageEvent<number>) => {
    ring[write] = e.data;
    write = (write + 1) % capacity;
    if (filled < capacity) filled++;
  };

  return {
    node,
    envelopeHz,
    envelope(): Float64Array | null {
      if (filled < capacity) return null;
      const out = new Float64Array(capacity);
      for (let i = 0; i < capacity; i++) out[i] = ring[(write + i) % capacity];
      return out;
    },
    reset(): void {
      ring.fill(0);
      write = 0;
      filled = 0;
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

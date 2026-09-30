/**
 * Speaking the commentary over the music, and getting out of the way again.
 *
 * The speech arrives from main as a WAV buffer rather than being spoken
 * aloud there — `electron/speech.ts` explains why at length, but the short
 * version is that anything played to the default output device in Live mode
 * goes into BlackHole, which is our own input. Playing it here instead means
 * it reaches the same output the music does, and no measurement tap ever
 * sees it.
 *
 * Ducking happens at `duckGain`, never at `masterGain`. masterGain is the
 * user's volume and a literal multiplier by design; moving it from underneath
 * them would make the label a lie.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

/** How far the music drops under the voice, in dB. Enough to hear a sentence
 *  over a chorus without the track feeling like it stopped. */
const DUCK_DB = -11;

/** Ramp times. Down fast enough that the first word is not buried, up slowly
 *  enough that the music swells back rather than snapping. */
const DUCK_IN_S = 0.18;
const DUCK_OUT_S = 0.55;

/** Held after the last word before the music comes back, so the recovery is
 *  not racing the tail of the sentence. */
const HOLD_S = 0.15;

export type VoiceState =
  | { kind: 'idle' }
  | { kind: 'rendering' }
  | { kind: 'speaking' }
  /** Nothing to speak through: the app is not the thing making the sound, so
   *  the caller should show the sentence instead. */
  | { kind: 'unavailable'; reason: string };

export interface DjVoice {
  state: VoiceState;
  /** Render and speak. Resolves true if it was actually spoken. */
  say: (text: string) => Promise<boolean>;
  stop: () => void;
}

/**
 * @param enabled whether the user wants commentary spoken at all.
 * @param audible whether the app is currently the thing making the sound. If
 *   the user is listening to Spotify directly rather than through the app's
 *   output there is nothing to duck and nowhere to put the voice, so this
 *   degrades to text rather than talking to an output nobody is listening to.
 */
export function useDjVoice(options: {
  enabled: boolean;
  audible: boolean;
  duckGainRef: { current: GainNode | null };
  voiceGainRef: { current: GainNode | null };
}): DjVoice {
  const { enabled, audible, duckGainRef, voiceGainRef } = options;
  const [state, setState] = useState<VoiceState>({ kind: 'idle' });
  const sourceRef = useRef<AudioBufferSourceNode | null>(null);
  /** Bumped on every new request so a slow render that lands after the user
   *  has moved on is discarded rather than spoken over the next track. */
  const generationRef = useRef(0);

  const release = useCallback(
    (duck: GainNode | null) => {
      if (!duck) return;
      const ctx = duck.context;
      const at = ctx.currentTime + HOLD_S;
      duck.gain.cancelScheduledValues(ctx.currentTime);
      duck.gain.setValueAtTime(duck.gain.value, ctx.currentTime);
      duck.gain.setTargetAtTime(1, at, DUCK_OUT_S / 3);
    },
    [],
  );

  const stop = useCallback(() => {
    generationRef.current++;
    const source = sourceRef.current;
    sourceRef.current = null;
    if (source) {
      source.onended = null;
      try {
        source.stop();
      } catch {
        // Already finished; stop() on a stopped source throws.
      }
      source.disconnect();
    }
    release(duckGainRef.current);
    setState({ kind: 'idle' });
  }, [duckGainRef, release]);

  // A teardown mid-sentence would otherwise leave the music ducked forever.
  useEffect(() => stop, [stop]);

  const say = useCallback(
    async (text: string): Promise<boolean> => {
      if (!enabled) {
        setState({ kind: 'unavailable', reason: 'Commentary is off' });
        return false;
      }
      const voice = voiceGainRef.current;
      const duck = duckGainRef.current;
      if (!audible || !voice || !duck) {
        setState({
          kind: 'unavailable',
          // The distinction matters to the user: one is fixable by turning
          // playthrough on, the other means Live mode is not running at all.
          reason: !audible
            ? "You're listening to Spotify directly, so there's nothing to talk over"
            : 'Audio engine is not running',
        });
        return false;
      }

      stop();
      const generation = ++generationRef.current;
      setState({ kind: 'rendering' });

      let result: { ok: boolean; wav?: Uint8Array; reason?: string };
      try {
        result = (await window.api.speech.render(text)) as typeof result;
      } catch (err) {
        console.error('speech.render failed:', err);
        setState({ kind: 'unavailable', reason: 'Could not render speech' });
        return false;
      }
      if (generation !== generationRef.current) return false;
      if (!result.ok || !result.wav) {
        setState({ kind: 'unavailable', reason: result.reason ?? 'Could not render speech' });
        return false;
      }

      const ctx = voice.context;
      let buffer: AudioBuffer;
      try {
        // A copy, because decodeAudioData detaches the ArrayBuffer it is
        // given and this one came across IPC.
        const bytes = new Uint8Array(result.wav);
        buffer = await ctx.decodeAudioData(bytes.buffer as ArrayBuffer);
      } catch (err) {
        console.error('decoding speech failed:', err);
        setState({ kind: 'unavailable', reason: 'Could not decode speech' });
        return false;
      }
      if (generation !== generationRef.current) return false;

      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(voice);
      sourceRef.current = source;

      const now = ctx.currentTime;
      const target = Math.pow(10, DUCK_DB / 20);
      duck.gain.cancelScheduledValues(now);
      duck.gain.setValueAtTime(duck.gain.value, now);
      duck.gain.linearRampToValueAtTime(target, now + DUCK_IN_S);

      source.onended = () => {
        if (generation !== generationRef.current) return;
        sourceRef.current = null;
        release(duck);
        setState({ kind: 'idle' });
      };
      source.start();
      setState({ kind: 'speaking' });
      return true;
    },
    [enabled, audible, voiceGainRef, duckGainRef, stop, release],
  );

  return { state, say, stop };
}

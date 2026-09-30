/**
 * Rendering the DJ's commentary to audio, in main, as a buffer.
 *
 * The obvious implementation is `speechSynthesis` in the renderer, and it is
 * wrong here for a reason specific to this app. Live mode needs system output
 * pointed at BlackHole so the app can tap it, and `speechSynthesis` — like
 * `say` with no arguments, like everything else — plays to the DEFAULT output
 * device. So the voice would go into BlackHole, be captured by our own input,
 * and come back through the graph. Three things follow from that, all bad:
 *
 *   - the chroma, onset and BS.1770 taps all hang off `inputGain`, so the
 *     voice would be folded into the key, tempo and loudness recorded against
 *     whatever track is playing, and written to track memory as if it were
 *     part of the music;
 *   - the ducking gain sits downstream of the tap, so the voice would duck
 *     itself and nothing else;
 *   - and the EQ would process it.
 *
 * So the speech is rendered to a buffer instead and handed to the renderer,
 * which plays it through the audio graph at a point downstream of every tap.
 * It then reaches the same output device the music does, ducks the music
 * exactly rather than approximately, and is invisible to every measurement.
 *
 * `say` is a macOS built-in. No network, no key, no account.
 */

import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** Anything longer is not a sentence about a track, it is a prompt injection
 *  or a bug. `say` would happily read a megabyte aloud. */
const MAX_CHARACTERS = 400;

/** Speech is rendered at the rate the audio graph runs at, so the renderer
 *  never has to resample it. */
const SAMPLE_RATE = 48000;

/** `say` is fast, but a hung process must not wedge the feature. */
const TIMEOUT_MS = 15_000;

export interface SpeechResult {
  ok: boolean;
  /** 32-bit float WAV, mono, 48 kHz. Empty when `ok` is false. */
  wav?: Uint8Array;
  reason?: string;
}

/**
 * Render `text` to a WAV buffer.
 *
 * Every failure is a normal result rather than a throw: commentary is a
 * flourish on top of a feature that works without it, and the renderer's
 * fallback is simply to show the sentence instead of speaking it.
 */
export async function renderSpeech(text: unknown, voice?: unknown): Promise<SpeechResult> {
  if (typeof text !== 'string' || !text.trim()) {
    return { ok: false, reason: 'nothing to say' };
  }
  if (text.length > MAX_CHARACTERS) {
    return { ok: false, reason: 'too long' };
  }

  let dir: string | null = null;
  try {
    dir = await mkdtemp(join(tmpdir(), 'av-speech-'));
    const out = join(dir, 'line.wav');
    const args = [
      '-o', out,
      '--file-format=WAVE',
      `--data-format=LEF32@${SAMPLE_RATE}`,
    ];
    // A voice the user does not have installed makes `say` fail outright, so
    // it is only passed when one was asked for.
    if (typeof voice === 'string' && voice.trim()) args.push('-v', voice);
    // The text goes last and after `--`, so a line starting with a hyphen is
    // read aloud rather than parsed as a flag.
    args.push('--', text);
    await run('say', args, { timeout: TIMEOUT_MS });
    const wav = await readFile(out);
    return { ok: true, wav: new Uint8Array(wav) };
  } catch (err) {
    return { ok: false, reason: String((err as Error)?.message ?? err) };
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

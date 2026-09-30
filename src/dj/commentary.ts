/**
 * Saying out loud why a track was picked.
 *
 * Every clause here is built from a number that was actually measured. That
 * is the point: the app can say "four BPM up, one step round the wheel"
 * because it heard both tracks and worked both figures out, and if it cannot
 * say something it says so instead of inventing it.
 *
 * Deliberately template-driven rather than a language model. A model would
 * read better, and swapping one in later is a small change — but it needs a
 * key, a network round trip and a retry path, and none of that should sit
 * between pressing a button and hearing what happens next. It would also be
 * free to say things the measurements do not support, which is the one thing
 * this must not do.
 *
 * Compiled standalone by `scripts/check-enhancer.mjs`, so the only import is
 * a type — which TypeScript erases entirely. Keep it that way.
 */

import type { MixScore } from '../audio/mixCompatibility';

export interface TransitionSubject {
  /** Camelot code of the incoming track, e.g. "9A". The wheel's labelling
   *  lives in `musicalKey`; the caller formats it and passes it in so this
   *  file does not need a second copy of that table. */
  camelot: string | null;
  /** Stored key code of the incoming track, 0..23. Only used to say whether
   *  it is a major or a minor, which is the top bit and needs no table. */
  key: number | null;
  /** Tempo of the incoming track, for the absolute figure. */
  bpm: number | null;
}

export interface Commentary {
  /** One sentence, ready to show or speak. */
  sentence: string;
  /** The same facts as separate clauses, for chips in the UI. */
  clauses: string[];
}

/** Written out, because "4 BPM up" read aloud becomes "four b p m up" only
 *  if the number is a word. Past twelve the digits read fine. */
const NUMBER_WORDS = [
  'no', 'one', 'two', 'three', 'four', 'five', 'six',
  'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
];

function spell(n: number): string {
  const whole = Math.round(Math.abs(n));
  return whole < NUMBER_WORDS.length ? NUMBER_WORDS[whole] : String(whole);
}

function plural(n: number, word: string): string {
  return `${spell(n)} ${word}${Math.round(Math.abs(n)) === 1 ? '' : 's'}`;
}

/** How the two keys relate, in words. Null when there is nothing to say. */
function harmonicClause(score: MixScore, subject: TransitionSubject): string | null {
  const { relation, steps, modeChange } = score.harmonic;
  const mode = subject.key === null ? null : subject.key >= 12 ? 'minor' : 'major';
  switch (relation) {
    case 'same':
      return 'same key';
    case 'relative':
      return mode ? `into the relative ${mode}` : 'into its relative key';
    case 'neighbour':
      // The direction is the useful half: clockwise lifts, anticlockwise
      // settles, and that is what a DJ is choosing between.
      return steps !== null && steps > 0
        ? 'one step round the wheel'
        : 'one step back round the wheel';
    case 'near':
      return steps !== null
        ? `${plural(Math.abs(steps), 'step')} round the wheel${modeChange ? ', and a mode change' : ''}`
        : 'close on the wheel';
    case 'clash':
      return steps !== null
        ? `${plural(Math.abs(steps), 'step')} round the wheel, so the keys will fight`
        : 'the keys will fight';
    case 'unknown':
    default:
      return null;
  }
}

function tempoClause(score: MixScore): string | null {
  const { percent, deltaBpm } = score.tempo;
  if (percent === null || deltaBpm === null) return null;
  const rounded = Math.round(Math.abs(deltaBpm));
  // Under a BPM is not a tempo change, it is the same tempo measured twice.
  if (rounded < 1) return 'the same tempo';
  const direction = deltaBpm > 0 ? 'up' : 'down';
  const size = Math.abs(percent) > 8 ? 'a big step, ' : '';
  // BPM is an abbreviation, not a noun — "four BPMs up" is how you can tell
  // a sentence was assembled rather than written.
  return `${size}${spell(rounded)} BPM ${direction}`;
}

function energyClause(score: MixScore): string | null {
  const { deltaLufs, deltaBrightnessDb } = score.energy;
  // Only mention level when it is enough to hear. Below about 2 LU nobody
  // would notice, and saying it would pad the sentence with a non-fact.
  if (deltaLufs !== null && Math.abs(deltaLufs) >= 2) {
    return deltaLufs > 0 ? 'and it hits harder' : 'and it sits back a little';
  }
  if (Math.abs(deltaBrightnessDb) >= 4) {
    return deltaBrightnessDb > 0 ? 'and it opens up' : 'and it is warmer';
  }
  return null;
}

/** The lead-in, set by how good the transition actually is. Overselling a
 *  weak pick is the fastest way to stop being believed. */
function opener(score: MixScore): string {
  if (!score.known.harmonic && !score.known.tempo) return 'Going in blind here';
  if (score.score >= 0.85) return 'Next up';
  if (score.score >= 0.65) return 'This one should sit nicely';
  return 'Not a clean match, but';
}

/**
 * Describe a transition in one sentence.
 *
 * What is missing is stated rather than skipped: a track the app has never
 * heard the key of produces "we have not heard its key yet", because the
 * alternative is a confident-sounding sentence that quietly leaves out the
 * half that would have made it wrong.
 */
export function describeTransition(score: MixScore, subject: TransitionSubject): Commentary {
  const clauses: string[] = [];

  const harmonic = harmonicClause(score, subject);
  if (harmonic) {
    clauses.push(subject.camelot ? `${subject.camelot}, ${harmonic}` : harmonic);
  } else {
    clauses.push("we haven't heard its key yet");
  }

  const tempoText = tempoClause(score);
  if (tempoText) clauses.push(tempoText);
  else clauses.push("and no tempo on it yet");

  const energy = energyClause(score);
  if (energy) clauses.push(energy);

  // Join with commas and an "and" before the last, unless a clause already
  // begins with one — several of them do, because they read better that way.
  const body = clauses.reduce((acc, clause, i) => {
    if (i === 0) return clause;
    const joiner = clause.startsWith('and ') ? ', ' : i === clauses.length - 1 ? ', and ' : ', ';
    return acc + joiner + clause;
  }, '');

  return { sentence: `${opener(score)} — ${body}.`, clauses };
}

/**
 * A short reason for a list row, where a full sentence would not fit.
 *
 * Not the sentence truncated: the row needs the two facts that decide the
 * ranking, and truncation would drop whichever came last.
 */
export function summariseTransition(score: MixScore, subject: TransitionSubject): string {
  const parts: string[] = [];
  if (score.known.harmonic) {
    const relation = score.harmonic.relation;
    const label = subject.camelot ?? 'key';
    parts.push(
      relation === 'same'
        ? `${label} · same key`
        : relation === 'relative'
          ? `${label} · relative`
          : relation === 'neighbour'
            ? `${label} · one step`
            : relation === 'near'
              ? `${label} · ${Math.abs(score.harmonic.steps ?? 0)} steps`
              : `${label} · clashes`,
    );
  } else {
    parts.push('key unknown');
  }
  if (score.tempo.deltaBpm !== null) {
    const d = Math.round(score.tempo.deltaBpm);
    const bpm = subject.bpm !== null ? `${Math.round(subject.bpm)} BPM` : 'tempo';
    parts.push(d === 0 ? `${bpm} · same` : `${bpm} · ${d > 0 ? '+' : ''}${d}`);
  } else {
    parts.push('tempo unknown');
  }
  return parts.join('  ·  ');
}

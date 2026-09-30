/**
 * Turning "something a bit more chill" into a bias on the ranking.
 *
 * Offline and vocabulary-based, on purpose. The features this can act on are
 * the four the app actually measures — tempo, loudness, spectral tilt and
 * key — so the useful vocabulary is small enough to write down, and a model
 * would mostly be translating English into those same four knobs at the cost
 * of a network round trip. It would handle phrasing this misses, and it is an
 * easy swap later; it would not extend what can be asked for.
 *
 * The real limit is not the parser and no model changes it: a request can
 * only ever be met from tracks the app has already heard. `useDjSuggestions`
 * reports that coverage and the panel shows it, because the alternative is
 * quietly returning the best of a bad pool and looking like the taste is off.
 *
 * Compiled standalone by `scripts/check-enhancer.mjs`, so the only import is
 * a type — which TypeScript erases entirely. Keep it that way.
 */

import type { MixScore } from '../audio/mixCompatibility';

export type Direction = 'up' | 'down';

export interface Intent {
  /** Faster or slower than what is playing. */
  tempo: Direction | null;
  /** Louder and harder, or softer and further back. */
  energy: Direction | null;
  /** Brighter or warmer. */
  brightness: Direction | null;
  /** Whether the user asked to stay in key, which raises the harmonic term
   *  rather than biasing a feature. */
  holdKey: boolean;
  /** The phrases that were recognised, so the UI can show what it understood
   *  rather than silently doing something else. */
  matched: string[];
  /** Nothing was recognised. The caller should say so and rank unbiased. */
  empty: boolean;
}

/**
 * The vocabulary, as phrases rather than single words.
 *
 * Phrases because the single words are ambiguous in the way that matters:
 * "chill" alone means slower AND softer, while "chill out" is only about
 * energy, and "hard" is energy while "harder" after "hit" is not. Longest
 * match wins, so a phrase always beats a word inside it.
 */
const PHRASES: Array<{ text: string; apply: (i: MutableIntent) => void }> = [
  // ── Tempo ──
  { text: 'double time', apply: (i) => { i.tempo = 'up'; } },
  { text: 'half time', apply: (i) => { i.tempo = 'down'; } },
  { text: 'pick up the pace', apply: (i) => { i.tempo = 'up'; i.energy = 'up'; } },
  { text: 'pick up the energy', apply: (i) => { i.energy = 'up'; i.tempo = 'up'; } },
  { text: 'pick it up', apply: (i) => { i.tempo = 'up'; i.energy = 'up'; } },
  { text: 'speed up', apply: (i) => { i.tempo = 'up'; } },
  { text: 'slow down', apply: (i) => { i.tempo = 'down'; } },
  { text: 'wind down', apply: (i) => { i.tempo = 'down'; i.energy = 'down'; } },
  { text: 'uptempo', apply: (i) => { i.tempo = 'up'; } },
  { text: 'downtempo', apply: (i) => { i.tempo = 'down'; } },
  { text: 'faster', apply: (i) => { i.tempo = 'up'; } },
  { text: 'quicker', apply: (i) => { i.tempo = 'up'; } },
  { text: 'slower', apply: (i) => { i.tempo = 'down'; } },

  // ── Energy ──
  { text: 'turn it up', apply: (i) => { i.energy = 'up'; } },
  { text: 'bring it down', apply: (i) => { i.energy = 'down'; i.tempo = 'down'; } },
  { text: 'keep it going', apply: (i) => { i.energy = 'up'; } },
  { text: 'more energy', apply: (i) => { i.energy = 'up'; } },
  { text: 'less energy', apply: (i) => { i.energy = 'down'; } },
  { text: 'bigger', apply: (i) => { i.energy = 'up'; } },
  { text: 'harder', apply: (i) => { i.energy = 'up'; } },
  { text: 'heavier', apply: (i) => { i.energy = 'up'; } },
  { text: 'hype', apply: (i) => { i.energy = 'up'; i.tempo = 'up'; } },
  { text: 'banger', apply: (i) => { i.energy = 'up'; } },
  { text: 'chill out', apply: (i) => { i.energy = 'down'; } },
  { text: 'chilled', apply: (i) => { i.energy = 'down'; i.tempo = 'down'; } },
  { text: 'chill', apply: (i) => { i.energy = 'down'; i.tempo = 'down'; } },
  { text: 'mellow', apply: (i) => { i.energy = 'down'; i.tempo = 'down'; } },
  { text: 'calmer', apply: (i) => { i.energy = 'down'; i.tempo = 'down'; } },
  { text: 'calm', apply: (i) => { i.energy = 'down'; i.tempo = 'down'; } },
  { text: 'softer', apply: (i) => { i.energy = 'down'; } },
  { text: 'quieter', apply: (i) => { i.energy = 'down'; } },
  { text: 'relax', apply: (i) => { i.energy = 'down'; i.tempo = 'down'; } },

  // ── Brightness ──
  { text: 'brighter', apply: (i) => { i.brightness = 'up'; } },
  { text: 'crisper', apply: (i) => { i.brightness = 'up'; } },
  { text: 'warmer', apply: (i) => { i.brightness = 'down'; } },
  { text: 'darker', apply: (i) => { i.brightness = 'down'; } },
  { text: 'deeper', apply: (i) => { i.brightness = 'down'; i.energy = 'down'; } },
  { text: 'moodier', apply: (i) => { i.brightness = 'down'; } },
  { text: 'moody', apply: (i) => { i.brightness = 'down'; } },

  // ── Key ──
  { text: 'keep it in this key', apply: (i) => { i.holdKey = true; } },
  { text: 'same key', apply: (i) => { i.holdKey = true; } },
  { text: 'in key', apply: (i) => { i.holdKey = true; } },
  { text: 'in the key', apply: (i) => { i.holdKey = true; } },
  { text: 'stay in key', apply: (i) => { i.holdKey = true; } },
  { text: 'harmonic', apply: (i) => { i.holdKey = true; } },
];

type MutableIntent = {
  tempo: Direction | null;
  energy: Direction | null;
  brightness: Direction | null;
  holdKey: boolean;
};

/** Longest first, so "chill out" is never read as "chill". */
const SORTED = [...PHRASES].sort((a, b) => b.text.length - a.text.length);

export function parseIntent(text: string): Intent {
  const state: MutableIntent = { tempo: null, energy: null, brightness: null, holdKey: false };
  const matched: string[] = [];
  if (typeof text !== 'string' || !text.trim()) {
    return { ...state, matched, empty: true };
  }

  // Blank out each phrase as it is consumed, so overlapping entries cannot
  // both fire on the same words.
  let haystack = ` ${text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ')} `;
  for (const phrase of SORTED) {
    const needle = ` ${phrase.text} `;
    const at = haystack.indexOf(needle);
    if (at === -1) continue;
    phrase.apply(state);
    matched.push(phrase.text);
    haystack = `${haystack.slice(0, at + 1)}${' '.repeat(phrase.text.length)}${haystack.slice(at + 1 + phrase.text.length)}`;
  }

  return { ...state, matched, empty: matched.length === 0 };
}

/**
 * How far a request may move the ranking.
 *
 * Compatibility still decides: a request for something faster should reorder
 * the tracks that work, not promote one that clashes. At 0.3 a strong match
 * on every axis still beats a clash that happens to be going the right way,
 * which is the behaviour to keep.
 */
const INTENT_STRENGTH = 0.3;

/** Tempo difference, in percent, treated as fully satisfying "faster". */
const TEMPO_SATISFIED_PERCENT = 8;
/** Loudness difference, in LU, treated as fully satisfying "harder". */
const ENERGY_SATISFIED_LU = 4;
/** Tilt difference, in dB, treated as fully satisfying "brighter". */
const BRIGHTNESS_SATISFIED_DB = 5;

function towards(value: number | null, direction: Direction | null, satisfied: number): number | null {
  if (direction === null || value === null) return null;
  const signed = direction === 'up' ? value : -value;
  return Math.max(-1, Math.min(1, signed / satisfied));
}

/**
 * Bias a transition's score by what was asked for.
 *
 * Returns the adjusted score and which parts of the request this candidate
 * could actually be judged against — a track with no stored tempo cannot
 * answer "faster", and the caller needs to be able to say so rather than
 * ranking it as though it had.
 */
export function applyIntent(
  score: MixScore,
  intent: Intent,
): { score: number; satisfied: number | null } {
  if (intent.empty) return { score: score.score, satisfied: null };

  const terms: number[] = [];
  const tempo = towards(score.tempo.percent, intent.tempo, TEMPO_SATISFIED_PERCENT);
  if (tempo !== null) terms.push(tempo);
  const energy = towards(score.energy.deltaLufs, intent.energy, ENERGY_SATISFIED_LU);
  if (energy !== null) terms.push(energy);
  const brightness = towards(
    score.energy.deltaBrightnessDb,
    intent.brightness,
    BRIGHTNESS_SATISFIED_DB,
  );
  if (brightness !== null) terms.push(brightness);
  // "Keep it in this key" is not a feature to push toward — it is the
  // harmonic term, asked for louder. Same-number keys read as 1, a clash
  // as -1.
  if (intent.holdKey && score.known.harmonic) {
    terms.push(score.harmonic.score * 2 - 1);
  }

  if (!terms.length) return { score: score.score, satisfied: null };
  const bias = terms.reduce((a, b) => a + b, 0) / terms.length;
  return {
    score: Math.max(0, Math.min(1, score.score + INTENT_STRENGTH * bias)),
    satisfied: bias,
  };
}

/** What the app understood, in the user's own terms, for the UI to echo
 *  back. Saying nothing here is how a misread request stays invisible. */
export function describeIntent(intent: Intent): string {
  if (intent.empty) return 'ranking on compatibility alone';
  const parts: string[] = [];
  if (intent.tempo) parts.push(intent.tempo === 'up' ? 'faster' : 'slower');
  if (intent.energy) parts.push(intent.energy === 'up' ? 'more energy' : 'less energy');
  if (intent.brightness) parts.push(intent.brightness === 'up' ? 'brighter' : 'warmer');
  if (intent.holdKey) parts.push('staying in key');
  return `leaning ${parts.join(', ')}`;
}

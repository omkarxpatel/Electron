/**
 * The overnight learner's plan: which songs a run plays, and which slices of
 * each it listens to.
 *
 * A run plays songs silently so track memory learns them. Hearing a whole
 * song costs its full length for a key and tempo that settle in seconds, so a
 * run listens to an intro, a middle and an outro instead.
 *
 * `import type` only, on purpose: `scripts/check-enhancer.mjs` compiles this
 * file standalone and runs it under plain node, which cannot resolve an
 * extensionless relative import. A value import drops it out of the only
 * test coverage this repo has.
 */
import type { TrackProfile } from '../audio/trackProfile';

// ── Constants ────────────────────────────────────────────────────────────

/** Bumped when a run learns something it did not before, so tracks marked at
 *  an older version are heard again. */
export const LEARN_VERSION = 1;
export const INTRO_MS = 15_000;
export const MIDDLE_MS = 30_000;
export const OUTRO_MS = 15_000;
export const MIDDLE_AT_FRACTION = 0.4;
/** `MIN_COMMIT_SECONDS` restated in ms. Below it a measurement is refused,
 *  so a song this short could be played and never learned. Not imported:
 *  see the header. */
export const MIN_LEARNABLE_MS = 20_000;
export const TRUSTED_TEMPO_CONFIDENCE = 0.6;
/** Planning figure for a run's length: the slices plus seeking and settling. */
export const ESTIMATE_MS_PER_SONG = 75_000;

// ── Types ────────────────────────────────────────────────────────────────

export type MeasureMode = 'all' | 'key-tempo' | 'none';
export type SectionName = 'intro' | 'middle' | 'outro' | 'whole';
export interface SectionWindow {
  name: SectionName;
  startMs: number;
  listenMs: number;
  mode: MeasureMode;
}
export interface LearnCandidate {
  id: string;
  uri: string;
  name: string;
  artists: string;
  durationMs: number;
  isLocal: boolean;
}
export interface LearnQueueItem extends LearnCandidate {
  windows: SectionWindow[];
}
export type SkipReason = 'local-file' | 'not-a-track' | 'too-short' | 'duplicate' | 'already-learned';
export interface LearnPlan {
  queue: LearnQueueItem[];
  skipped: Array<{ candidate: LearnCandidate; reason: SkipReason }>;
}

// ── Slices ───────────────────────────────────────────────────────────────

export function sectionWindows(durationMs: number): SectionWindow[] {
  if (durationMs < INTRO_MS + MIDDLE_MS + OUTRO_MS) {
    return [{ name: 'whole', startMs: 0, listenMs: durationMs, mode: 'all' }];
  }
  let middleStart = Math.round(durationMs * MIDDLE_AT_FRACTION);
  // A short song puts 40% of the way in on top of the intro or outro, and
  // the same seconds would be heard twice. Centre it in the gap instead.
  if (middleStart < INTRO_MS || middleStart + MIDDLE_MS > durationMs - OUTRO_MS) {
    middleStart = Math.round((durationMs - MIDDLE_MS) / 2);
  }
  return [
    { name: 'intro', startMs: 0, listenMs: INTRO_MS, mode: 'key-tempo' },
    { name: 'middle', startMs: middleStart, listenMs: MIDDLE_MS, mode: 'all' },
    { name: 'outro', startMs: durationMs - OUTRO_MS, listenMs: OUTRO_MS, mode: 'key-tempo' },
  ];
}

// ── Priority ─────────────────────────────────────────────────────────────

export function isLearned(p: TrackProfile | null): boolean {
  return (p?.learnVersion ?? 0) >= LEARN_VERSION;
}

/** 0 lacks a key or tempo, 1 has a tempo it should not trust, 2 the rest.
 *  Lower is learned first, so a night that ends early has fixed the worst. */
export function learnPriority(p: TrackProfile | null): 0 | 1 | 2 {
  if (!p || p.key === null || p.bpm === null) return 0;
  if (p.bpmConfidence < TRUSTED_TEMPO_CONFIDENCE) return 1;
  return 2;
}

// ── Plan ─────────────────────────────────────────────────────────────────

export function planRun(
  candidates: LearnCandidate[],
  recall: (id: string) => TrackProfile | null,
): LearnPlan {
  const skipped: LearnPlan['skipped'] = [];
  const seen = new Set<string>();
  const keep: Array<{ item: LearnQueueItem; priority: 0 | 1 | 2 }> = [];
  for (const candidate of candidates) {
    const skip = (reason: SkipReason): void => {
      skipped.push({ candidate, reason });
    };
    if (candidate.isLocal) skip('local-file');
    else if (!candidate.id || !candidate.uri.startsWith('spotify:track:')) skip('not-a-track');
    else if (candidate.durationMs < MIN_LEARNABLE_MS) skip('too-short');
    else if (seen.has(candidate.id)) skip('duplicate');
    else {
      seen.add(candidate.id);
      const profile = recall(candidate.id);
      if (isLearned(profile)) skip('already-learned');
      else {
        keep.push({
          item: { ...candidate, windows: sectionWindows(candidate.durationMs) },
          priority: learnPriority(profile),
        });
      }
    }
  }
  // Array.prototype.sort is stable, so each priority keeps the caller's order.
  keep.sort((a, b) => a.priority - b.priority);
  return { queue: keep.map((k) => k.item), skipped };
}

export function estimateRunMs(songs: number): number {
  return songs * ESTIMATE_MS_PER_SONG;
}

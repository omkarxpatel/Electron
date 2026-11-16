/**
 * The overnight learner's run machine: a pure reducer that decides every step
 * of a learning run and names the effects the executing hook must perform.
 *
 * No I/O, timers or React in here. The hook owns those; this owns the order.
 * The order matters because the run is silent: the app is muted while Spotify
 * plays into BlackHole, so unmuting while Spotify might still be playing blasts
 * a song out of the speakers at night. The only unmutes are after Spotify
 * reports `is_playing: false`, or when a person pressed Stop on playback that
 * was theirs.
 *
 * `import type` only, on purpose: `scripts/check-enhancer.mjs` compiles this
 * file standalone and runs it under plain node, which cannot resolve an
 * extensionless relative import. A value import drops it out of the only
 * test coverage this repo has.
 */
import type { LearnPlan, LearnQueueItem, MeasureMode } from './learnPlan';

// ── Constants ────────────────────────────────────────────────────────────

export const CONFIRM_TIMEOUT_MS = 10_000;
/** At least three enhancer ticks at 10 Hz, so a measurement is committed
 *  before the next song's audio can overwrite what was just heard. */
export const COMMIT_SETTLE_MS = 400;
export const INPUT_GIVE_UP_MS = 600_000;

// ── Types ────────────────────────────────────────────────────────────────

export interface LearnTally {
  learned: number;
  skipped: number;
  failed: Array<{ id: string; name: string; reason: string }>;
}
export type PauseReason = 'input-lost' | 'silence' | 'takeover' | 'device-lost';
export type EndReason = 'finished' | 'stopped' | 'signed-out' | 'input-timeout';
export type LearnState =
  | { kind: 'idle' }
  | {
      kind: 'running';
      queue: LearnQueueItem[];
      index: number;
      section: number;
      step: 'starting' | 'listening' | 'settling';
      attempt: number;
      tally: LearnTally;
    }
  | { kind: 'paused'; reason: PauseReason; queue: LearnQueueItem[]; index: number; since: number; tally: LearnTally }
  | { kind: 'ending'; reason: EndReason; tally: LearnTally }
  | { kind: 'done'; reason: EndReason; tally: LearnTally; muted: boolean };
export type LearnEvent =
  | { kind: 'start'; plan: LearnPlan }
  | { kind: 'confirmed' }
  | { kind: 'confirm-timeout' }
  | { kind: 'section-elapsed' }
  | { kind: 'committed' }
  | { kind: 'input-lost'; now: number }
  | { kind: 'input-back' }
  | { kind: 'silence' }
  | { kind: 'takeover' }
  | { kind: 'device-lost' }
  | { kind: 'resume' }
  | { kind: 'stop' }
  | { kind: 'signed-out' }
  | { kind: 'tick'; now: number }
  | { kind: 'spotify-paused' }
  | { kind: 'pause-failed' };
export type LearnEffect =
  | { kind: 'mute'; on: boolean }
  | { kind: 'keep-awake'; on: boolean }
  | { kind: 'play'; uri: string; positionMs: number }
  | { kind: 'seek'; positionMs: number }
  | { kind: 'pause-spotify' }
  | { kind: 'measure'; trackId: string | null; mode: MeasureMode }
  | { kind: 'reset-onset' }
  | { kind: 'reset-loudness' }
  | { kind: 'snapshot-loudness' }
  | { kind: 'await-confirm'; trackId: string; fromMs: number; toMs: number }
  | { kind: 'wait'; ms: number; then: 'section-elapsed' | 'committed' }
  | { kind: 'mark-learned'; trackId: string };
export interface Step {
  state: LearnState;
  effects: LearnEffect[];
}

// ── Helpers ──────────────────────────────────────────────────────────────

/** Stop measuring a track without clearing what it learned. */
const quiet = (trackId: string | null): LearnEffect => ({ kind: 'measure', trackId, mode: 'none' });

/** Start a section: measuring is off while Spotify moves, so the seek's
 *  transient is never learned. `restart` is a song being resumed mid-way, which
 *  must `play` because Spotify may no longer hold the track at all. */
function beginSection(
  queue: LearnQueueItem[],
  index: number,
  section: number,
  attempt: number,
  tally: LearnTally,
  restart: boolean,
): Step {
  const item = queue[index];
  const w = item.windows[section];
  return {
    state: { kind: 'running', queue, index, section, step: 'starting', attempt, tally },
    effects: [
      quiet(item.id),
      section === 0 || restart
        ? { kind: 'play', uri: item.uri, positionMs: w.startMs }
        : { kind: 'seek', positionMs: w.startMs },
      { kind: 'await-confirm', trackId: item.id, fromMs: w.startMs, toMs: w.startMs + w.listenMs },
    ],
  };
}

/** Next song, or a finished run. A finished run still has to pause Spotify
 *  before it may unmute. */
function nextSong(queue: LearnQueueItem[], index: number, tally: LearnTally, lead: LearnEffect[]): Step {
  if (index + 1 < queue.length) {
    const b = beginSection(queue, index + 1, 0, 0, tally, false);
    return { state: b.state, effects: [...lead, ...b.effects] };
  }
  return { state: { kind: 'ending', reason: 'finished', tally }, effects: [...lead, { kind: 'pause-spotify' }] };
}

const ignore = (state: LearnState): Step => ({ state, effects: [] });

// ── Reducer ──────────────────────────────────────────────────────────────

export function learnStep(state: LearnState, event: LearnEvent): Step {
  // Signing out ends a run from any active state. The app stays muted: we
  // cannot ask Spotify whether it stopped, so unmuting would be a guess.
  if (event.kind === 'signed-out' && (state.kind === 'running' || state.kind === 'paused' || state.kind === 'ending')) {
    return {
      state: { kind: 'done', reason: 'signed-out', tally: state.tally, muted: true },
      effects: [quiet(null), { kind: 'keep-awake', on: false }],
    };
  }

  switch (state.kind) {
    case 'idle': {
      if (event.kind !== 'start') return ignore(state);
      const tally: LearnTally = { learned: 0, skipped: event.plan.skipped.length, failed: [] };
      if (event.plan.queue.length === 0) {
        return { state: { kind: 'done', reason: 'finished', tally, muted: false }, effects: [] };
      }
      const b = beginSection(event.plan.queue, 0, 0, 0, tally, false);
      return {
        state: b.state,
        effects: [{ kind: 'keep-awake', on: true }, { kind: 'mute', on: true }, ...b.effects],
      };
    }

    case 'running': {
      const { queue, index, section, step, attempt, tally } = state;
      const item = queue[index];
      const w = item.windows[section];
      switch (event.kind) {
        case 'confirmed': {
          if (step !== 'starting') return ignore(state);
          return {
            state: { ...state, step: 'listening' },
            effects: [
              { kind: 'reset-onset' },
              ...(w.mode === 'all' ? [{ kind: 'reset-loudness' } as LearnEffect] : []),
              { kind: 'measure', trackId: item.id, mode: w.mode },
              { kind: 'wait', ms: w.listenMs, then: 'section-elapsed' },
            ],
          };
        }
        case 'confirm-timeout': {
          if (step !== 'starting') return ignore(state);
          if (attempt === 0) return beginSection(queue, index, section, 1, tally, false);
          const failed = [...tally.failed, { id: item.id, name: item.name, reason: 'Spotify did not start playback' }];
          return nextSong(queue, index, { ...tally, failed }, [quiet(null)]);
        }
        case 'section-elapsed': {
          if (step !== 'listening') return ignore(state);
          const lead: LearnEffect[] = [...(w.mode === 'all' ? [{ kind: 'snapshot-loudness' } as LearnEffect] : []), quiet(item.id)];
          if (section + 1 < item.windows.length) {
            const b = beginSection(queue, index, section + 1, 0, tally, false);
            return { state: b.state, effects: [...lead, ...b.effects] };
          }
          return {
            state: { ...state, step: 'settling' },
            effects: [...lead, quiet(null), { kind: 'wait', ms: COMMIT_SETTLE_MS, then: 'committed' }],
          };
        }
        case 'committed': {
          if (step !== 'settling') return ignore(state);
          return nextSong(queue, index, { ...tally, learned: tally.learned + 1 }, [{ kind: 'mark-learned', trackId: item.id }]);
        }
        case 'input-lost':
          // Spotify is still playing into BlackHole, so it is not paused here.
          return {
            state: { kind: 'paused', reason: 'input-lost', queue, index, since: event.now, tally },
            effects: [quiet(item.id)],
          };
        case 'silence':
          return {
            state: { kind: 'paused', reason: 'silence', queue, index, since: 0, tally },
            effects: [{ kind: 'pause-spotify' }, quiet(item.id)],
          };
        case 'takeover':
        case 'device-lost':
          // Someone else is playing, or the output moved. Pausing would stop
          // their music; unmuting would put ours on the speakers.
          return {
            state: { kind: 'paused', reason: event.kind, queue, index, since: 0, tally },
            effects: [quiet(item.id)],
          };
        case 'stop':
          return {
            state: { kind: 'ending', reason: 'stopped', tally },
            effects: [quiet(null), { kind: 'pause-spotify' }],
          };
        default:
          return ignore(state);
      }
    }

    case 'paused': {
      const { reason, queue, index, tally } = state;
      const restart = (): Step => beginSection(queue, index, 0, 0, tally, true);
      switch (event.kind) {
        case 'input-back':
          return reason === 'input-lost' ? restart() : ignore(state);
        case 'resume':
          return reason === 'input-lost' ? ignore(state) : restart();
        case 'tick':
          if (reason === 'input-lost' && event.now - state.since >= INPUT_GIVE_UP_MS) {
            return { state: { kind: 'ending', reason: 'input-timeout', tally }, effects: [{ kind: 'pause-spotify' }] };
          }
          return ignore(state);
        case 'stop':
          if (reason === 'takeover' || reason === 'device-lost') {
            // A person pressed Stop and the playback is theirs.
            return {
              state: { kind: 'done', reason: 'stopped', tally, muted: false },
              effects: [quiet(null), { kind: 'keep-awake', on: false }, { kind: 'mute', on: false }],
            };
          }
          return {
            state: { kind: 'ending', reason: 'stopped', tally },
            effects: [quiet(null), { kind: 'pause-spotify' }],
          };
        default:
          return ignore(state);
      }
    }

    case 'ending': {
      if (event.kind === 'spotify-paused') {
        return {
          state: { kind: 'done', reason: state.reason, tally: state.tally, muted: false },
          effects: [{ kind: 'keep-awake', on: false }, { kind: 'mute', on: false }],
        };
      }
      if (event.kind === 'pause-failed') {
        // Spotify may still be playing, so the app stays muted.
        return {
          state: { kind: 'done', reason: state.reason, tally: state.tally, muted: true },
          effects: [{ kind: 'keep-awake', on: false }],
        };
      }
      return ignore(state);
    }

    default:
      return ignore(state);
  }
}

// ── Confirmation ─────────────────────────────────────────────────────────

export interface PlayerSnapshot {
  itemId: string | null;
  linkedFromId: string | null;
  isPlaying: boolean;
  progressMs: number;
}

/** Spotify relinks a track to a regional copy, so the id it reports can be the
 *  replacement while the id we asked for sits in `linkedFromId`. A second of
 *  slack below the start covers a seek that lands just early. */
export function playerMatches(p: PlayerSnapshot, trackId: string, fromMs: number, toMs: number): boolean {
  return (
    (p.itemId === trackId || p.linkedFromId === trackId) &&
    p.isPlaying &&
    p.progressMs >= fromMs - 1000 &&
    p.progressMs < toMs
  );
}

/**
 * The overnight learner's executor. `learnMachine.ts` decides every step of a
 * run; this hook performs the effects it names against Spotify, the audio
 * graph and main, and turns what it observes back into events.
 *
 * Every timer and poll belongs to one state. A transition cancels them all
 * and bumps `step`, and every callback checks it before dispatching. Events
 * carry no section id, so a `confirmed`, `section-elapsed` or `committed`
 * left over from before a pause would otherwise act on the restarted section,
 * and a poll from a stopped run would act on the next one. A new run is a
 * transition too, so this is also the run-scoped generation.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getDevices, getPlaybackState, getPlaylistTracks, pause, play, seek } from '../spotify/api';
import type { SpotifyPlaybackState } from '../spotify/types';
import type { TrackProfile } from '../audio/trackProfile';
import type { LoudnessTap } from '../audio/loudnessTap';
import type { OnsetTap } from '../audio/onsetTap';
import { writeLearnMuteFlag } from '../state/learnMute';
import { entryTrack } from './useDjSuggestions';
import {
  estimateRunMs,
  LEARN_VERSION,
  planRun,
  type LearnCandidate,
  type LearnPlan,
  type MeasureMode,
  type SectionName,
} from './learnPlan';
import {
  COMMIT_SETTLE_MS,
  CONFIRM_TIMEOUT_MS,
  learnStep,
  playerMatches,
  type LearnEffect,
  type LearnEvent,
  type LearnState,
} from './learnMachine';

// ── Constants ────────────────────────────────────────────────────────────

export const TAKEOVER_POLL_MS = 3_000;
export const CONFIRM_POLL_MS = 500;
export const SILENCE_LUFS = -70;
export const SILENCE_MS = 8_000;
/** Without a tick while paused, the machine's 10-minute input give-up never
 *  fires and a run waits on a dead input all night. */
const PAUSED_TICK_MS = 10_000;
const SILENCE_CHECK_MS = 500;
const PAUSE_CONFIRM_TIMEOUT_MS = 10_000;
const RATE_LIMIT_RETRIES = 3;
/** `request()` throws on a 429 without its Retry-After header, so every
 *  rate limit waits this long. */
const RATE_LIMIT_WAIT_MS = 5_000;
/** A slice that runs to the track's end stops this far short of it. Past the
 *  end Spotify stops or autoplays another song: measured, that is the next
 *  song folded into this one; polled, it reads as someone taking over. */
const TRACK_END_MARGIN_MS = 1_000;
const PLAYLIST_PAGE = 100;

// ── Types ────────────────────────────────────────────────────────────────

export interface LearnerDeps {
  markLearned(trackId: string, version: number): boolean;
  recall(trackId: string | null): TrackProfile | null;
  setLearnMuted(muted: boolean): void;
  measureGateRef: { current: { mode: MeasureMode } };
  learnLufsRef: { current: number | null | undefined };
  onsetTapRef: { current: OnsetTap | null };
  loudnessTapRef: { current: LoudnessTap | null };
  inputLive: boolean;                       // !!audioSource.stream
  live: boolean;                            // audioActive
  aiEnhance: boolean; setAiEnhance(on: boolean): void;
  rememberTracks: boolean; setRememberTracks(on: boolean): void;
}
export type PreflightItem = 'live' | 'ai-enhance' | 'remember-tracks' | 'spotify-device';
export interface OvernightLearner {
  state: LearnState;
  measuring: { trackId: string | null } | null;   // null unless running, paused or ending
  current: { name: string; artists: string; section: SectionName; index: number; total: number; etaMs: number } | null;
  preflight(): Promise<PreflightItem[]>;          // empty = ready
  plan(playlistIds: string[]): Promise<LearnPlan>; // scans every page; no budget cap
  start(plan: LearnPlan, fixSettings: boolean): void;
  resume(): void;
  stop(): void;
}

type Alive = () => boolean;

// ── Spotify errors ───────────────────────────────────────────────────────

/** What `request()` throws once a 401 has survived its one refresh, and what
 *  auth.ts throws when no session is left to refresh. A refresh that failed
 *  on a 5xx or the network is not here: the session still exists, and ending
 *  a run muted over a blip at 3 a.m. would throw the night away. */
const SIGNED_OUT_RE = /Spotify API 401|Not authenticated|No refresh token|No Spotify Client ID|Token refresh failed \(40[01]\)/;
const isSignedOut = (err: unknown): boolean => SIGNED_OUT_RE.test(String(err));
const STALE = new Error('learner: the step this call belonged to is over');

/** A rate limit at 3 a.m. must slow the run down, not end it. A call whose
 *  step is over is never sent: a stale `play` retried after Stop would start
 *  the music the stop just paused. */
async function rateLimited<T>(call: () => Promise<T>, alive: Alive): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    if (!alive()) throw STALE;
    try {
      return await call();
    } catch (err) {
      if (!String(err).includes('Spotify API 429') || attempt >= RATE_LIMIT_RETRIES) throw err;
      await new Promise((resolve) => setTimeout(resolve, RATE_LIMIT_WAIT_MS));
    }
  }
}

const itemIs = (p: SpotifyPlaybackState, trackId: string): boolean =>
  p.item?.id === trackId || p.item?.linked_from?.id === trackId;

// ── Runner ───────────────────────────────────────────────────────────────

function createRunner(
  depsRef: { current: LearnerDeps },
  publish: (s: LearnState) => void,
  publishMeasuring: (trackId: string | null) => void,
) {
  let state: LearnState = { kind: 'idle' };
  let step = 0;
  const timers = new Set<number>();
  /** Spotify mutations, one at a time. A pause sent while a play is still in
   *  flight can land first, and the play then starts music after the poll
   *  has already seen `is_playing: false` and unmuted. */
  let mutations: Promise<unknown> = Promise.resolve();
  /** The device of the run's first confirmation. Undefined until then. */
  let deviceId: string | null | undefined;
  let confirmedAt: { progressMs: number; atMs: number } | null = null;
  let silentSince: number | null = null;
  /** Paused for silence: whether Spotify has shown our pause took. */
  let pauseLanded = false;
  let restore: { aiEnhance: boolean; rememberTracks: boolean } | null = null;

  const aliveFor = (s: number): Alive => () => step === s;

  function cancelAll(): void {
    step++;
    for (const t of timers) window.clearTimeout(t);
    timers.clear();
  }

  function later(alive: Alive, ms: number, fn: () => void): void {
    const t = window.setTimeout(() => {
      timers.delete(t);
      if (alive()) fn();
    }, ms);
    timers.add(t);
  }

  function dispatch(event: LearnEvent): void {
    const prev = state;
    const { state: next, effects } = learnStep(prev, event);
    if (next === prev) return; // ignored: this step's timers stay
    state = next;
    cancelAll();
    silentSince = null;
    pauseLanded = false;
    const alive = aliveFor(step);
    for (const e of effects) run(e, prev, alive);
    watch(alive);
    if (next.kind === 'done') finish(alive);
    publish(state);
  }

  function mutate(alive: Alive, call: () => Promise<void>): Promise<void> {
    const p = mutations.then(() => rateLimited(call, alive));
    mutations = p.catch(() => undefined);
    return p;
  }

  function failed(err: unknown, alive: Alive): void {
    if (alive() && isSignedOut(err)) dispatch({ kind: 'signed-out' });
  }

  function run(e: LearnEffect, prev: LearnState, alive: Alive): void {
    const d = depsRef.current;
    const device = (): string | undefined => deviceId ?? undefined;
    switch (e.kind) {
      case 'mute':
        // Flag before the mute and cleared after the unmute, so a crash in
        // between leaves the next launch muted rather than audible.
        if (e.on) { writeLearnMuteFlag(true); d.setLearnMuted(true); }
        else { d.setLearnMuted(false); writeLearnMuteFlag(false); }
        return;
      case 'keep-awake':
        void window.api.learner.setKeepAwake(e.on).catch(() => undefined);
        return;
      case 'measure':
        d.measureGateRef.current.mode = e.mode;
        publishMeasuring(e.trackId);
        return;
      case 'reset-onset':
        d.onsetTapRef.current?.reset();
        return;
      case 'reset-loudness':
        d.loudnessTapRef.current?.reset();
        return;
      case 'snapshot-loudness':
        d.learnLufsRef.current = d.loudnessTapRef.current?.meter.integratedLufs() ?? null;
        return;
      case 'play':
        // Any failure but signed-out falls through to the confirm poll,
        // which times out into the machine's retry.
        mutate(alive, () => play([e.uri], undefined, undefined, device(), e.positionMs)).catch((err) => failed(err, alive));
        return;
      case 'seek':
        mutate(alive, () => seek(e.positionMs, device())).catch((err) => failed(err, alive));
        return;
      case 'pause-spotify':
        void mutate(alive, () => pause(device()))
          .catch((err) => failed(err, alive))
          .then(() => confirmPaused(alive, Date.now() + PAUSE_CONFIRM_TIMEOUT_MS));
        return;
      case 'await-confirm':
        // After the play or seek has answered, or the first poll reads the
        // player as it was before the command.
        void mutations.then(() => {
          if (!alive()) return;
          later(alive, CONFIRM_TIMEOUT_MS, () => dispatch({ kind: 'confirm-timeout' }));
          void confirmPoll(e, alive);
        });
        return;
      case 'wait': {
        let ms = e.ms;
        if (e.then === 'section-elapsed' && state.kind === 'running' && confirmedAt) {
          const item = state.queue[state.index];
          const w = item.windows[state.section];
          if (w.startMs + w.listenMs >= item.durationMs) {
            const heardToMs = confirmedAt.progressMs + (Date.now() - confirmedAt.atMs);
            ms = Math.max(0, Math.min(ms, item.durationMs - TRACK_END_MARGIN_MS - heardToMs));
          }
        }
        later(alive, ms, () => dispatch({ kind: e.then }));
        return;
      }
      case 'mark-learned': {
        if (d.markLearned(e.trackId, LEARN_VERSION)) return;
        // No record behind it: the enhancer refused the commit (under 20 s of
        // the middle heard, AI Enhance or Remember tracks switched off). A
        // marker would make every later plan skip a song never learned.
        if (state.kind !== 'running' && state.kind !== 'ending') return;
        const name = prev.kind === 'running' ? prev.queue[prev.index].name : e.trackId;
        const t = state.tally;
        state = {
          ...state,
          tally: { ...t, learned: t.learned - 1, failed: [...t.failed, { id: e.trackId, name, reason: 'nothing was measured' }] },
        };
        return;
      }
    }
  }

  async function confirmPoll(e: Extract<LearnEffect, { kind: 'await-confirm' }>, alive: Alive): Promise<void> {
    try {
      const p = await rateLimited(getPlaybackState, alive);
      if (!alive()) return;
      const snap = {
        itemId: p?.item?.id ?? null,
        linkedFromId: p?.item?.linked_from?.id ?? null,
        isPlaying: p?.is_playing === true,
        progressMs: p?.progress_ms ?? 0,
      };
      if (p && playerMatches(snap, e.trackId, e.fromMs, e.toMs)) {
        if (deviceId === undefined) deviceId = p.device?.id ?? null;
        confirmedAt = { progressMs: snap.progressMs, atMs: Date.now() };
        dispatch({ kind: 'confirmed' });
        return;
      }
    } catch (err) {
      if (!alive()) return;
      if (isSignedOut(err)) { dispatch({ kind: 'signed-out' }); return; }
    }
    later(alive, CONFIRM_POLL_MS, () => void confirmPoll(e, alive));
  }

  async function confirmPaused(alive: Alive, deadline: number): Promise<void> {
    if (!alive()) return;
    try {
      const p = await rateLimited(getPlaybackState, alive);
      if (!alive()) return;
      // No session at all (a 204) is nothing playing, as much as a pause is.
      if (!p || !p.is_playing) {
        pauseLanded = true;
        dispatch({ kind: 'spotify-paused' });
        return;
      }
    } catch (err) {
      if (!alive()) return;
      if (isSignedOut(err)) { dispatch({ kind: 'signed-out' }); return; }
    }
    if (Date.now() >= deadline) { dispatch({ kind: 'pause-failed' }); return; }
    later(alive, CONFIRM_POLL_MS, () => void confirmPaused(alive, deadline));
  }

  // ── Watchers ──────────────────────────────────────────────────────────

  function watch(alive: Alive): void {
    if (state.kind === 'running' && state.step === 'listening') {
      later(alive, TAKEOVER_POLL_MS, () => void pollPlayer(alive));
      later(alive, SILENCE_CHECK_MS, () => checkSilence(alive));
    } else if (state.kind === 'paused') {
      // A takeover while paused for something else must be seen, or a later
      // input give-up or Stop pauses what is now someone's own playback.
      if (state.reason === 'input-lost' || state.reason === 'silence') {
        later(alive, TAKEOVER_POLL_MS, () => void pollPlayer(alive));
      }
      later(alive, PAUSED_TICK_MS, () => tick(alive));
    }
  }

  function tick(alive: Alive): void {
    dispatch({ kind: 'tick', now: Date.now() });
    if (alive()) later(alive, PAUSED_TICK_MS, () => tick(alive));
  }

  function verdict(p: SpotifyPlaybackState | null): 'takeover' | 'device-lost' | null {
    const s = state;
    if (s.kind !== 'running' && s.kind !== 'paused') return null;
    if (!p) return 'device-lost';
    const elsewhere =
      !itemIs(p, s.queue[s.index].id) || (deviceId !== undefined && (p.device?.id ?? null) !== deviceId);
    if (s.kind === 'paused' && s.reason === 'silence') {
      // We paused it. Until Spotify has shown it stopped, playing is our own
      // song winding down, or a pause that never took; calling that a
      // takeover would let Stop unmute straight into it.
      if (!pauseLanded) {
        if (!p.is_playing) pauseLanded = true;
        return null;
      }
      return p.is_playing || elsewhere ? 'takeover' : null;
    }
    return elsewhere || !p.is_playing ? 'takeover' : null;
  }

  async function pollPlayer(alive: Alive): Promise<void> {
    try {
      const p = await rateLimited(getPlaybackState, alive);
      if (!alive()) return;
      const v = verdict(p);
      if (v) { dispatch({ kind: v }); return; }
    } catch (err) {
      if (!alive()) return;
      if (isSignedOut(err)) { dispatch({ kind: 'signed-out' }); return; }
    }
    later(alive, TAKEOVER_POLL_MS, () => void pollPlayer(alive));
  }

  function checkSilence(alive: Alive): void {
    // No tap (no AudioWorklet) has nothing to read; it never reads as silence.
    const tap = depsRef.current.loudnessTapRef.current;
    const lufs = tap ? tap.meter.shortTermLufs() : 0;
    const now = Date.now();
    if (lufs < SILENCE_LUFS) {
      silentSince ??= now;
      if (now - silentSince >= SILENCE_MS) { dispatch({ kind: 'silence' }); return; }
    } else {
      silentSince = null;
    }
    later(alive, SILENCE_CHECK_MS, () => checkSilence(alive));
  }

  /** The last song's commit lands on the enhancer's next tick after the
   *  measuring id changes. Clearing the run's loudness, or switching Remember
   *  tracks back off, before then would commit it with the meter's figure or
   *  not at all. */
  function finish(alive: Alive): void {
    later(alive, COMMIT_SETTLE_MS, () => {
      const d = depsRef.current;
      d.learnLufsRef.current = undefined;
      d.measureGateRef.current.mode = 'all';
      if (restore) {
        d.setAiEnhance(restore.aiEnhance);
        d.setRememberTracks(restore.rememberTracks);
        restore = null;
      }
    });
  }

  return {
    dispatch,
    getState: (): LearnState => state,
    start(plan: LearnPlan, fixSettings: boolean): void {
      if (state.kind !== 'idle' && state.kind !== 'done') return;
      const d = depsRef.current;
      restore = fixSettings ? { aiEnhance: d.aiEnhance, rememberTracks: d.rememberTracks } : null;
      if (fixSettings) {
        d.setAiEnhance(true);
        d.setRememberTracks(true);
      }
      deviceId = undefined;
      confirmedAt = null;
      state = { kind: 'idle' }; // `done` ignores `start`
      dispatch({ kind: 'start', plan });
    },
    resume: (): void => dispatch({ kind: 'resume' }),
    stop: (): void => dispatch({ kind: 'stop' }),
    /** The window is going away. Main drops the hold itself when the renderer
     *  dies; the mute flag stays set so the next launch comes back muted. */
    dispose(): void {
      const active = state.kind === 'running' || state.kind === 'paused' || state.kind === 'ending';
      cancelAll();
      if (active) void window.api.learner.setKeepAwake(false).catch(() => undefined);
    },
  };
}

// ── Hook ─────────────────────────────────────────────────────────────────

export function useOvernightLearner(deps: LearnerDeps): OvernightLearner {
  const depsRef = useRef(deps);
  depsRef.current = deps;
  const [state, setState] = useState<LearnState>({ kind: 'idle' });
  const [measuringId, setMeasuringId] = useState<string | null>(null);
  const runnerRef = useRef<ReturnType<typeof createRunner> | null>(null);
  if (runnerRef.current === null) runnerRef.current = createRunner(depsRef, setState, setMeasuringId);
  const runner = runnerRef.current;

  useEffect(() => () => runner.dispose(), [runner]);

  // Input loss pauses without touching Spotify, which is still playing into
  // BlackHole; its return restarts the song. Checked on any running step: a
  // section confirmed with no input would listen to nothing.
  const reason = state.kind === 'paused' ? state.reason : null;
  useEffect(() => {
    const s = runner.getState();
    if (s.kind === 'running' && !deps.inputLive) runner.dispatch({ kind: 'input-lost', now: Date.now() });
    else if (s.kind === 'paused' && s.reason === 'input-lost' && deps.inputLive) runner.dispatch({ kind: 'input-back' });
  }, [state.kind, reason, deps.inputLive, runner]);

  const preflight = useCallback(async (): Promise<PreflightItem[]> => {
    const d = depsRef.current;
    const failing: PreflightItem[] = [];
    if (!d.live) failing.push('live');
    if (!d.aiEnhance) failing.push('ai-enhance');
    if (!d.rememberTracks) failing.push('remember-tracks');
    try {
      const devices = await rateLimited(getDevices, () => true);
      // Only the desktop client plays into BlackHole. A phone or speaker as
      // the active device would play the whole run out loud.
      const ok = devices.some((x) => x.is_active && !!x.id && !x.is_restricted && x.type === 'Computer');
      if (!ok) failing.push('spotify-device');
    } catch {
      failing.push('spotify-device');
    }
    return failing;
  }, []);

  const plan = useCallback(async (playlistIds: string[]): Promise<LearnPlan> => {
    const candidates: LearnCandidate[] = [];
    for (const playlistId of playlistIds) {
      for (let offset = 0; ; offset += PLAYLIST_PAGE) {
        const page = await rateLimited(() => getPlaylistTracks(playlistId, PLAYLIST_PAGE, offset), () => true);
        const items = page.items ?? [];
        for (const entry of items) {
          const t = entryTrack(entry);
          if (!t) continue; // unavailable entry: nothing to play or to name
          candidates.push({
            id: t.id ?? '',
            uri: t.uri ?? '',
            name: t.name,
            artists: (t.artists ?? []).map((a) => a.name).join(', '),
            durationMs: t.duration_ms,
            isLocal: entry.is_local,
          });
        }
        if (items.length < PLAYLIST_PAGE || offset + PLAYLIST_PAGE >= (page.total ?? 0)) break;
      }
    }
    return planRun(candidates, (id) => depsRef.current.recall(id));
  }, []);

  const active = state.kind === 'running' || state.kind === 'paused' || state.kind === 'ending';
  const measuring = useMemo(() => (active ? { trackId: measuringId } : null), [active, measuringId]);
  const current = useMemo(() => {
    if (state.kind !== 'running' && state.kind !== 'paused') return null;
    const item = state.queue[state.index];
    // A paused run restarts its song from the first slice.
    const section = state.kind === 'running' ? state.section : 0;
    return {
      name: item.name,
      artists: item.artists,
      section: item.windows[section].name,
      index: state.index,
      total: state.queue.length,
      etaMs: estimateRunMs(state.queue.length - state.index),
    };
  }, [state]);

  return useMemo(
    () => ({ state, measuring, current, preflight, plan, start: runner.start, resume: runner.resume, stop: runner.stop }),
    [state, measuring, current, preflight, plan, runner],
  );
}

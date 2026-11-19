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
  earliestEndAtMs,
  learnStep,
  pauseConfirmVerdict,
  playerMatches,
  takeoverVerdict,
  type LearnEffect,
  type LearnEvent,
  type LearnState,
  type PlayerRead,
  type TakeoverWatch,
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
/** `request()` has no timeout, so a hung fetch would leave a run starting or
 *  ending forever, with the Mac held awake. These fire from the moment the
 *  effect runs, whether or not the call ever answers, and allow for every
 *  rate-limit retry. */
const CONFIRM_BACKSTOP_MS = CONFIRM_TIMEOUT_MS + RATE_LIMIT_RETRIES * RATE_LIMIT_WAIT_MS;
const PAUSE_BACKSTOP_MS = PAUSE_CONFIRM_TIMEOUT_MS + RATE_LIMIT_RETRIES * RATE_LIMIT_WAIT_MS;
/** A slice that runs to the track's end stops this far short of the earliest
 *  moment the song can end. Past the end Spotify moves on to the playlist's
 *  next track, and measured, that is the next song folded into this one. The
 *  next song's play should land before then too (the commit's settle plus its
 *  round trip), so the playlist's next track never starts; if it does, the
 *  polls let it pass. With 1 s, timed from `progress_ms`, a real run ran past
 *  the end. */
const TRACK_END_MARGIN_MS = 2_000;
/** A song's numbers reach track memory on the enhancer's tick after the
 *  measuring id changes, and a real run saw that land after
 *  `COMMIT_SETTLE_MS`: one look found no new record and failed "nothing was
 *  measured" on a song whose record the run had written. The marker looks
 *  again this often, for up to this long. */
const MARK_RECHECK_MS = 250;
const MARK_GIVE_UP_MS = 3_000;
const PLAYLIST_PAGE = 100;
/** The sheet re-plans on every selection change. Without this each change
 *  rescans every page of every ticked playlist. */
const PLAYLIST_CACHE_MS = 600_000;

// ── Types ────────────────────────────────────────────────────────────────

export interface LearnerDeps {
  markLearned(trackId: string, version: number): boolean;
  /** Stored profile regardless of the Remember tracks switch (planning only). */
  peek(trackId: string | null): TrackProfile | null;
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
export type PreflightItem = 'live' | 'ai-enhance' | 'remember-tracks' | 'spotify-device' | 'signal';
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

/** Whether `deviceId` is playing and its sound is reaching the measure tap
 *  right now. A failed read proves nothing, so it is not heard. */
async function hearsDevice(deviceId: string, tapRef: { current: LoudnessTap | null }): Promise<boolean> {
  let p: SpotifyPlaybackState | null;
  try {
    p = await rateLimited(getPlaybackState, () => true);
  } catch {
    return false;
  }
  const lufs = tapRef.current?.meter.shortTermLufs();
  return p?.device?.id === deviceId && p.is_playing === true && lufs !== undefined && lufs > SILENCE_LUFS;
}

function toRead(p: SpotifyPlaybackState | null): PlayerRead | null {
  if (!p) return null;
  return {
    itemId: p.item?.id ?? null,
    linkedFromId: p.item?.linked_from?.id ?? null,
    itemName: p.item?.name ?? null,
    itemDurationMs: p.item?.duration_ms ?? null,
    isPlaying: p.is_playing === true,
    progressMs: p.progress_ms ?? 0,
    deviceId: p.device?.id ?? null,
  };
}

// ── Runner ───────────────────────────────────────────────────────────────

function createRunner(
  depsRef: { current: LearnerDeps },
  publish: (s: LearnState) => void,
  publishMeasuring: (trackId: string | null) => void,
) {
  let state: LearnState = { kind: 'idle' };
  let step = 0;
  /** Bumped by every Start. A song's marker outlives the steps of its run,
   *  and without this a late failure would land on the next run's tally. */
  let runId = 0;
  /** Marks still waiting on their record. `finish` holds its cleanup until
   *  this is zero. */
  let pendingMarks = 0;
  const timers = new Set<number>();
  /** Spotify mutations, one at a time. A pause sent while a play is still in
   *  flight can land first, and the play then starts music after the poll
   *  has already seen `is_playing: false` and unmuted. */
  let mutations: Promise<unknown> = Promise.resolve();
  /** The Computer device the last preflight found, and the one this run
   *  plays on. Every play, seek and pause names it: left to Spotify's active
   *  device, a run could start or carry on on a speaker, out loud. */
  let preflightDevice: string | null = null;
  let deviceId: string | null = null;
  /** When the current section's play or seek last went out, null until it
   *  has. */
  let sentAtMs: number | null = null;
  /** `earliestEndAtMs` of the song the run last confirmed; null before that,
   *  and once the run stops running for anything but a lost input. Those
   *  pauses stop Spotify, or hand it to someone else, and restart with a play
   *  of our own; a lost input leaves the song playing on into the playlist. */
  let endsAtMs: number | null = null;
  /** The confirmed song's length, the shorter of the playlist's and the
   *  player's. */
  let lengthMs = 0;
  /** The id the player reported when this song was last confirmed, null
   *  until it is. A relinked song plays under an id the playlist never names,
   *  so every later check on this song compares against this; track memory
   *  stays keyed by the playlist's id, which is what the DJ recalls by. */
  let playedId: string | null = null;
  /** When this song's attempt began. A record older than that was written by
   *  an earlier play, so it says nothing about whether this run measured it. */
  let songStartedAtMs = 0;
  let nullSinceMs: number | null = null;
  /** The first of the current run of not-playing reads on our device. */
  let notPlayingSinceMs: number | null = null;
  /** The song the run last confirmed, under the id the player reported, and
   *  what the player last reported. A confirm poll reading either is the
   *  player lagging our command, not someone else's music. */
  let lastConfirmedId: string | null = null;
  let lastSeen: { itemId: string | null; deviceId: string | null } | null = null;
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
    nullSinceMs = null;
    notPlayingSinceMs = null;
    if (next.kind !== 'running' && !(next.kind === 'paused' && next.reason === 'input-lost')) endsAtMs = null;
    // A commit's `mark-learned` belongs to the song before, and runs after the
    // next song's start is taken just below. Read against that, a record
    // written on time looked older than its song, so every song but a run's
    // last would have failed "nothing was measured".
    const prevSongStartedAtMs = songStartedAtMs;
    if (next.kind === 'running' && next.step === 'starting' && next.section === 0 && next.attempt === 0) {
      songStartedAtMs = Date.now();
      // A new song, or this one restarted from its intro: an id confirmed
      // before belongs to another song or to a play that is over.
      playedId = null;
    }
    const alive = aliveFor(step);
    for (const e of effects) run(e, prev, alive, prevSongStartedAtMs);
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

  function run(e: LearnEffect, prev: LearnState, alive: Alive, prevSongStartedAtMs: number): void {
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
        // Until this middle is snapshotted the ref held the previous song's
        // figure, and a run interrupted after 20 s of it committed this song
        // with that one. Null commits no loudness rather than the wrong one.
        d.learnLufsRef.current = null;
        return;
      case 'snapshot-loudness':
        d.learnLufsRef.current = d.loudnessTapRef.current?.meter.integratedLufs() ?? null;
        return;
      case 'play':
        // Any failure but signed-out falls through to the confirm poll,
        // which times out into the machine's retry. Inside the song's
        // playlist, with the song as the offset: a bare uri got a 204 while
        // the desktop client restarted the track it was already on.
        sentAtMs = null;
        mutate(alive, () => {
          sentAtMs = Date.now();
          return e.contextUri
            ? play(undefined, e.contextUri, e.uri, device(), e.positionMs)
            : play([e.uri], undefined, undefined, device(), e.positionMs);
        }).catch((err) => failed(err, alive));
        return;
      case 'seek':
        sentAtMs = null;
        mutate(alive, () => {
          sentAtMs = Date.now();
          // A seek only follows a confirmed slice of the same song, and moves
          // its end closer. Paused for a lost input before this confirms, the
          // older end read the playlist moving on as a takeover.
          if (endsAtMs !== null) {
            endsAtMs = Math.min(endsAtMs, earliestEndAtMs({
              nowMs: sentAtMs, sentAtMs, startMs: e.positionMs, progressMs: 0, durationMs: lengthMs, playerDurationMs: null,
            }));
          }
          return seek(e.positionMs, device());
        }).catch((err) => failed(err, alive));
        return;
      case 'pause-spotify': {
        const deadline = Date.now() + PAUSE_BACKSTOP_MS;
        later(alive, PAUSE_BACKSTOP_MS, () => dispatch({ kind: 'pause-failed' }));
        void mutate(alive, () => pause(device()))
          .catch((err) => failed(err, alive))
          .then(() => confirmPaused(alive, deadline));
        return;
      }
      case 'await-confirm':
        later(alive, CONFIRM_BACKSTOP_MS, () => dispatch({ kind: 'confirm-timeout' }));
        // After the play or seek has answered, or the first poll reads the
        // player as it was before the command.
        void mutations.then(() => {
          if (!alive()) return;
          later(alive, CONFIRM_TIMEOUT_MS, () => dispatch({ kind: 'confirm-timeout' }));
          void confirmPoll(e, lastSeen, alive);
        });
        return;
      case 'wait': {
        let ms = e.ms;
        // A no-op for any slice that ends well inside its song.
        if (e.then === 'section-elapsed' && endsAtMs !== null) {
          ms = Math.max(0, Math.min(ms, endsAtMs - TRACK_END_MARGIN_MS - Date.now()));
        }
        later(alive, ms, () => dispatch({ kind: e.then }));
        return;
      }
      case 'mark-learned':
        markWhenStored(e.trackId, prev.kind === 'running' ? prev.queue[prev.index].name : e.trackId, prevSongStartedAtMs);
        return;
    }
  }

  /** Marks a song learned once track memory holds a record written since
   *  `sinceMs`, its attempt's start. Not tied to a step, because the run has
   *  usually moved on by the time the record lands, and it never dispatches.
   *
   *  Only a record written during this attempt. The enhancer may have refused
   *  the commit (under 20 s of the middle heard, AI Enhance or Remember tracks
   *  switched off), and a record from an earlier play would still let
   *  markLearned succeed. A marker would make every later plan skip a song
   *  this run never measured. */
  function markWhenStored(trackId: string, name: string, sinceMs: number): void {
    const forRun = runId;
    const giveUpAtMs = Date.now() + MARK_GIVE_UP_MS;
    pendingMarks++;
    const look = (): void => {
      const d = depsRef.current;
      const stored = d.peek(trackId);
      if (stored && stored.updated >= sinceMs && d.markLearned(trackId, LEARN_VERSION)) {
        pendingMarks--;
        return;
      }
      if (Date.now() < giveUpAtMs) {
        window.setTimeout(look, MARK_RECHECK_MS);
        return;
      }
      pendingMarks--;
      // The machine counted the song learned when it committed. This undoes
      // that once, on the tally of the run that played it.
      if (forRun !== runId || state.kind === 'idle') return;
      const t = state.tally;
      state = {
        ...state,
        tally: { ...t, learned: t.learned - 1, failed: [...t.failed, { id: trackId, name, reason: 'nothing was measured' }] },
      };
      publish(state);
    };
    look();
  }

  function saw(p: SpotifyPlaybackState | null): void {
    if (p) lastSeen = { itemId: p.item?.id ?? null, deviceId: p.device?.id ?? null };
  }

  /** Feeds a read to the takeover rule, keeping its 204 count. */
  function takeoverFrom(watch: TakeoverWatch, read: PlayerRead | null): 'takeover' | 'device-lost' | null {
    const t = takeoverVerdict(watch, read, deviceId, Date.now(), nullSinceMs);
    nullSinceMs = t.nullSinceMs;
    return t.verdict;
  }

  /** Feeds a read to the pause rule, keeping its not-playing count. */
  function pausedFrom(read: PlayerRead | null): boolean {
    const v = pauseConfirmVerdict(read, deviceId, Date.now(), notPlayingSinceMs);
    notPlayingSinceMs = v.notPlayingSinceMs;
    return v.verdict === 'paused';
  }

  async function confirmPoll(
    e: Extract<LearnEffect, { kind: 'await-confirm' }>,
    before: typeof lastSeen,
    alive: Alive,
  ): Promise<void> {
    try {
      const p = await rateLimited(getPlaybackState, alive);
      if (!alive()) return;
      saw(p);
      const read = toRead(p);
      if (read && playerMatches(read, e.track, e.fromMs, e.toMs)) {
        const now = Date.now();
        playedId = read.itemId ?? e.track.id;
        lastConfirmedId = playedId;
        lengthMs = Math.min(e.track.durationMs, read.itemDurationMs ?? e.track.durationMs);
        endsAtMs = earliestEndAtMs({
          nowMs: now,
          sentAtMs,
          startMs: e.fromMs,
          progressMs: read.progressMs,
          durationMs: e.track.durationMs,
          playerDurationMs: read.itemDurationMs,
        });
        dispatch({ kind: 'confirmed' });
        return;
      }
      // Someone else's playback, or a client that has gone away, pauses the
      // run, rather than fighting them for the device or failing every song
      // left as "did not start playback".
      const v = takeoverFrom({ kind: 'confirming', track: e.track, lastConfirmedId, before, endsAtMs }, read);
      if (v) { dispatch({ kind: v }); return; }
    } catch (err) {
      if (!alive()) return;
      if (isSignedOut(err)) { dispatch({ kind: 'signed-out' }); return; }
    }
    later(alive, CONFIRM_POLL_MS, () => void confirmPoll(e, before, alive));
  }

  async function confirmPaused(alive: Alive, deadline: number): Promise<void> {
    if (!alive()) return;
    try {
      const p = await rateLimited(getPlaybackState, alive);
      if (!alive()) return;
      saw(p);
      // A 204 is never paused: the backstop ends the run muted instead.
      if (pausedFrom(toRead(p))) {
        pauseLanded = true;
        dispatch({ kind: 'spotify-paused' });
        return;
      }
    } catch (err) {
      if (!alive()) return;
      if (isSignedOut(err)) { dispatch({ kind: 'signed-out' }); return; }
    }
    // The backstop timer dispatches pause-failed; this only stops polling.
    if (Date.now() >= deadline) return;
    later(alive, CONFIRM_POLL_MS, () => void confirmPaused(alive, deadline));
  }

  // ── Watchers ──────────────────────────────────────────────────────────

  function watch(alive: Alive): void {
    if (state.kind === 'running' && state.step === 'listening') {
      later(alive, TAKEOVER_POLL_MS, () => void pollPlayer(alive));
      // Only on an 'all' slice (the middle, or a whole short song). An intro
      // can open on lead-in silence and an outro can be an album's silent
      // tail; 8 s of either would park the whole night on one song.
      if (state.queue[state.index].windows[state.section].mode === 'all') {
        later(alive, SILENCE_CHECK_MS, () => checkSilence(alive));
      }
    } else if (state.kind === 'paused') {
      // A takeover while paused for something else must be seen, or a later
      // input give-up or Stop pauses what is now someone's own playback. The
      // same poll sends a silence pause again until it is seen to land.
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

  function watchFor(s: LearnState): TakeoverWatch | null {
    if (s.kind !== 'running' && s.kind !== 'paused') return null;
    const item = s.queue[s.index];
    const track = { id: item.id, name: item.name, durationMs: item.durationMs };
    if (s.kind === 'running') return s.step === 'listening' ? { kind: 'listening', track, playedId, endsAtMs } : null;
    if (s.reason === 'silence') return { kind: 'paused-silence', track, playedId, pauseLanded };
    if (s.reason === 'input-lost') {
      return { kind: 'paused-input-lost', track, playedId, endsAtMs: playedId !== null && lastConfirmedId === playedId ? endsAtMs : null };
    }
    return null;
  }

  async function pollPlayer(alive: Alive): Promise<void> {
    try {
      const p = await rateLimited(getPlaybackState, alive);
      if (!alive()) return;
      saw(p);
      const read = toRead(p);
      if (state.kind === 'paused' && state.reason === 'silence' && !pauseLanded) {
        if (pausedFrom(read)) pauseLanded = true;
        // Silence fired because the sound may be going to a speaker. A pause
        // that failed was never sent again, and the run sat paused with
        // Spotify still playing out of it. No events: the machine has
        // already paused the run, and this only makes it true.
        else mutate(alive, () => pause(deviceId ?? undefined)).catch((err) => failed(err, alive));
      }
      const watch = watchFor(state);
      const v = watch ? takeoverFrom(watch, read) : null;
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
   *  not at all. That tick can land after `done`, so this also waits for
   *  every mark still waiting on its record, for no longer than a mark
   *  waits. Otherwise the cleanup either refuses the last song's commit, and
   *  its mark fails it "nothing was measured", or lets it commit the meter's
   *  loudness in place of the run's.
   *
   *  A Start during the wait cancels it with the rest of this step's timers.
   *  The new run sets the measure gate with its first effect and clears the
   *  run's loudness before any slice that can commit, and it takes over
   *  `restore` (see start), so nothing of this cleanup is lost. */
  function finish(alive: Alive): void {
    const giveUpAtMs = Date.now() + MARK_GIVE_UP_MS;
    const cleanUp = (): void => {
      if (pendingMarks > 0 && Date.now() < giveUpAtMs) {
        later(alive, MARK_RECHECK_MS, cleanUp);
        return;
      }
      const d = depsRef.current;
      d.learnLufsRef.current = undefined;
      d.measureGateRef.current.mode = 'all';
      if (restore) {
        d.setAiEnhance(restore.aiEnhance);
        d.setRememberTracks(restore.rememberTracks);
        restore = null;
      }
    };
    later(alive, COMMIT_SETTLE_MS, cleanUp);
  }

  return {
    dispatch,
    getState: (): LearnState => state,
    /** Records the device a preflight found, or null when it found none. */
    offerDevice(id: string | null): void {
      preflightDevice = id;
    },
    /** A no-op unless the last preflight found a Computer device: with none
     *  to name, the run's calls would go to whatever device is active. */
    start(plan: LearnPlan, fixSettings: boolean): void {
      if (state.kind !== 'idle' && state.kind !== 'done') return;
      if (!preflightDevice) return;
      const d = depsRef.current;
      // A restore still set is the last run's, whose cleanup this Start
      // cancels: the settings now on may be the ones that run forced on, so
      // reading them would lose the user's own for good.
      restore ??= fixSettings ? { aiEnhance: d.aiEnhance, rememberTracks: d.rememberTracks } : null;
      if (fixSettings) {
        d.setAiEnhance(true);
        d.setRememberTracks(true);
      }
      deviceId = preflightDevice;
      runId++;
      lastConfirmedId = null;
      lastSeen = null;
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
      const found = devices.find((x) => x.is_active && !!x.id && !x.is_restricted && x.type === 'Computer');
      // An active Computer can be another computer, and the run would pin
      // every play to it. Intros are never silence-checked, so each song's
      // first 15 s, and 8 s of its middle, would play out loud in another
      // room. Only sound from that device reaching this Mac's capture proves
      // it is this Mac's Spotify. Offered to start() only then, so a run
      // cannot start on a device nobody has heard.
      const id = found?.id ?? null;
      const heard = id !== null && (await hearsDevice(id, d.loudnessTapRef));
      runner.offerDevice(heard ? id : null);
      if (!found) failing.push('spotify-device');
      else if (!heard) failing.push('signal');
    } catch {
      runner.offerDevice(null);
      failing.push('spotify-device');
    }
    return failing;
  }, [runner]);

  const scannedRef = useRef(new Map<string, { atMs: number; candidates: LearnCandidate[] }>());
  const plan = useCallback(async (playlistIds: string[]): Promise<LearnPlan> => {
    const candidates: LearnCandidate[] = [];
    for (const playlistId of playlistIds) {
      const cached = scannedRef.current.get(playlistId);
      if (cached && Date.now() - cached.atMs < PLAYLIST_CACHE_MS) {
        candidates.push(...cached.candidates);
        continue;
      }
      const scanned: LearnCandidate[] = [];
      for (let offset = 0; ; offset += PLAYLIST_PAGE) {
        const page = await rateLimited(() => getPlaylistTracks(playlistId, PLAYLIST_PAGE, offset), () => true);
        const items = page.items ?? [];
        for (const entry of items) {
          const t = entryTrack(entry);
          if (!t) continue; // unavailable entry: nothing to play or to name
          scanned.push({
            id: t.id ?? '',
            uri: t.uri ?? '',
            name: t.name,
            artists: (t.artists ?? []).map((a) => a.name).join(', '),
            durationMs: t.duration_ms,
            isLocal: entry.is_local,
            // Playlists are scanned in selection order and the plan keeps a
            // song's first copy, so this is the first selected playlist the
            // song was found in.
            contextUri: `spotify:playlist:${playlistId}`,
          });
        }
        if (items.length < PLAYLIST_PAGE || offset + PLAYLIST_PAGE >= (page.total ?? 0)) break;
      }
      scannedRef.current.set(playlistId, { atMs: Date.now(), candidates: scanned });
      candidates.push(...scanned);
    }
    return planRun(candidates, (id) => depsRef.current.peek(id));
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

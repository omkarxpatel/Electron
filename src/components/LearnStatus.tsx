import type { OvernightLearner } from '../dj/useOvernightLearner';
import { canResume, type PauseReason, type EndReason, type LearnTally } from '../dj/learnMachine';

// ── Copy ─────────────────────────────────────────────────────────────────

const PAUSE_COPY: Record<PauseReason, string> = {
  'input-lost': 'The audio input was lost. Learning carries on by itself when it comes back.',
  silence: 'The app heard silence, so it paused Spotify in case the sound was going to a speaker.',
  takeover:
    'Spotify was used for something else, so learning stepped aside. The app stays muted until you press Stop, or Resume to carry on learning.',
  'device-lost': 'The Spotify app on this Mac went away.',
};

const END_COPY: Record<EndReason, string> = {
  finished: 'Learning finished',
  stopped: 'Learning stopped',
  'signed-out': 'Learning ended: you were signed out of Spotify. The app stays muted until you unmute it.',
  'input-timeout': 'Learning ended: the audio input did not come back',
};

function clock(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

interface Props {
  learner: OvernightLearner;
}

/** Resume only where the machine acts on it: a lost input resumes by itself,
 *  and a button that does nothing there would be a lie. */
function Actions({ learner }: Props) {
  const { state } = learner;
  if (state.kind !== 'running' && state.kind !== 'paused') return null;
  return (
    <div className="learn-status-actions">
      {state.kind === 'paused' && canResume(state.reason) && (
        <button type="button" className="learn-btn" onClick={learner.resume}>
          Resume
        </button>
      )}
      <button type="button" className="learn-btn" onClick={learner.stop}>
        Stop
      </button>
    </div>
  );
}

function Counts({ tally }: { tally: LearnTally }) {
  const { queued, learned, skipped, failed } = tally;
  return (
    <>
      <span className="learn-status-sub">
        {learned} learned · {skipped} skipped · {failed.length} failed
      </span>
      {queued > 0 && (
        <div
          className="dj-coverage-bar"
          style={{ ['--heard' as string]: `${Math.round((learned / queued) * 100)}%` }}
          aria-hidden
        />
      )}
    </>
  );
}

export function LearnStatus({ learner }: Props) {
  const { state, current } = learner;
  if (state.kind === 'idle') return null;

  return (
    <div className="learn-status" data-kind={state.kind}>
      {state.kind === 'paused' && <span className="learn-status-line">{PAUSE_COPY[state.reason]}</span>}
      {state.kind === 'ending' && <span className="learn-status-line">Finishing up</span>}
      {state.kind === 'done' && <span className="learn-status-line">{END_COPY[state.reason]}</span>}
      {state.kind === 'running' && current && (
        <span className="learn-status-line">
          Learning {current.index + 1} of {current.total} · {current.name} – {current.artists} ·{' '}
          {current.section} · done about {clock(Date.now() + current.etaMs)}
        </span>
      )}
      <Counts tally={state.tally} />
      {state.kind === 'done' && state.tally.failed.length > 0 && (
        <ul className="learn-failures">
          {state.tally.failed.map((f) => (
            <li key={f.id}>
              {f.name}: {f.reason}
            </li>
          ))}
        </ul>
      )}
      <Actions learner={learner} />
    </div>
  );
}

/** App-wide, in the same place as LearnMutedBanner. The run's own status
 *  lives in the DJ panel, so without this a run paused for a takeover in the
 *  morning left the whole app silent with nothing on screen saying why. */
export function LearnPausedBanner({ learner }: Props) {
  const { state } = learner;
  if (state.kind !== 'paused') return null;
  return (
    <div className="learn-muted-banner" role="status">
      <span>
        Learning is paused and the app is muted. {PAUSE_COPY[state.reason]}
      </span>
      <Actions learner={learner} />
    </div>
  );
}

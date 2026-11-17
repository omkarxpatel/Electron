import type { OvernightLearner } from '../dj/useOvernightLearner';
import type { PauseReason, EndReason } from '../dj/learnMachine';

// ── Copy ─────────────────────────────────────────────────────────────────

const PAUSE_COPY: Record<PauseReason, string> = {
  'input-lost': 'Lost the audio input. Learning will resume by itself when it comes back.',
  silence: 'Heard silence, so Spotify was paused in case the sound went to a speaker.',
  takeover: 'Paused: playback was taken over.',
  'device-lost': 'Paused: the Spotify app went away.',
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

export function LearnStatus({ learner }: Props) {
  const { state, current } = learner;
  if (state.kind === 'idle') return null;

  if (state.kind === 'done') {
    const { learned, skipped, failed } = state.tally;
    return (
      <div className="learn-status" data-kind="done">
        <span className="learn-status-line">{END_COPY[state.reason]}</span>
        <span className="learn-status-sub">
          {learned} learned · {skipped} skipped · {failed.length} failed
        </span>
        {failed.length > 0 && (
          <ul className="learn-failures">
            {failed.map((f) => (
              <li key={f.id}>
                {f.name}: {f.reason}
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }

  const queueLength = state.kind === 'ending' ? 0 : state.queue.length;
  const { learned } = state.tally;
  const pct = queueLength > 0 ? Math.round((learned / queueLength) * 100) : 0;

  return (
    <div className="learn-status" data-kind={state.kind}>
      {state.kind === 'paused' && <span className="learn-status-line">{PAUSE_COPY[state.reason]}</span>}
      {state.kind === 'ending' && <span className="learn-status-line">Finishing up</span>}
      {state.kind === 'running' && current && (
        <span className="learn-status-line">
          Learning {current.index + 1} of {current.total} · {current.name} – {current.artists} ·{' '}
          {current.section} · done about {clock(Date.now() + current.etaMs)}
        </span>
      )}
      {queueLength > 0 && (
        <div className="dj-coverage-bar" style={{ ['--heard' as string]: `${pct}%` }} aria-hidden />
      )}
      {state.kind !== 'ending' && (
        <div className="learn-status-actions">
          {state.kind === 'paused' && (
            <button type="button" className="learn-btn" onClick={learner.resume}>
              Resume
            </button>
          )}
          <button type="button" className="learn-btn" onClick={learner.stop}>
            Stop
          </button>
        </div>
      )}
    </div>
  );
}

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SpotifyPlaylist } from '../spotify/types';
import { usePlaylistFolders } from '../state/playlistFolders';
import { estimateRunMs, type LearnPlan } from '../dj/learnPlan';
import type { OvernightLearner, PreflightItem } from '../dj/useOvernightLearner';

// ── Constants ────────────────────────────────────────────────────────────

const SELECTION_KEY = 'av.learner.selection.v1';
const PLAN_DEBOUNCE_MS = 500;
/** The two preflight items Start can fix itself. */
const FIXABLE: PreflightItem[] = ['ai-enhance', 'remember-tracks'];

const PREFLIGHT_COPY: Record<PreflightItem, string> = {
  live: 'Turn Live on, so the app can hear Spotify through BlackHole.',
  'ai-enhance': 'AI Enhance is off. It does the measuring.',
  'remember-tracks': 'Remember tracks is off. Without it nothing is kept.',
  'spotify-device': 'Open Spotify on this Mac and start any song, so the run has a Computer device to play on.',
  signal: 'Start any song in Spotify on this Mac, so the app can hear that the sound is coming through it.',
};

function readSelection(): string[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(SELECTION_KEY) ?? '[]');
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function writeSelection(ids: string[]): void {
  try {
    localStorage.setItem(SELECTION_KEY, JSON.stringify(ids));
  } catch {
    // Not remembering the ticks costs a re-tick, nothing more.
  }
}

function duration(ms: number): string {
  const min = Math.max(1, Math.round(ms / 60_000));
  const h = Math.floor(min / 60);
  return h > 0 ? `${h} h ${min % 60} min` : `${min} min`;
}

type PlanView =
  | { kind: 'empty' }
  | { kind: 'planning' }
  | { kind: 'ready'; plan: LearnPlan }
  | { kind: 'error'; message: string };

interface Props {
  learner: OvernightLearner;
  playlists: SpotifyPlaylist[];
  onClose: () => void;
}

export function LearnSheet({ learner, playlists, onClose }: Props) {
  const folders = usePlaylistFolders();
  const [selected, setSelected] = useState<string[]>(() => {
    const known = new Set(playlists.map((p) => p.id));
    return readSelection().filter((id) => known.has(id));
  });
  const [items, setItems] = useState<PreflightItem[]>([]);
  const [fixSettings, setFixSettings] = useState(true);
  const [view, setView] = useState<PlanView>({ kind: 'empty' });
  const [starting, setStarting] = useState(false);
  const planRequest = useRef(0);

  // Folders nest, so a row covers its own playlists plus every descendant's.
  // Expanded iteratively: a hand-edited store could describe a cycle.
  const folderRows = useMemo(() => {
    const out: Array<{ id: string; name: string; ids: string[] }> = [];
    for (const folder of folders.folders) {
      const inside = new Set<string>([folder.id]);
      for (;;) {
        const before = inside.size;
        for (const f of folders.folders) if (f.parentId && inside.has(f.parentId)) inside.add(f.id);
        if (inside.size === before) break;
      }
      const ids = playlists.filter((p) => inside.has(folders.assignments[p.id] ?? '')).map((p) => p.id);
      if (ids.length) out.push({ id: folder.id, name: folder.name, ids });
    }
    return out;
  }, [folders.folders, folders.assignments, playlists]);

  // Only the newest preflight may write: a slow earlier one landing late
  // would put a problem back on screen that the user has already fixed.
  const preflightRequest = useRef(0);
  const [checking, setChecking] = useState(false);
  const refreshPreflight = useCallback(async (): Promise<PreflightItem[]> => {
    const request = ++preflightRequest.current;
    setChecking(true);
    try {
      const found = await learner.preflight();
      if (request === preflightRequest.current) setItems(found);
      return found;
    } finally {
      if (request === preflightRequest.current) setChecking(false);
    }
  }, [learner]);

  // Looked at on open, on coming back to the window, and on "Check again".
  // Without the last two, a user who did what the list asked (started a song
  // in Spotify) faces a Start that stays disabled until they reopen the sheet.
  useEffect(() => {
    void refreshPreflight();
    const onFocus = () => void refreshPreflight();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refreshPreflight]);

  // Persist and re-plan on every change, debounced: each plan rescans pages.
  useEffect(() => {
    writeSelection(selected);
    const request = ++planRequest.current;
    if (selected.length === 0) {
      setView({ kind: 'empty' });
      return;
    }
    setView({ kind: 'planning' });
    const timer = window.setTimeout(() => {
      learner.plan(selected).then(
        (plan) => {
          if (request === planRequest.current) setView({ kind: 'ready', plan });
        },
        (err) => {
          if (request === planRequest.current) setView({ kind: 'error', message: String(err) });
        },
      );
    }, PLAN_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [selected, learner]);

  const toggle = (id: string) =>
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  const toggleMany = (ids: string[]) =>
    setSelected((s) =>
      ids.every((id) => s.includes(id)) ? s.filter((x) => !ids.includes(x)) : [...new Set([...s, ...ids])],
    );

  const blocking = items.filter((i) => !FIXABLE.includes(i));
  const fixable = items.filter((i) => FIXABLE.includes(i));
  const plan = view.kind === 'ready' ? view.plan : null;
  const canStart =
    !!plan && plan.queue.length > 0 && blocking.length === 0 && (fixable.length === 0 || fixSettings) && !starting;

  const start = async () => {
    if (!plan) return;
    setStarting(true);
    // The Spotify device can vanish while the sheet sits open, and start()
    // only works after a preflight that found one.
    const found = await refreshPreflight();
    setStarting(false);
    if (found.some((i) => !FIXABLE.includes(i))) return;
    learner.start(plan, fixSettings);
    onClose();
  };

  return (
    <div className="learn-sheet-backdrop" onClick={onClose}>
      <div className="learn-sheet" role="dialog" aria-label="Learn playlists" onClick={(e) => e.stopPropagation()}>
        <h2 className="learn-sheet-title">Learn playlists</h2>
        <p className="learn-note">
          Plays short slices of each song silently through Spotify so the DJ can rank them. Nothing plays out loud.
        </p>
        <p className="learn-note">
          Turn crossfade off in Spotify first. A crossfade blends the next song into the end of each one, which the run
          listens to.
        </p>
        <p className="learn-note">Each learned song plays on your Spotify account, so it shows up in your listening history.</p>

        <div className="learn-list">
          {folderRows.map((f) => {
            const count = f.ids.filter((id) => selected.includes(id)).length;
            return (
              <label key={`folder-${f.id}`} className="learn-row learn-row-folder">
                <input
                  type="checkbox"
                  checked={count === f.ids.length}
                  ref={(el) => {
                    if (el) el.indeterminate = count > 0 && count < f.ids.length;
                  }}
                  disabled={starting}
                  onChange={() => toggleMany(f.ids)}
                />
                <span>
                  {f.name} ({f.ids.length} playlists)
                </span>
              </label>
            );
          })}
          {playlists.map((p) => (
            <label key={p.id} className="learn-row">
              <input type="checkbox" checked={selected.includes(p.id)} disabled={starting} onChange={() => toggle(p.id)} />
              <span>{p.name}</span>
            </label>
          ))}
        </div>

        <div className="learn-plan" aria-live="polite">
          {view.kind === 'empty' && 'Tick the playlists to learn.'}
          {view.kind === 'planning' && 'Counting songs…'}
          {view.kind === 'error' && `Could not read those playlists: ${view.message}`}
          {plan && (
            <>
              {plan.queue.length} to learn · {plan.skipped.length} already learned or skipped · about{' '}
              {duration(estimateRunMs(plan.queue.length))}
            </>
          )}
        </div>

        {items.length > 0 && (
          <>
            <ul className="learn-preflight">
              {[...blocking, ...fixable].map((i) => (
                <li key={i}>{PREFLIGHT_COPY[i]}</li>
              ))}
            </ul>
            <div className="learn-sheet-actions">
              <button type="button" className="learn-btn" disabled={checking} onClick={() => void refreshPreflight()}>
                {checking ? 'Checking…' : 'Check again'}
              </button>
            </div>
          </>
        )}
        {fixable.length > 0 && (
          <label className="learn-row">
            <input
              type="checkbox"
              checked={fixSettings}
              disabled={starting}
              onChange={(e) => setFixSettings(e.target.checked)}
            />
            <span>Turn on AI Enhance and Remember tracks for this run</span>
          </label>
        )}

        <div className="learn-sheet-actions">
          <button type="button" className="learn-btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="learn-btn learn-btn-primary" disabled={!canStart} onClick={() => void start()}>
            Start
          </button>
        </div>
      </div>
    </div>
  );
}

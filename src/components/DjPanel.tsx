import { useCallback, useMemo, useState } from 'react';
import { addToQueue } from '../spotify/api';
import type { SpotifyPlaylist, SpotifyTrack } from '../spotify/types';
import { usePlaylistFolders } from '../state/playlistFolders';
import type { TrackProfile } from '../audio/trackProfile';
import type { HarmonicRelation, MixCandidate } from '../audio/mixCompatibility';
import { camelotFor, keyLabel } from '../audio/musicalKey';
import { describeTransition } from '../dj/commentary';
import { describeIntent } from '../dj/intent';
import { useDjSuggestions, hitScanCap, type DjSource } from '../dj/useDjSuggestions';
import { useDjVoice } from '../dj/useDjVoice';
import { smallestImage } from '../shared/image';
import { useTrackMenu } from '../spotify/useTrackMenu';
import type { OvernightLearner } from '../dj/useOvernightLearner';
import { LearnSheet } from './LearnSheet';
import { LearnStatus } from './LearnStatus';

/** How many suggestions are worth looking at. Past a handful this stops being
 *  a recommendation and starts being the playlist again, in a new order. */
const SHOWN = 6;

/** Live key and tempo of the playing track, measured right now by the
 *  enhancer. Better than the stored profile for the track we are mixing OUT
 *  of, because it is this play rather than an average of previous ones — and
 *  it exists on the very first play, which the stored profile does not. */
export interface LiveMeasurement {
  key: number | null;
  keyConfidence: number;
  bpm: number | null;
  bpmConfidence: number;
}

interface Props {
  onBack: () => void;
  playlists: SpotifyPlaylist[];
  currentlyPlayingId: string | null;
  currentTrack: SpotifyTrack | null;
  /** Null when AI Enhance is off, in which case only the stored profile is
   *  available for the playing track. */
  live: LiveMeasurement | null;
  recall: (trackId: string | null) => TrackProfile | null;
  onPlay: (track: SpotifyTrack) => void;
  /** Whether the app is the thing making the sound. Commentary degrades to
   *  text when the user is listening to Spotify directly — there is nothing
   *  to duck and nowhere to put the voice. */
  audible: boolean;
  duckGainRef: { current: GainNode | null };
  voiceGainRef: { current: GainNode | null };
  learner: OvernightLearner;
}

/**
 * How a relation reads, and how far round the wheel it is.
 *
 * `rungs` drives the ladder down the left of each row: four rungs for keys
 * that sit on top of each other, one for a clash, none when nothing was
 * measured. It is the same judgement as the ordering, shown per row — a list
 * that is merely sorted says a track is better than the one below it, never
 * why, and "why" is the whole job of this view.
 */
const RELATION_RUNGS: Record<HarmonicRelation, number> = {
  same: 4,
  relative: 4,
  neighbour: 3,
  near: 2,
  clash: 1,
  unknown: 0,
};

function relationPhrase(relation: HarmonicRelation, steps: number | null): string {
  switch (relation) {
    case 'same':
      return 'same key';
    case 'relative':
      return 'relative key';
    case 'neighbour':
      return 'one step round';
    case 'near':
      return `${Math.abs(steps ?? 2)} steps round`;
    case 'clash':
      return 'keys pull apart';
    default:
      return 'key not measured';
  }
}

function tempoPhrase(deltaBpm: number | null): string {
  if (deltaBpm === null) return 'tempo not measured';
  const d = Math.round(deltaBpm);
  if (d === 0) return 'same tempo';
  return `${d > 0 ? '+' : '\u2212'}${Math.abs(d)} BPM`;
}

/**
 * The Camelot position, as the wheel draws it.
 *
 * The chip is the one piece of decoration in here that is also the data: a
 * DJ reads 8A and knows every key it will sit under. An unmeasured key gets
 * the same chip, hollow, so a gap in what the app has heard looks like a gap
 * rather than a bad match.
 */
function KeyChip({ camelot, size }: { camelot: string | null; size: 'deck' | 'row' }) {
  return (
    <span className="dj-key" data-size={size} data-known={camelot ? 'true' : 'false'} aria-hidden>
      {camelot ?? '·'}
    </span>
  );
}

/** Decode a stored key code into the label the wheel uses. */
function describeKey(key: number | null): { camelot: string; label: string } | null {
  if (key === null || !Number.isInteger(key) || key < 0 || key >= 24) return null;
  const tonic = key % 12;
  const mode = key >= 12 ? 'minor' : 'major';
  return { camelot: camelotFor(tonic, mode), label: keyLabel(tonic, mode) };
}

export function DjPanel({
  onBack,
  playlists,
  currentlyPlayingId,
  currentTrack,
  live,
  recall,
  onPlay,
  audible,
  duckGainRef,
  voiceGainRef,
  learner,
}: Props) {
  // Suggestions are computed, not a list you can edit — no source to remove
  // from. The row keeps its own Queue button; the menu adds the rest.
  const trackMenu = useTrackMenu();
  const folders = usePlaylistFolders();
  const [sourceId, setSourceId] = useState<string>('');
  const [request, setRequest] = useState<string>('');
  const [speakEnabled, setSpeakEnabled] = useState<boolean>(true);
  const [queued, setQueued] = useState<Record<string, 'pending' | 'done' | string>>({});
  const [spoken, setSpoken] = useState<string | null>(null);
  const [learnOpen, setLearnOpen] = useState(false);
  const learnBusy =
    learner.state.kind === 'running' || learner.state.kind === 'paused' || learner.state.kind === 'ending';

  const voice = useDjVoice({ enabled: speakEnabled, audible, duckGainRef, voiceGainRef });

  /** Every folder, with the playlists that sit anywhere inside it. Folders
   *  nest, so a folder's set is its own playlists plus its descendants' —
   *  expanded iteratively rather than recursively, because a hand-edited
   *  store could describe a cycle. */
  const folderSources = useMemo(() => {
    const out: Array<{ id: string; label: string; playlists: SpotifyPlaylist[] }> = [];
    for (const folder of folders.folders) {
      const ids = new Set<string>([folder.id]);
      for (;;) {
        const before = ids.size;
        for (const f of folders.folders) {
          if (f.parentId && ids.has(f.parentId)) ids.add(f.id);
        }
        if (ids.size === before) break;
      }
      const inside = playlists.filter((p) => ids.has(folders.assignments[p.id] ?? ''));
      if (inside.length) out.push({ id: folder.id, label: folder.name, playlists: inside });
    }
    return out;
  }, [folders.folders, folders.assignments, playlists]);

  const source = useMemo<DjSource | null>(() => {
    if (!sourceId) return null;
    if (sourceId.startsWith('folder:')) {
      const id = sourceId.slice('folder:'.length);
      const found = folderSources.find((f) => f.id === id);
      const folder = folders.folders.find((f) => f.id === id);
      return found && folder ? { kind: 'folder', folder, playlists: found.playlists } : null;
    }
    const playlist = playlists.find((p) => p.id === sourceId.slice('playlist:'.length));
    return playlist ? { kind: 'playlist', playlist } : null;
  }, [sourceId, folderSources, folders.folders, playlists]);

  /** What we are mixing out of. Live measurement wins where it exists; the
   *  stored profile supplies the tonal shape either way, since the enhancer
   *  does not publish one. */
  const from = useMemo<MixCandidate | null>(() => {
    const stored = recall(currentlyPlayingId);
    const key = live?.key ?? stored?.key ?? null;
    const bpm = live?.bpm ?? stored?.bpm ?? null;
    if (!stored && key === null && bpm === null) return null;
    return {
      key,
      keyConfidence: live?.key != null ? live.keyConfidence : (stored?.keyConfidence ?? 0),
      bpm,
      bpmConfidence: live?.bpm != null ? live.bpmConfidence : (stored?.bpmConfidence ?? 0),
      lufs: stored?.lufs ?? null,
      shape10: stored?.shape10 ?? new Array(10).fill(0),
    };
  }, [recall, currentlyPlayingId, live]);

  const state = useDjSuggestions({
    enabled: true,
    source,
    from,
    currentTrackId: currentlyPlayingId,
    recall,
    request,
  });

  const handleQueue = useCallback(
    async (track: SpotifyTrack, sentence: string) => {
      setQueued((q) => ({ ...q, [track.id]: 'pending' }));
      try {
        await addToQueue(track.uri);
        setQueued((q) => ({ ...q, [track.id]: 'done' }));
        setSpoken(sentence);
        if (speakEnabled) void voice.say(sentence);
      } catch (err) {
        console.error('addToQueue failed:', err);
        setQueued((q) => ({
          ...q,
          // The overwhelmingly likely cause is that Spotify has no active
          // device, which reads as a 404 and is worth naming rather than
          // reporting as a generic failure.
          [track.id]: String(err).includes('404')
            ? 'No active Spotify device — start playback first'
            : 'Could not queue',
        }));
      }
    },
    [speakEnabled, voice],
  );

  const nowKey = describeKey(from?.key ?? null);

  return (
    <div className="dj-wrap">
      {trackMenu.node}
      <div className="sp-overlay-back-row">
        <button type="button" className="sp-overlay-back" onClick={onBack}>
          ← Library
        </button>
      </div>

      <header className="dj-deck">
        <KeyChip camelot={nowKey?.camelot ?? null} size="deck" />
        <div className="dj-deck-track">
          <span className="dj-deck-name">
            {currentTrack ? currentTrack.name : 'Nothing playing'}
          </span>
          <span className="dj-deck-artist">
            {currentTrack ? currentTrack.artists.map((a) => a.name).join(', ') : 'Start a track to mix out of'}
          </span>
        </div>
        <div className="dj-deck-readout">
          <span className="dj-deck-bpm">
            {from?.bpm != null ? Math.round(from.bpm) : '—'}
            <span className="dj-deck-unit">BPM</span>
          </span>
          <span className="dj-deck-key">{nowKey ? nowKey.label : 'key not measured'}</span>
        </div>
      </header>

      <div className="dj-controls">
        <select
          className="dj-source"
          value={sourceId}
          onChange={(e) => setSourceId(e.target.value)}
          aria-label="Where to pick from"
        >
          <option value="">Pick a playlist or folder…</option>
          {folderSources.length > 0 && (
            <optgroup label="Folders">
              {folderSources.map((f) => (
                <option key={f.id} value={`folder:${f.id}`}>
                  {f.label} ({f.playlists.length} playlists)
                </option>
              ))}
            </optgroup>
          )}
          <optgroup label="Playlists">
            {playlists.map((p) => (
              <option key={p.id} value={`playlist:${p.id}`}>
                {p.name}
              </option>
            ))}
          </optgroup>
        </select>
        <input
          type="text"
          className="dj-request-input"
          value={request}
          placeholder="something chill · pick up the energy · keep it in this key"
          onChange={(e) => setRequest(e.target.value)}
          aria-label="What are you after"
        />
        <button
          type="button"
          className="dj-speak"
          onClick={() => setSpeakEnabled((v) => !v)}
          aria-pressed={speakEnabled}
          title={speakEnabled ? 'Reads each pick aloud' : 'Picks are shown, not spoken'}
        >
          <IconSpeak muted={!speakEnabled} />
          Speak it
        </button>
        <button
          type="button"
          className="dj-speak"
          onClick={() => setLearnOpen(true)}
          disabled={learnBusy}
          title="Silently play slices of the songs in playlists you tick, so the DJ learns them"
        >
          Learn playlists
        </button>
      </div>

      <LearnStatus learner={learner} />
      {learnOpen && <LearnSheet learner={learner} playlists={playlists} onClose={() => setLearnOpen(false)} />}

      {request.trim() !== '' && state.kind === 'ready' && (
        <div className="dj-intent" data-understood={state.intent.empty ? 'false' : 'true'}>
          {state.intent.empty
            ? "Didn't catch that — try faster, slower, chill, more energy, brighter, or keep it in this key."
            : describeIntent(state.intent)}
        </div>
      )}

      {state.kind === 'idle' && (
        <div className="sp-empty-state">
          <div className="sp-empty-sub">
            {state.reason === 'no-source'
              ? 'Choose a playlist or a folder to pick from.'
              : state.reason === 'nothing-playing'
                ? 'Start something playing and I can suggest what follows it.'
                : "I haven't heard this track yet. Give it a play and it'll be in the database."}
          </div>
        </div>
      )}
      {state.kind === 'scanning' && (
        <div className="sp-empty-state">
          <div className="sp-empty-sub">Reading the playlist… {state.found || ''}</div>
        </div>
      )}
      {state.kind === 'error' && (
        <div className="sp-empty-state">
          <div className="sp-empty-sub">Couldn't read that source: {state.message}</div>
        </div>
      )}

      {state.kind === 'ready' && (
        <>
          <div className="dj-coverage">
            {/* Said plainly and always. Only tracks the app has heard can be
                ranked, so a thin pool is the honest explanation for a thin
                suggestion — and the fix is to go and play some of it. */}
            <div
              className="dj-coverage-bar"
              style={{
                ['--heard' as string]: `${
                  state.coverage.total > 0
                    ? Math.round((state.coverage.heard / state.coverage.total) * 100)
                    : 0
                }%`,
              }}
              aria-hidden
            />
            <span className="dj-coverage-text">
              Heard <strong>{state.coverage.heard}</strong> of {state.coverage.total}
              {state.coverage.heard > 0 && (
                <> · {state.coverage.measured} with both key and tempo</>
              )}
              {hitScanCap(state.coverage) && <> · stopped at the first {state.coverage.total}</>}
            </span>
          </div>

          {state.picks.length === 0 ? (
            <div className="sp-empty-state">
              <div className="sp-empty-sub">
                Nothing here has been heard yet. Play a few of these tracks and they'll start
                showing up.
              </div>
            </div>
          ) : (
            <ul className="dj-list">
              {state.picks.slice(0, SHOWN).map((pick) => {
                const key = describeKey(pick.profile.key);
                const subject = {
                  camelot: key?.camelot ?? null,
                  key: pick.profile.key,
                  bpm: pick.profile.bpm,
                };
                const sentence = describeTransition(pick.result, subject).sentence;
                const status = queued[pick.track.id];
                const thumb = smallestImage(pick.track.album?.images);
                const relation = pick.result.known.harmonic
                  ? pick.result.harmonic.relation
                  : 'unknown';
                const rungs = RELATION_RUNGS[relation];
                return (
                  <li key={pick.track.id} className="dj-row" data-relation={relation}>
                    <span className="dj-ladder" aria-hidden>
                      {[4, 3, 2, 1].map((rung) => (
                        <span key={rung} className="dj-rung" data-lit={rung <= rungs ? 'true' : 'false'} />
                      ))}
                    </span>
                    <button
                      type="button"
                      className="dj-row-main"
                      onClick={() => onPlay(pick.track)}
                      onContextMenu={(e) => trackMenu.open(pick.track, e)}
                      title={sentence}
                    >
                      {thumb ? (
                        <img className="sp-track-thumb" src={thumb} alt="" loading="lazy" draggable={false} />
                      ) : (
                        <div className="sp-track-thumb sp-track-thumb-fallback" />
                      )}
                      <KeyChip camelot={key?.camelot ?? null} size="row" />
                      <span className="dj-row-text">
                        <span className="sp-track-name">{pick.track.name}</span>
                        <span className="sp-track-artists">
                          {pick.track.artists.map((a) => a.name).join(', ')}
                        </span>
                      </span>
                      <span className="dj-row-fit">
                        <span className="dj-fit-key">
                          {relationPhrase(relation, pick.result.harmonic.steps)}
                        </span>
                        <span className="dj-fit-tempo">{tempoPhrase(pick.result.tempo.deltaBpm)}</span>
                      </span>
                    </button>
                    <button
                      type="button"
                      className="dj-queue-btn"
                      onClick={() => void handleQueue(pick.track, sentence)}
                      disabled={status === 'pending' || status === 'done'}
                      title={sentence}
                    >
                      {status === 'done' ? 'Queued' : status === 'pending' ? '…' : 'Queue'}
                    </button>
                    {typeof status === 'string' && status !== 'pending' && status !== 'done' && (
                      <span className="dj-row-error">{status}</span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}

      {spoken && (
        <div className="dj-said">
          {/* Shown as well as spoken, always. If the voice could not play —
              the user is listening to Spotify directly, or `say` failed —
              this is the whole of the commentary rather than a caption. */}
          <p className="dj-said-text">{spoken}</p>
          {voice.state.kind === 'unavailable' && (
            <p className="dj-said-note">{voice.state.reason}.</p>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Speaker, with the waves struck through when commentary is off. One glyph
 * carrying both states, so the toggle doesn't need a label change to say
 * which way it is set.
 */
function IconSpeak({ muted }: { muted: boolean }) {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M11 5 6 9H3v6h3l5 4V5Z" fill="currentColor" stroke="none" />
      {muted ? (
        <path d="M16 9l5 6M21 9l-5 6" />
      ) : (
        <>
          <path d="M15.5 8.5a5 5 0 0 1 0 7" />
          <path d="M18.5 6a9 9 0 0 1 0 12" />
        </>
      )}
    </svg>
  );
}

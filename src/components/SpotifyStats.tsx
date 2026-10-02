import { memo, useEffect, useMemo, useState } from 'react';
import { getTopArtists, getTopTracks } from '../spotify/api';
import {
  artistConcentration,
  biggestMovers,
  formatLength,
  mainstreamLabel,
  overview,
  popularityStat,
  releaseEras,
  topGenres,
  withRankDeltas,
  type Movers,
  type RankDelta,
  type RankedEntry,
} from '../spotify/stats';
import type { SpotifyArtist, SpotifyTrack, TopTimeRange } from '../spotify/types';
import { smallestImage } from '../shared/image';

/**
 * Listening stats built from `/me/top/{tracks,artists}`.
 *
 * That endpoint is the only listening-history surface Spotify still exposes —
 * the algorithmic feeds and /recommendations went away in Nov 2024 — so
 * everything here is derived from its three fixed windows rather than
 * fetched ready-made.
 *
 * Both windows are fetched for whichever range is showing so rank movement
 * can be computed: `short_term` is compared against `medium_term`, and
 * `medium_term` against `long_term`. All-time has nothing older to compare
 * with, so it shows no movement rather than inventing a baseline.
 */

interface Props {
  onBack: () => void;
  onPlayTrack: (track: SpotifyTrack) => void;
  /** Bumped when the panel opens, so stats refetch rather than going stale. */
  refreshKey: number;
}

const RANGE_LABELS: Record<TopTimeRange, string> = {
  short_term: 'Last 4 weeks',
  medium_term: 'Last 6 months',
  long_term: 'All time',
};

/** What each window is compared against for movement arrows. Long-term has
 *  no older window, so it gets none. */
const COMPARE_AGAINST: Record<TopTimeRange, TopTimeRange | null> = {
  short_term: 'medium_term',
  medium_term: 'long_term',
  long_term: null,
};

const TOP_LIST_SIZE = 20;

/**
 * Tallest era bar, as a percentage of its track.
 *
 * Held below 100 so the count printed directly above the bar has somewhere to
 * sit. Every bar is scaled by the same factor, so the proportions between
 * them are unchanged — only the headroom is.
 */
const ERA_BAR_MAX_PCT = 85;

interface Loaded {
  tracks: SpotifyTrack[];
  artists: SpotifyArtist[];
  prevTracks: SpotifyTrack[];
  prevArtists: SpotifyArtist[];
}

export const SpotifyStats = memo(SpotifyStatsImpl);

function SpotifyStatsImpl({ onBack, onPlayTrack, refreshKey }: Props) {
  const [range, setRange] = useState<TopTimeRange>('short_term');
  const [data, setData] = useState<Loaded | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const compare = COMPARE_AGAINST[range];
    void Promise.all([
      getTopTracks(range),
      getTopArtists(range),
      compare ? getTopTracks(compare) : Promise.resolve([]),
      compare ? getTopArtists(compare) : Promise.resolve([]),
    ])
      .then(([tracks, artists, prevTracks, prevArtists]) => {
        if (cancelled) return;
        setData({ tracks, artists, prevTracks, prevArtists });
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        console.error('stats load failed:', err);
        // A 403 here is almost always the missing `user-top-read` scope on a
        // token issued before Stats existed, which no amount of retrying
        // fixes — name the actual remedy.
        setError(
          String(err).includes('403')
            ? 'Reconnect Spotify in Settings to allow reading your top tracks.'
            : "Couldn't load your stats.",
        );
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [range, refreshKey]);

  const rankedTracks = useMemo<RankedEntry<SpotifyTrack>[]>(
    () => (data ? withRankDeltas(data.tracks.slice(0, TOP_LIST_SIZE), data.prevTracks) : []),
    [data],
  );
  const rankedArtists = useMemo<RankedEntry<SpotifyArtist>[]>(
    () => (data ? withRankDeltas(data.artists.slice(0, TOP_LIST_SIZE), data.prevArtists) : []),
    [data],
  );
  // Genres come free on the artist objects already fetched — no fan-out.
  const genres = useMemo(() => (data ? topGenres(data.artists) : null), [data]);
  const popularity = useMemo(() => (data ? popularityStat(data.tracks) : null), [data]);

  const showMovement = COMPARE_AGAINST[range] !== null;

  // Everything below derives from the same two fetches — no extra requests.
  const summary = useMemo(
    () => (data ? overview(data.tracks, data.artists, showMovement ? data.prevTracks : null) : null),
    [data, showMovement],
  );
  const eras = useMemo(() => (data ? releaseEras(data.tracks) : null), [data]);
  const concentration = useMemo(
    () => (data ? artistConcentration(data.tracks, data.artists) : null),
    [data],
  );
  const trackMovers = useMemo(() => biggestMovers(rankedTracks), [rankedTracks]);
  const artistMovers = useMemo(() => biggestMovers(rankedArtists), [rankedArtists]);

  return (
    <div className="sp-stats">
      {/* Album-art tint carried behind the panel, the same wash the viz banner
          and player bar sit on. Without it this pane read as a grey dashboard
          bolted onto a colour-reactive app. */}
      <div className="sp-stats-wash" aria-hidden />

      <div className="sp-overlay-back-row">
        <button type="button" className="sp-overlay-back" onClick={onBack}>
          ← Library
        </button>
      </div>

      <div className="sp-stats-ranges">
        {(Object.keys(RANGE_LABELS) as TopTimeRange[]).map((r) => (
          <button
            key={r}
            type="button"
            className="sp-stats-range"
            data-active={r === range ? 'true' : 'false'}
            onClick={() => setRange(r)}
          >
            {RANGE_LABELS[r]}
          </button>
        ))}
      </div>

      {error ? (
        <div className="sp-empty-state">
          <div className="sp-empty-title">Stats unavailable</div>
          <div className="sp-empty-sub">{error}</div>
        </div>
      ) : loading ? (
        <div className="sp-empty-state">
          <div className="sp-empty-sub">Crunching your listening…</div>
        </div>
      ) : (
        <div className="sp-stats-scroll">
          <div className="sp-stats-grid">
            {/* Hero: one focal point instead of five equal cards. */}
            <section className="sp-stats-card sp-stats-card-wide sp-stats-hero">
              <div className="sp-stats-hero-main">
                {popularity ? (
                  <>
                    <div className="sp-stats-score">
                      <div className="sp-stats-score-value">
                        {Math.round(popularity.average)}
                      </div>
                      <div className="sp-stats-score-text">
                        <div className="sp-stats-score-label">
                          {mainstreamLabel(popularity.average)}
                        </div>
                        <div className="sp-stats-score-sub">
                          Average Spotify popularity across {popularity.sampled} of your top
                          tracks, where 100 is the most played music on the platform.
                        </div>
                      </div>
                    </div>
                    <div className="sp-stats-meter">
                      <div
                        className="sp-stats-meter-fill"
                        style={{ width: `${Math.round(popularity.average)}%` }}
                      />
                    </div>
                  </>
                ) : (
                  <div className="sp-stats-hero-title">
                    {RANGE_LABELS[range]}
                    <span className="sp-stats-hero-sub">your listening at a glance</span>
                  </div>
                )}

                {popularity && popularity.deepestCuts.length > 0 && (
                  <>
                    <h3 className="sp-stats-subheading">Your deepest cuts</h3>
                    <ul className="sp-stats-deep">
                      {popularity.deepestCuts.map((t) => (
                        <li key={t.id}>
                          <button type="button" onClick={() => onPlayTrack(t)}>
                            <span className="sp-stats-deep-name">{t.name}</span>
                            <span className="sp-stats-deep-artist">
                              {t.artists.map((a) => a.name).join(', ')}
                            </span>
                            <span className="sp-stats-deep-score">{t.popularity}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </div>

              {summary && (
                <div className="sp-stats-tiles">
                  <StatTile value={String(summary.distinctArtists)} label="artists" />
                  {summary.distinctGenres !== null && (
                    <StatTile value={String(summary.distinctGenres)} label="genres" />
                  )}
                  <StatTile value={formatLength(summary.averageLengthMs)} label="avg length" />
                  <StatTile
                    value={`${Math.round(summary.explicitShare * 100)}%`}
                    label="explicit"
                  />
                  {summary.newEntries !== null && (
                    <StatTile value={String(summary.newEntries)} label="new" accent />
                  )}
                </div>
              )}
            </section>

            {eras && (
              <section className="sp-stats-card">
                <h2 className="sp-stats-heading">When your music came out</h2>
                <div className="sp-stats-eras">
                  {eras.map((era) => (
                    <div className="sp-stats-era" key={era.decade}>
                      <span className="sp-stats-era-track">
                        <span className="sp-stats-era-count">{era.count}</span>
                        <span
                          className="sp-stats-era-bar"
                          style={{ height: `${Math.max(4, Math.round(era.share * ERA_BAR_MAX_PCT))}%` }}
                          title={`${era.count} of your top tracks`}
                        />
                      </span>
                      <span className="sp-stats-era-label">{era.label}</span>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {genres && (
              <section className="sp-stats-card">
                <h2 className="sp-stats-heading">Your genres</h2>
                <div className="sp-stats-genres">
                  {genres.map((g) => (
                    <div className="sp-stats-genre" key={g.genre}>
                      <span className="sp-stats-genre-name">{g.genre}</span>
                      <span className="sp-stats-genre-bar">
                        <span
                          className="sp-stats-genre-fill"
                          style={{ width: `${Math.round(g.share * 100)}%` }}
                        />
                      </span>
                      <span className="sp-stats-genre-count">{g.count}</span>
                    </div>
                  ))}
                </div>
                {concentration && (
                  <div className="sp-stats-conc">
                    <span className="sp-stats-conc-value">
                      {Math.round(concentration.share * 100)}%
                    </span>
                    <span className="sp-stats-conc-text">
                      of your top tracks feature your five biggest artists —{' '}
                      {concentration.names.join(', ')}.
                    </span>
                  </div>
                )}
              </section>
            )}

            <section className="sp-stats-card sp-stats-card-wide">
              <h2 className="sp-stats-heading">Top artists</h2>
              {showMovement && <MoverStrip movers={artistMovers} nameOf={(a) => a.name} />}
              <ol className="sp-stats-list">
                {rankedArtists.map((entry) => (
                  <li className="sp-stats-row" key={entry.item.id}>
                    <span className="sp-stats-rank">{entry.rank}</span>
                    {smallestImage(entry.item.images ?? []) ? (
                      <img
                        className="sp-stats-avatar"
                        src={smallestImage(entry.item.images ?? [])}
                        alt=""
                        loading="lazy"
                        draggable={false}
                      />
                    ) : (
                      <span className="sp-stats-avatar sp-stats-avatar-fallback" />
                    )}
                    <span className="sp-stats-row-name">{entry.item.name}</span>
                    {showMovement && <DeltaBadge delta={entry.delta} />}
                  </li>
                ))}
              </ol>
            </section>

            <section className="sp-stats-card sp-stats-card-wide">
              <h2 className="sp-stats-heading">Top tracks</h2>
              {showMovement && <MoverStrip movers={trackMovers} nameOf={(t) => t.name} />}
              <ol className="sp-stats-list">
                {rankedTracks.map((entry) => (
                  <li className="sp-stats-row" key={entry.item.id}>
                    <span className="sp-stats-rank">{entry.rank}</span>
                    {smallestImage(entry.item.album.images) ? (
                      <img
                        className="sp-stats-avatar sp-stats-avatar-square"
                        src={smallestImage(entry.item.album.images)}
                        alt=""
                        loading="lazy"
                        draggable={false}
                      />
                    ) : (
                      <span className="sp-stats-avatar sp-stats-avatar-square sp-stats-avatar-fallback" />
                    )}
                    <button
                      type="button"
                      className="sp-stats-row-name sp-stats-row-play"
                      onClick={() => onPlayTrack(entry.item)}
                      title={`Play ${entry.item.name}`}
                    >
                      {entry.item.name}
                      <span className="sp-stats-row-artist">
                        {entry.item.artists.map((a) => a.name).join(', ')}
                      </span>
                    </button>
                    {showMovement && <DeltaBadge delta={entry.delta} />}
                  </li>
                ))}
              </ol>
            </section>
          </div>

          {showMovement && (
            <p className="sp-stats-note">
              Movement is measured against{' '}
              <strong>{RANGE_LABELS[COMPARE_AGAINST[range]!].toLowerCase()}</strong>.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function StatTile({ value, label, accent }: { value: string; label: string; accent?: boolean }) {
  return (
    <div className="sp-stats-tile" data-accent={accent ? 'true' : undefined}>
      <div className="sp-stats-tile-value">{value}</div>
      <div className="sp-stats-tile-label">{label}</div>
    </div>
  );
}

/** Calls out the single largest rise and fall, which are otherwise buried in
 *  a 20-row list the user has to scan for coloured arrows. */
function MoverStrip<T extends { id: string }>({
  movers,
  nameOf,
}: {
  movers: Movers<T>;
  nameOf: (item: T) => string;
}) {
  if (!movers.climber && !movers.faller) return null;
  return (
    <div className="sp-stats-movers">
      {movers.climber && (
        <div className="sp-stats-mover" data-dir="up">
          <span className="sp-stats-mover-arrow">▲</span>
          <span className="sp-stats-mover-name">{nameOf(movers.climber.item)}</span>
          <span className="sp-stats-mover-by">
            up {(movers.climber.delta as { by: number }).by}
          </span>
        </div>
      )}
      {movers.faller && (
        <div className="sp-stats-mover" data-dir="down">
          <span className="sp-stats-mover-arrow">▼</span>
          <span className="sp-stats-mover-name">{nameOf(movers.faller.item)}</span>
          <span className="sp-stats-mover-by">
            down {(movers.faller.delta as { by: number }).by}
          </span>
        </div>
      )}
    </div>
  );
}

function DeltaBadge({ delta }: { delta: RankDelta }) {
  if (delta.kind === 'same') {
    return (
      <span className="sp-stats-delta" data-dir="same" title="No change">
        –
      </span>
    );
  }
  if (delta.kind === 'new') {
    return (
      <span className="sp-stats-delta" data-dir="new" title="Not in the longer window">
        NEW
      </span>
    );
  }
  const up = delta.kind === 'up';
  return (
    <span
      className="sp-stats-delta"
      data-dir={up ? 'up' : 'down'}
      title={`${up ? 'Up' : 'Down'} ${delta.by} place${delta.by === 1 ? '' : 's'}`}
    >
      {up ? '▲' : '▼'}
      {delta.by}
    </span>
  );
}

import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  addToQueue,
  SEARCH_MAX_OFFSET,
  SEARCH_PAGE_SIZE,
  type SearchResults,
  type SearchType,
} from '../spotify/api';
import type {
  SpotifyAlbum,
  SpotifyArtist,
  SpotifyPlaylist,
  SpotifyTrack,
} from '../spotify/types';
import { formatDuration } from '../shared/format';
import { pickMediumImage, smallestImage } from '../shared/image';
import { ContextMenu, type ContextMenuItem } from './ContextMenu';

/**
 * Remote search results for the library overlay: type tabs, a top-result
 * card, and keyboard-navigable rows.
 *
 * Keyboard nav lives here but is *driven from the search input* — the input
 * keeps focus the whole time (so typing never breaks), and forwards arrow /
 * Enter presses through the imperative handle below. Owning `activeIndex`
 * here rather than in the parent keeps the flattened row list (which only
 * this component knows how to build) in one place.
 */

type Tab = 'all' | SearchType;

/** One activatable result row, in display order. */
type Row =
  | { kind: 'track'; item: SpotifyTrack }
  | { kind: 'artist'; item: SpotifyArtist }
  | { kind: 'album'; item: SpotifyAlbum }
  | { kind: 'playlist'; item: SpotifyPlaylist };

export interface SearchResultsHandle {
  /** Move the active row by `delta`, clamped to the list. */
  move: (delta: number) => void;
  /** Activate the current row. Returns false when nothing is selected, so
   *  the caller can fall back to its own Enter behavior. */
  activate: () => boolean;
}

interface Props {
  results: SearchResults;
  loading: boolean;
  loadingMore: boolean;
  onLoadMore: (type: SearchType) => void;
  currentlyPlayingId: string | null;
  onPlayTrack: (track: SpotifyTrack) => void;
  onSelectArtist: (artist: SpotifyArtist) => void;
  onSelectAlbum: (album: SpotifyAlbum) => void;
  onSelectPlaylist: (playlist: SpotifyPlaylist) => void;
  /** The trimmed query — used for the top-result heuristic and to reset the
   *  active row whenever the user retypes. */
  query: string;
}

/** How many of each type the "All" tab shows before you have to switch tabs. */
const ALL_TAB_SECTION_SIZE = 4;

const TAB_LABELS: Array<{ tab: Tab; label: string }> = [
  { tab: 'all', label: 'All' },
  { tab: 'track', label: 'Songs' },
  { tab: 'artist', label: 'Artists' },
  { tab: 'album', label: 'Albums' },
  { tab: 'playlist', label: 'Playlists' },
];

export const SpotifySearchResults = memo(
  forwardRef<SearchResultsHandle, Props>(SpotifySearchResultsImpl),
);

function SpotifySearchResultsImpl(
  {
    results,
    loading,
    loadingMore,
    onLoadMore,
    currentlyPlayingId,
    onPlayTrack,
    onSelectArtist,
    onSelectAlbum,
    onSelectPlaylist,
    query,
  }: Props,
  ref: React.ForwardedRef<SearchResultsHandle>,
) {
  const [tab, setTab] = useState<Tab>('all');
  const [activeIndex, setActiveIndex] = useState<number>(-1);
  const scrollRef = useRef<HTMLDivElement>(null);

  /**
   * Top result. Spotify's own ranker isn't exposed, so this is a deliberate
   * heuristic: an artist whose name is what you typed wins (you searched a
   * person, not a song), otherwise the best-matching track.
   */
  const topResult = useMemo<Row | null>(() => {
    const q = query.trim().toLowerCase();
    if (q.length === 0) return null;
    const artistMatch = results.artists.find((a) => {
      const n = a.name.toLowerCase();
      return n === q || n.startsWith(q);
    });
    if (artistMatch) return { kind: 'artist', item: artistMatch };
    if (results.tracks[0]) return { kind: 'track', item: results.tracks[0] };
    if (results.artists[0]) return { kind: 'artist', item: results.artists[0] };
    if (results.albums[0]) return { kind: 'album', item: results.albums[0] };
    if (results.playlists[0]) return { kind: 'playlist', item: results.playlists[0] };
    return null;
  }, [query, results]);

  /**
   * Everything the render and the keyboard both need, derived once.
   *
   * `rows` is the flat, ordered list keyboard nav moves over, and the
   * per-section `*Start` offsets map a section's local index back into it.
   * Deriving the sliced arrays and `rows` in the same pass is the point —
   * computing them separately let the arrow keys and the drawn rows drift.
   */
  const view = useMemo(() => {
    const top = tab === 'all' ? topResult : null;
    // On the All tab each section is capped and drops whatever the top-result
    // card already promoted, so nothing appears twice.
    const slice = <T extends { id: string }>(items: T[], kind: Row['kind']): T[] => {
      if (tab !== 'all') return items;
      return items
        .filter((it) => !(top?.kind === kind && it.id === top.item.id))
        .slice(0, ALL_TAB_SECTION_SIZE);
    };
    const tracks = tab === 'all' || tab === 'track' ? slice(results.tracks, 'track') : [];
    const artists = tab === 'all' || tab === 'artist' ? slice(results.artists, 'artist') : [];
    const albums = tab === 'all' || tab === 'album' ? slice(results.albums, 'album') : [];
    const playlists =
      tab === 'all' || tab === 'playlist' ? slice(results.playlists, 'playlist') : [];

    const rows: Row[] = [];
    if (top) rows.push(top);
    const trackStart = rows.length;
    for (const item of tracks) rows.push({ kind: 'track', item });
    const artistStart = rows.length;
    for (const item of artists) rows.push({ kind: 'artist', item });
    const albumStart = rows.length;
    for (const item of albums) rows.push({ kind: 'album', item });
    const playlistStart = rows.length;
    for (const item of playlists) rows.push({ kind: 'playlist', item });

    return {
      top,
      tracks,
      artists,
      albums,
      playlists,
      rows,
      trackStart,
      artistStart,
      albumStart,
      playlistStart,
    };
  }, [tab, results, topResult]);

  const activate = useCallback(
    (row: Row): void => {
      if (row.kind === 'track') onPlayTrack(row.item);
      else if (row.kind === 'artist') onSelectArtist(row.item);
      else if (row.kind === 'album') onSelectAlbum(row.item);
      else onSelectPlaylist(row.item);
    },
    [onPlayTrack, onSelectArtist, onSelectAlbum, onSelectPlaylist],
  );

  // The parent holds the handle across renders, so read the live row list and
  // selection through refs rather than rebuilding the handle every response.
  const rowsRef = useRef<Row[]>(view.rows);
  rowsRef.current = view.rows;
  const activeIndexRef = useRef<number>(activeIndex);
  activeIndexRef.current = activeIndex;

  useImperativeHandle(
    ref,
    () => ({
      move: (delta: number) => {
        const count = rowsRef.current.length;
        if (count === 0) return;
        setActiveIndex((i) => {
          const next = i + delta;
          if (next < 0) return 0;
          if (next >= count) return count - 1;
          return next;
        });
      },
      activate: () => {
        const row = rowsRef.current[activeIndexRef.current];
        if (!row) return false;
        activate(row);
        return true;
      },
    }),
    [activate],
  );

  // Retyping or switching tabs drops the selection — leaving it parked on
  // index 3 of a brand-new result set would activate something the user
  // never looked at.
  useEffect(() => {
    setActiveIndex(-1);
  }, [query, tab]);

  // Keep the active row on screen during arrow-key runs.
  useEffect(() => {
    if (activeIndex < 0) return;
    const el = scrollRef.current?.querySelector<HTMLElement>('[data-active-row="true"]');
    el?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  /* ─── Right-click → add to queue (tracks only) ─── */

  const [menu, setMenu] = useState<{ x: number; y: number; track: SpotifyTrack } | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const handleTrackContextMenu = useCallback(
    (track: SpotifyTrack, e: React.MouseEvent): void => {
      e.preventDefault();
      setMenu({ x: e.clientX, y: e.clientY, track });
    },
    [],
  );
  const menuItems = useMemo<ContextMenuItem[]>(() => {
    if (!menu) return [];
    const uri = menu.track.uri;
    return [
      {
        label: 'Add to queue',
        onClick: () => {
          void addToQueue(uri).catch((err) => console.error('addToQueue failed:', err));
        },
      },
    ];
  }, [menu]);

  /* ─── Paging (single-type tabs only — "All" mixes types) ─── */

  const singleType: SearchType | null = tab === 'all' ? null : tab;
  const loadedCount =
    singleType === 'track'
      ? results.tracks.length
      : singleType === 'artist'
        ? results.artists.length
        : singleType === 'album'
          ? results.albums.length
          : singleType === 'playlist'
            ? results.playlists.length
            : 0;
  const totalCount = singleType ? results.totals[singleType] : 0;
  const canLoadMore =
    singleType !== null &&
    loadedCount > 0 &&
    loadedCount < totalCount &&
    loadedCount + SEARCH_PAGE_SIZE <= SEARCH_MAX_OFFSET;

  const grandTotal =
    results.totals.track +
    results.totals.artist +
    results.totals.album +
    results.totals.playlist;

  if (loading && grandTotal === 0) {
    return (
      <div className="sp-empty-state">
        <div className="sp-empty-sub">Searching…</div>
      </div>
    );
  }

  if (grandTotal === 0) {
    return (
      <div className="sp-empty-state">
        <div className="sp-empty-title">No results</div>
        <div className="sp-empty-sub">Nothing on Spotify matched “{query}”.</div>
      </div>
    );
  }

  return (
    <>
      <div className="sp-search-tabs">
        {TAB_LABELS.map(({ tab: t, label }) => {
          // Hide type tabs with nothing behind them; "All" always shows.
          if (t !== 'all' && results.totals[t] === 0) return null;
          return (
            <button
              key={t}
              type="button"
              className="sp-library-pill"
              data-active={tab === t ? 'true' : 'false'}
              onClick={() => setTab(t)}
            >
              {label}
            </button>
          );
        })}
        {loading && <span className="sp-search-spinner">refreshing…</span>}
      </div>

      <div className="sp-library-scroll" ref={scrollRef}>
        {view.top && (
          <section className="sp-search-section">
            <h3 className="sp-search-section-title">Top result</h3>
            <TopResultCard
              row={view.top}
              active={activeIndex === 0}
              onClick={() => view.top && activate(view.top)}
            />
          </section>
        )}

        {view.tracks.length > 0 && (
          <section className="sp-search-section">
            {tab === 'all' && <h3 className="sp-search-section-title">Songs</h3>}
            <table className="sp-track-table sp-search-table">
              <tbody>
                {view.tracks.map((track, i) => (
                  <TrackRow
                    key={`${track.id}-${i}`}
                    track={track}
                    active={activeIndex === view.trackStart + i}
                    playing={track.id === currentlyPlayingId}
                    onClick={() => onPlayTrack(track)}
                    onContextMenu={(e) => handleTrackContextMenu(track, e)}
                  />
                ))}
              </tbody>
            </table>
          </section>
        )}

        {view.artists.length > 0 && (
          <section className="sp-search-section">
            {tab === 'all' && <h3 className="sp-search-section-title">Artists</h3>}
            <div className="sp-search-tile-grid">
              {view.artists.map((artist, i) => (
                <ArtistTile
                  key={artist.id}
                  artist={artist}
                  active={activeIndex === view.artistStart + i}
                  onClick={() => onSelectArtist(artist)}
                />
              ))}
            </div>
          </section>
        )}

        {view.albums.length > 0 && (
          <section className="sp-search-section">
            {tab === 'all' && <h3 className="sp-search-section-title">Albums</h3>}
            <div className="sp-search-tile-grid">
              {view.albums.map((album, i) => (
                <CoverTile
                  key={album.id}
                  title={album.name}
                  meta={album.artists.map((a) => a.name).join(', ')}
                  imageUrl={pickMediumImage(album.images)}
                  active={activeIndex === view.albumStart + i}
                  onClick={() => onSelectAlbum(album)}
                />
              ))}
            </div>
          </section>
        )}

        {view.playlists.length > 0 && (
          <section className="sp-search-section">
            {tab === 'all' && <h3 className="sp-search-section-title">Playlists</h3>}
            <div className="sp-search-tile-grid">
              {view.playlists.map((playlist, i) => (
                <CoverTile
                  key={playlist.id}
                  title={playlist.name}
                  meta={`By ${playlist.owner.display_name ?? playlist.owner.id}`}
                  imageUrl={pickMediumImage(playlist.images)}
                  active={activeIndex === view.playlistStart + i}
                  onClick={() => onSelectPlaylist(playlist)}
                />
              ))}
            </div>
          </section>
        )}

        {canLoadMore && singleType && (
          <div className="sp-search-more">
            <button
              type="button"
              className="sp-search-more-btn"
              disabled={loadingMore}
              onClick={() => onLoadMore(singleType)}
            >
              {loadingMore ? 'Loading…' : `Load more (${loadedCount} of ${totalCount})`}
            </button>
          </div>
        )}
      </div>

      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={closeMenu} />}
    </>
  );
}

/* ─── Rows + tiles ─── */

interface TopResultCardProps {
  row: Row;
  active: boolean;
  onClick: () => void;
}

function TopResultCard({ row, active, onClick }: TopResultCardProps) {
  const { title, meta, imageUrl, round } = describeRow(row);
  return (
    <button
      type="button"
      className="sp-search-top-card"
      data-active-row={active ? 'true' : 'false'}
      onClick={onClick}
      title={`${title} — ${meta}`}
    >
      {imageUrl ? (
        <img
          className="sp-search-top-cover"
          data-round={round ? 'true' : 'false'}
          src={imageUrl}
          alt=""
          draggable={false}
        />
      ) : (
        <div
          className="sp-search-top-cover sp-library-tile-cover-fallback"
          data-round={round ? 'true' : 'false'}
        />
      )}
      <div className="sp-search-top-text">
        <div className="sp-search-top-title">{title}</div>
        <div className="sp-search-top-meta">{meta}</div>
      </div>
    </button>
  );
}

function describeRow(row: Row): {
  title: string;
  meta: string;
  imageUrl: string | undefined;
  round: boolean;
} {
  if (row.kind === 'track') {
    return {
      title: row.item.name,
      meta: `Song · ${row.item.artists.map((a) => a.name).join(', ')}`,
      imageUrl: pickMediumImage(row.item.album.images),
      round: false,
    };
  }
  if (row.kind === 'artist') {
    return {
      title: row.item.name,
      meta: 'Artist',
      imageUrl: pickMediumImage(row.item.images ?? []),
      round: true,
    };
  }
  if (row.kind === 'album') {
    return {
      title: row.item.name,
      meta: `Album · ${row.item.artists.map((a) => a.name).join(', ')}`,
      imageUrl: pickMediumImage(row.item.images),
      round: false,
    };
  }
  return {
    title: row.item.name,
    meta: `Playlist · ${row.item.owner.display_name ?? row.item.owner.id}`,
    imageUrl: pickMediumImage(row.item.images),
    round: false,
  };
}

interface TrackRowProps {
  track: SpotifyTrack;
  active: boolean;
  playing: boolean;
  onClick: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
}

function TrackRow({ track, active, playing, onClick, onContextMenu }: TrackRowProps) {
  const thumbUrl = smallestImage(track.album.images);
  return (
    <tr
      className="sp-track-row"
      data-playing={playing ? 'true' : 'false'}
      data-active-row={active ? 'true' : 'false'}
      onClick={onClick}
      onContextMenu={onContextMenu}
    >
      <td className="sp-track-title-cell">
        {thumbUrl ? (
          <img className="sp-track-thumb" src={thumbUrl} alt="" loading="lazy" draggable={false} />
        ) : (
          <div className="sp-track-thumb sp-track-thumb-fallback" />
        )}
        <div className="sp-track-text">
          <div className="sp-track-name">{track.name}</div>
          <div className="sp-track-artists">
            {track.explicit ? <span className="sp-track-explicit">E</span> : null}
            {track.artists.map((a) => a.name).join(', ')}
          </div>
        </div>
      </td>
      <td className="sp-track-album">{track.album.name}</td>
      <td className="sp-track-duration">{formatDuration(track.duration_ms)}</td>
    </tr>
  );
}

interface ArtistTileProps {
  artist: SpotifyArtist;
  active: boolean;
  onClick: () => void;
}

function ArtistTile({ artist, active, onClick }: ArtistTileProps) {
  const imageUrl = pickMediumImage(artist.images ?? []);
  return (
    <button
      type="button"
      className="sp-library-tile"
      data-active-row={active ? 'true' : 'false'}
      onClick={onClick}
      title={`Play ${artist.name}`}
    >
      {imageUrl ? (
        <img
          className="sp-library-tile-cover sp-library-tile-cover-round"
          src={imageUrl}
          alt=""
          loading="lazy"
          draggable={false}
        />
      ) : (
        <div className="sp-library-tile-cover sp-library-tile-cover-round sp-library-tile-cover-fallback" />
      )}
      <div className="sp-library-tile-name">{artist.name}</div>
      <div className="sp-library-tile-meta">Artist</div>
    </button>
  );
}

interface CoverTileProps {
  title: string;
  meta: string;
  imageUrl: string | undefined;
  active: boolean;
  onClick: () => void;
}

function CoverTile({ title, meta, imageUrl, active, onClick }: CoverTileProps) {
  return (
    <button
      type="button"
      className="sp-library-tile"
      data-active-row={active ? 'true' : 'false'}
      onClick={onClick}
      title={`${title} — ${meta}`}
    >
      {imageUrl ? (
        <img
          className="sp-library-tile-cover"
          src={imageUrl}
          alt=""
          loading="lazy"
          draggable={false}
        />
      ) : (
        <div className="sp-library-tile-cover sp-library-tile-cover-fallback" />
      )}
      <div className="sp-library-tile-name">{title}</div>
      <div className="sp-library-tile-meta">{meta}</div>
    </button>
  );
}

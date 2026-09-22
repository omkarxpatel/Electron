import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  emptySearchResults,
  getSavedAlbums,
  type SearchResults,
  type SearchType,
} from '../spotify/api';
import type {
  SpotifyAlbum,
  SpotifyArtist,
  SpotifyPlaylist,
  SpotifyTrack,
} from '../spotify/types';
import { pickMediumImage } from '../shared/image';
import { SpotifySearchResults, type SearchResultsHandle } from './SpotifySearchResults';

type Filter = 'all' | 'playlists' | 'albums';

interface Props {
  playlists: SpotifyPlaylist[];
  playlistsLoading: boolean;
  selectedPlaylistId: string | null;
  onSelectPlaylist: (playlist: SpotifyPlaylist) => void;
  onSelectAlbum: (album: SpotifyAlbum) => void;
  onSelectArtist: (artist: SpotifyArtist) => void;
  searchAll: (query: string, signal?: AbortSignal) => Promise<SearchResults>;
  searchMore: (query: string, type: SearchType, offset: number) => Promise<SearchResults>;
  onPlayTrack: (track: SpotifyTrack) => void;
  currentlyPlayingId: string | null;
  onOpenQueue: () => void;
  /** Bumped when the panel opens — used to refetch saved albums on each open. */
  refreshKey: number;
}

const SEARCH_DEBOUNCE_MS = 280;
/** Cap on the "In your library" strip — it's a shortcut, not a second list. */
const LIBRARY_MATCH_LIMIT = 6;

export const SpotifyLibrary = memo(SpotifyLibraryImpl);

function SpotifyLibraryImpl({
  playlists,
  playlistsLoading,
  selectedPlaylistId,
  onSelectPlaylist,
  onSelectAlbum,
  onSelectArtist,
  searchAll,
  searchMore,
  onPlayTrack,
  currentlyPlayingId,
  onOpenQueue,
  refreshKey,
}: Props) {
  const [filter, setFilter] = useState<Filter>('all');
  const [savedAlbums, setSavedAlbums] = useState<SpotifyAlbum[]>([]);
  const [albumsLoading, setAlbumsLoading] = useState<boolean>(false);

  const [query, setQuery] = useState<string>('');
  const [results, setResults] = useState<SearchResults>(emptySearchResults);
  const [searchLoading, setSearchLoading] = useState<boolean>(false);
  const [loadingMore, setLoadingMore] = useState<boolean>(false);
  const resultsHandleRef = useRef<SearchResultsHandle>(null);

  // Saved albums — refetch on each panel open.
  useEffect(() => {
    let cancelled = false;
    setAlbumsLoading(true);
    getSavedAlbums(50, 0)
      .then((res) => {
        if (cancelled) return;
        setSavedAlbums(res?.items.map((it) => it.album) ?? []);
        setAlbumsLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        console.error('getSavedAlbums failed:', err);
        setSavedAlbums([]);
        setAlbumsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  /**
   * Debounced search. The AbortController is what keeps responses in order:
   * every keystroke aborts the previous request, so a slow early response
   * can't land after a fast later one. (This replaced a request-id ref —
   * aborting also stops the wasted work, not just the stale setState.)
   */
  useEffect(() => {
    const q = query.trim();
    if (q.length === 0) {
      setResults(emptySearchResults());
      setSearchLoading(false);
      return;
    }
    setSearchLoading(true);
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      searchAll(q, controller.signal)
        .then((res) => {
          setResults(res);
          setSearchLoading(false);
        })
        .catch((err) => {
          // Aborted = superseded by a newer query; the effect that replaced
          // us has already set its own loading state.
          if (err instanceof DOMException && err.name === 'AbortError') return;
          setResults(emptySearchResults());
          setSearchLoading(false);
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [query, searchAll]);

  const isSearching = query.trim().length > 0;

  /** Append one more page for a single type, de-duped by id (Spotify's
   *  paging can repeat an item across page boundaries). */
  const handleLoadMore = useCallback(
    async (type: SearchType): Promise<void> => {
      const q = query.trim();
      if (q.length === 0 || loadingMore) return;
      setLoadingMore(true);
      try {
        const offsetByType: Record<SearchType, number> = {
          track: results.tracks.length,
          artist: results.artists.length,
          album: results.albums.length,
          playlist: results.playlists.length,
        };
        const page = await searchMore(q, type, offsetByType[type]);
        setResults((prev) => mergePage(prev, type, page));
      } finally {
        setLoadingMore(false);
      }
    },
    [query, loadingMore, results, searchMore],
  );

  /**
   * All search keyboard handling sits on the input so it never loses focus:
   *   Esc      — clears the query; only closes the overlay when already empty
   *   ↑ / ↓    — move the active result row (forwarded to the results list)
   *   Enter    — activate the active row
   *
   * `stopPropagation` on the clearing Esc is load-bearing: HoverOverlayPanel
   * listens for Escape on `window` and would otherwise close the whole panel
   * out from under a half-typed query.
   */
  const handleSearchKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>): void => {
      if (e.key === 'Escape') {
        if (query.length > 0) {
          e.preventDefault();
          e.stopPropagation();
          setQuery('');
        }
        return;
      }
      if (!isSearching) return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        resultsHandleRef.current?.move(1);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        resultsHandleRef.current?.move(-1);
      } else if (e.key === 'Enter') {
        if (resultsHandleRef.current?.activate()) e.preventDefault();
      }
    },
    [query, isSearching],
  );

  /** Your own playlists / saved albums matching the query, shown above the
   *  remote results so "find my playlist by name" doesn't mean scrolling
   *  the whole grid. Mouse-only — arrow keys drive the remote list. */
  const libraryMatches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q.length === 0) return [];
    const out: Array<
      { kind: 'playlist'; item: SpotifyPlaylist } | { kind: 'album'; item: SpotifyAlbum }
    > = [];
    for (const p of playlists) {
      if (p.name.toLowerCase().includes(q)) out.push({ kind: 'playlist', item: p });
    }
    for (const a of savedAlbums) {
      const hit =
        a.name.toLowerCase().includes(q) ||
        a.artists.some((x) => x.name.toLowerCase().includes(q));
      if (hit) out.push({ kind: 'album', item: a });
    }
    return out.slice(0, LIBRARY_MATCH_LIMIT);
  }, [query, playlists, savedAlbums]);

  const filteredItems = useMemo(() => {
    const items: Array<
      | { kind: 'playlist'; item: SpotifyPlaylist }
      | { kind: 'album'; item: SpotifyAlbum }
    > = [];
    if (filter !== 'albums') {
      for (const p of playlists) items.push({ kind: 'playlist', item: p });
    }
    if (filter !== 'playlists') {
      for (const a of savedAlbums) items.push({ kind: 'album', item: a });
    }
    return items;
  }, [filter, playlists, savedAlbums]);

  return (
    <div className="sp-library">
      <div className="sp-library-topbar">
        <div className="sp-library-search-wrap">
          <span className="sp-library-search-icon" aria-hidden>
            <IconSearch />
          </span>
          <input
            type="search"
            className="sp-library-search-input"
            placeholder="Songs, artists, albums, playlists…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleSearchKeyDown}
            spellCheck={false}
            autoComplete="off"
            aria-label="Search Spotify"
          />
          {query.length > 0 && (
            <button
              type="button"
              className="sp-library-search-clear"
              onClick={() => setQuery('')}
              aria-label="Clear search"
              title="Clear (Esc)"
            >
              ×
            </button>
          )}
        </div>
        <button
          type="button"
          className="sp-library-queue-btn"
          onClick={onOpenQueue}
          aria-label="Open queue"
          title="View queue"
        >
          <IconQueue />
          <span>Queue</span>
        </button>
      </div>

      {isSearching ? (
        <>
          {libraryMatches.length > 0 && (
            <div className="sp-search-library-strip">
              <span className="sp-search-library-label">In your library</span>
              {libraryMatches.map((entry) => (
                <button
                  key={`${entry.kind}-${entry.item.id}`}
                  type="button"
                  className="sp-search-library-chip"
                  onClick={() =>
                    entry.kind === 'playlist'
                      ? onSelectPlaylist(entry.item)
                      : onSelectAlbum(entry.item)
                  }
                  title={entry.item.name}
                >
                  {pickMediumImage(entry.item.images) ? (
                    <img
                      className="sp-search-library-chip-cover"
                      src={pickMediumImage(entry.item.images)}
                      alt=""
                      loading="lazy"
                      draggable={false}
                    />
                  ) : null}
                  <span className="sp-search-library-chip-name">{entry.item.name}</span>
                </button>
              ))}
            </div>
          )}
          <SpotifySearchResults
            ref={resultsHandleRef}
            results={results}
            loading={searchLoading}
            loadingMore={loadingMore}
            onLoadMore={handleLoadMore}
            currentlyPlayingId={currentlyPlayingId}
            onPlayTrack={onPlayTrack}
            onSelectArtist={onSelectArtist}
            onSelectAlbum={onSelectAlbum}
            onSelectPlaylist={onSelectPlaylist}
            query={query}
          />
        </>
      ) : (
        <>
          <div className="sp-library-filters">
            <FilterPill label="All" active={filter === 'all'} onClick={() => setFilter('all')} />
            <FilterPill
              label="Playlists"
              active={filter === 'playlists'}
              onClick={() => setFilter('playlists')}
            />
            <FilterPill
              label="Albums"
              active={filter === 'albums'}
              onClick={() => setFilter('albums')}
            />
          </div>

          <div className="sp-library-scroll">
            {(playlistsLoading || albumsLoading) && filteredItems.length === 0 ? (
              <div className="sp-empty-state">
                <div className="sp-empty-sub">Loading your library…</div>
              </div>
            ) : filteredItems.length === 0 ? (
              <div className="sp-empty-state">
                <div className="sp-empty-title">Nothing here yet</div>
                <div className="sp-empty-sub">
                  {filter === 'albums'
                    ? "Save an album in Spotify and it'll show up here."
                    : filter === 'playlists'
                      ? "Follow a playlist and it'll show up here."
                      : 'Save albums or playlists in Spotify to fill your library.'}
                </div>
              </div>
            ) : (
              <div className="sp-library-grid">
                {filteredItems.map((entry) =>
                  entry.kind === 'playlist' ? (
                    <PlaylistTile
                      key={`p-${entry.item.id}`}
                      playlist={entry.item}
                      selected={entry.item.id === selectedPlaylistId}
                      onClick={() => onSelectPlaylist(entry.item)}
                    />
                  ) : (
                    <AlbumTile
                      key={`a-${entry.item.id}`}
                      album={entry.item}
                      onClick={() => onSelectAlbum(entry.item)}
                    />
                  ),
                )}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/** Append `page`'s items for one type onto `prev`, de-duped by id. Totals come
 *  from the fresh page since they're authoritative for that query. */
function mergePage(
  prev: SearchResults,
  type: SearchType,
  page: SearchResults,
): SearchResults {
  const append = <T extends { id: string }>(existing: T[], incoming: T[]): T[] => {
    const seen = new Set(existing.map((it) => it.id));
    return [...existing, ...incoming.filter((it) => !seen.has(it.id))];
  };
  const next: SearchResults = { ...prev };
  if (type === 'track') next.tracks = append(prev.tracks, page.tracks);
  else if (type === 'artist') next.artists = append(prev.artists, page.artists);
  else if (type === 'album') next.albums = append(prev.albums, page.albums);
  else next.playlists = append(prev.playlists, page.playlists);
  next.totals = { ...prev.totals, [type]: page.totals[type] || prev.totals[type] };
  return next;
}

interface FilterPillProps {
  label: string;
  active: boolean;
  onClick: () => void;
}

function FilterPill({ label, active, onClick }: FilterPillProps) {
  return (
    <button
      type="button"
      className="sp-library-pill"
      data-active={active ? 'true' : 'false'}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

interface PlaylistTileProps {
  playlist: SpotifyPlaylist;
  selected: boolean;
  onClick: () => void;
}

function PlaylistTile({ playlist, selected, onClick }: PlaylistTileProps) {
  const coverUrl = pickMediumImage(playlist.images);
  const ownerLabel = playlist.owner.display_name ?? playlist.owner.id;
  return (
    <button
      type="button"
      className="sp-library-tile"
      data-selected={selected ? 'true' : 'false'}
      onClick={onClick}
      title={`${playlist.name} — ${ownerLabel}`}
    >
      {coverUrl ? (
        <img className="sp-library-tile-cover" src={coverUrl} alt="" loading="lazy" draggable={false} />
      ) : (
        <div className="sp-library-tile-cover sp-library-tile-cover-fallback" />
      )}
      <div className="sp-library-tile-name">{playlist.name}</div>
      <div className="sp-library-tile-meta">Playlist · {ownerLabel}</div>
    </button>
  );
}

interface AlbumTileProps {
  album: SpotifyAlbum;
  onClick: () => void;
}

function AlbumTile({ album, onClick }: AlbumTileProps) {
  const coverUrl = pickMediumImage(album.images);
  const artistNames = album.artists.map((a) => a.name).join(', ');
  return (
    <button
      type="button"
      className="sp-library-tile"
      onClick={onClick}
      title={`${album.name} — ${artistNames}`}
    >
      {coverUrl ? (
        <img className="sp-library-tile-cover" src={coverUrl} alt="" loading="lazy" draggable={false} />
      ) : (
        <div className="sp-library-tile-cover sp-library-tile-cover-fallback" />
      )}
      <div className="sp-library-tile-name">{album.name}</div>
      <div className="sp-library-tile-meta">Album · {artistNames}</div>
    </button>
  );
}

function IconSearch() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="11" cy="11" r="7" />
      <line x1="20" y1="20" x2="16.65" y2="16.65" />
    </svg>
  );
}

function IconQueue() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <line x1="4" y1="6" x2="20" y2="6" />
      <line x1="4" y1="12" x2="20" y2="12" />
      <line x1="4" y1="18" x2="14" y2="18" />
      <polygon points="17 16 22 18 17 20" fill="currentColor" stroke="none" />
    </svg>
  );
}

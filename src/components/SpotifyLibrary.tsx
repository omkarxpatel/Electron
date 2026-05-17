import { useEffect, useMemo, useRef, useState } from 'react';
import { getSavedAlbums } from '../spotify/api';
import type { SpotifyAlbum, SpotifyImage, SpotifyPlaylist, SpotifyTrack } from '../spotify/types';

type Filter = 'all' | 'playlists' | 'albums';

interface Props {
  playlists: SpotifyPlaylist[];
  playlistsLoading: boolean;
  selectedPlaylistId: string | null;
  onSelectPlaylist: (playlist: SpotifyPlaylist) => void;
  onSelectAlbum: (album: SpotifyAlbum) => void;
  searchTracks: (query: string) => Promise<SpotifyTrack[]>;
  onPlayTrack: (track: SpotifyTrack) => void;
  currentlyPlayingId: string | null;
  onOpenQueue: () => void;
  /** Bumped when the panel opens — used to refetch saved albums on each open. */
  refreshKey: number;
}

function pickMediumImage(images: SpotifyImage[]): string | undefined {
  if (!images || images.length === 0) return undefined;
  return images[1]?.url ?? images[0]?.url;
}

function smallestImage(images: SpotifyImage[]): string | undefined {
  if (!images || images.length === 0) return undefined;
  return images[images.length - 1]?.url;
}

function formatDuration(ms: number): string {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

const SEARCH_DEBOUNCE_MS = 280;

export function SpotifyLibrary({
  playlists,
  playlistsLoading,
  selectedPlaylistId,
  onSelectPlaylist,
  onSelectAlbum,
  searchTracks,
  onPlayTrack,
  currentlyPlayingId,
  onOpenQueue,
  refreshKey,
}: Props) {
  const [filter, setFilter] = useState<Filter>('all');
  const [savedAlbums, setSavedAlbums] = useState<SpotifyAlbum[]>([]);
  const [albumsLoading, setAlbumsLoading] = useState<boolean>(false);

  const [query, setQuery] = useState<string>('');
  const [results, setResults] = useState<SpotifyTrack[]>([]);
  const [searchLoading, setSearchLoading] = useState<boolean>(false);
  const requestIdRef = useRef<number>(0);

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

  // Debounced search — out-of-order responses are guarded by a request-id ref.
  useEffect(() => {
    const q = query.trim();
    if (q.length === 0) {
      requestIdRef.current++;
      setResults([]);
      setSearchLoading(false);
      return;
    }
    setSearchLoading(true);
    const myId = ++requestIdRef.current;
    const timer = window.setTimeout(() => {
      searchTracks(q)
        .then((items) => {
          if (requestIdRef.current !== myId) return;
          setResults(items);
          setSearchLoading(false);
        })
        .catch(() => {
          if (requestIdRef.current !== myId) return;
          setResults([]);
          setSearchLoading(false);
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [query, searchTracks]);

  const isSearching = query.trim().length > 0;

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
            placeholder="What do you want to play?"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
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
        <SearchTrackResults
          results={results}
          loading={searchLoading}
          onPlay={onPlayTrack}
          currentlyPlayingId={currentlyPlayingId}
        />
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

interface SearchTrackResultsProps {
  results: SpotifyTrack[];
  loading: boolean;
  onPlay: (track: SpotifyTrack) => void;
  currentlyPlayingId: string | null;
}

function SearchTrackResults({ results, loading, onPlay, currentlyPlayingId }: SearchTrackResultsProps) {
  if (loading && results.length === 0) {
    return (
      <div className="sp-empty-state">
        <div className="sp-empty-sub">Searching…</div>
      </div>
    );
  }
  if (results.length === 0) {
    return (
      <div className="sp-empty-state">
        <div className="sp-empty-sub">No tracks found.</div>
      </div>
    );
  }
  return (
    <div className="sp-library-scroll">
      <div className="sp-search-header">
        <span>{results.length} track{results.length === 1 ? '' : 's'}</span>
        {loading && <span className="sp-search-spinner">refreshing…</span>}
      </div>
      <table className="sp-track-table sp-search-table">
        <tbody>
          {results.map((track, index) => {
            const thumbUrl = smallestImage(track.album.images);
            const isPlaying = track.id === currentlyPlayingId;
            return (
              <tr
                key={`${track.id}-${index}`}
                className="sp-track-row"
                data-playing={isPlaying ? 'true' : 'false'}
                onClick={() => onPlay(track)}
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
          })}
        </tbody>
      </table>
    </div>
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

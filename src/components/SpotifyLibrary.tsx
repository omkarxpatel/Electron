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
import { ContextMenu, type ContextMenuItem } from './ContextMenu';
import {
  folderPath,
  usePlaylistFolders,
  type ImportSummary,
  type PlaylistFolder,
} from '../state/playlistFolders';
import type { RootlistNode, RootlistResult } from '../types/api';

type Filter = 'all' | 'playlists' | 'albums';

/** Drag payload types. Two of them so a folder can't be dropped into a
 *  playlist tile, and so a drag from outside the app is ignored outright. */
const DRAG_PLAYLIST = 'application/x-av-playlist';
const DRAG_FOLDER = 'application/x-av-folder';

interface Props {
  playlists: SpotifyPlaylist[];
  playlistsLoading: boolean;
  /** Uri the player is playing from, or null. Marks that tile the way
   *  Spotify marks the playing entry in its sidebar. */
  playingContextUri: string | null;
  selectedPlaylistId: string | null;
  onSelectPlaylist: (playlist: SpotifyPlaylist) => void;
  onSelectLikedSongs: () => void;
  /** True when the track list is currently showing Liked Songs. */
  likedSelected: boolean;
  onOpenStats: () => void;
  onCreatePlaylist: (name: string) => Promise<void>;
  onSelectAlbum: (album: SpotifyAlbum) => void;
  onSelectArtist: (artist: SpotifyArtist) => void;
  searchAll: (query: string, signal?: AbortSignal) => Promise<SearchResults>;
  searchMore: (query: string, type: SearchType, offset: number) => Promise<SearchResults>;
  onPlayTrack: (track: SpotifyTrack) => void;
  currentlyPlayingId: string | null;
  onOpenQueue: () => void;
  /** Opens the DJ view — suggestions for what follows what is playing. */
  onOpenDj: () => void;
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
  playingContextUri,
  selectedPlaylistId,
  onSelectPlaylist,
  onSelectLikedSongs,
  likedSelected,
  onOpenStats,
  onCreatePlaylist,
  onSelectAlbum,
  onSelectArtist,
  searchAll,
  searchMore,
  onPlayTrack,
  currentlyPlayingId,
  onOpenQueue,
  onOpenDj,
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

  const folders = usePlaylistFolders();
  /** Which folder the grid is showing. null = top level. */
  const [openFolderId, setOpenFolderId] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; items: ContextMenuItem[] } | null>(
    null,
  );
  /** Folder id currently under a drag, for the drop highlight. */
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  /** Folder whose tile is currently an input. Inline, matching "+ New". */
  const [renamingId, setRenamingId] = useState<string | null>(null);

  // A folder deleted from under us (or a stale id from a previous session)
  // would leave the grid showing a folder that doesn't exist, with a
  // breadcrumb to nowhere and no way back.
  const openFolderExists =
    openFolderId === null || folders.folders.some((f) => f.id === openFolderId);
  useEffect(() => {
    if (!openFolderExists) setOpenFolderId(null);
  }, [openFolderExists]);

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

  /** What the API actually returns. The rootlist names playlists we can't
   *  fetch — Spotify's own `37i9dQZ…` ones — and the import counts those as
   *  unavailable rather than filing rows that open onto nothing. */
  const playlistIds = useMemo(() => new Set(playlists.map((p) => p.id)), [playlists]);

  /**
   * Folders that contain what's playing, anywhere beneath them.
   *
   * Without this the mark is invisible for anyone who files their playlists:
   * the playing one sits inside a folder, so the top level shows nothing at
   * all. Spotify has no equivalent because its sidebar is flat.
   */
  const playingFolderIds = useMemo(() => {
    const id = playingContextUri?.startsWith('spotify:playlist:')
      ? (playingContextUri.split(':').pop() ?? '')
      : '';
    const folderId = id ? folders.assignments[id] : undefined;
    if (!folderId) return new Set<string>();
    return new Set(folderPath(folders.folders, folderId).map((f) => f.id));
  }, [playingContextUri, folders.assignments, folders.folders]);

  /** Sub-folders of the open folder. Hidden under the Albums filter — a
   *  folder only ever holds playlists, so it would always read as empty. */
  const visibleFolders = useMemo(
    () => (filter === 'albums' ? [] : folders.childFolders(openFolderId)),
    [filter, folders, openFolderId],
  );

  const filteredItems = useMemo(() => {
    const items: Array<
      | { kind: 'playlist'; item: SpotifyPlaylist }
      | { kind: 'album'; item: SpotifyAlbum }
    > = [];
    if (filter !== 'albums') {
      for (const p of playlists) {
        if ((folders.assignments[p.id] ?? null) === openFolderId) {
          items.push({ kind: 'playlist', item: p });
        }
      }
    }
    // Albums can't be filed, so they belong to the top level only. Repeating
    // them inside every folder would make each one look like it held the
    // whole album library.
    if (filter !== 'playlists' && openFolderId === null) {
      for (const a of savedAlbums) items.push({ kind: 'album', item: a });
    }
    return items;
  }, [filter, playlists, savedAlbums, folders.assignments, openFolderId]);

  const breadcrumb = useMemo(
    () => folderPath(folders.folders, openFolderId),
    [folders.folders, openFolderId],
  );

  /** Every folder as a "Parent / Child" label, so the move list stays
   *  unambiguous when two folders share a name at different depths. */
  const folderChoices = useMemo(
    () =>
      folders.folders
        .map((f) => ({
          id: f.id,
          label: folderPath(folders.folders, f.id)
            .map((p) => p.name)
            .join(' / '),
        }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    [folders.folders],
  );

  const openPlaylistMenu = useCallback(
    (e: React.MouseEvent, playlist: SpotifyPlaylist) => {
      e.preventDefault();
      const current = folders.assignments[playlist.id] ?? null;
      const items: ContextMenuItem[] = [
        {
          label: 'Move to folder…',
          submenu: {
            filterPlaceholder: 'Find a folder…',
            emptyLabel: 'No folders yet',
            items: [
              {
                label: 'Top level',
                disabled: current === null,
                onClick: () => folders.assignPlaylist(playlist.id, null),
              },
              ...folderChoices.map((c) => ({
                label: c.label,
                disabled: c.id === current,
                onClick: () => folders.assignPlaylist(playlist.id, c.id),
              })),
            ],
          },
        },
      ];
      setMenu({ x: e.clientX, y: e.clientY, items });
    },
    [folders, folderChoices],
  );

  const openFolderMenu = useCallback(
    (e: React.MouseEvent, folder: PlaylistFolder) => {
      e.preventDefault();
      // A folder can't be moved into itself or anything it contains — that
      // detaches the branch from the root and it disappears from every view.
      const banned = new Set<string>([folder.id]);
      let grew = true;
      while (grew) {
        grew = false;
        for (const f of folders.folders) {
          if (f.parentId && banned.has(f.parentId) && !banned.has(f.id)) {
            banned.add(f.id);
            grew = true;
          }
        }
      }
      setMenu({
        x: e.clientX,
        y: e.clientY,
        items: [
          { label: 'Open', onClick: () => setOpenFolderId(folder.id) },
          { label: 'Rename…', onClick: () => setRenamingId(folder.id) },
          {
            label: 'Move to…',
            submenu: {
              filterPlaceholder: 'Find a folder…',
              emptyLabel: 'Nowhere to move it',
              items: [
                {
                  label: 'Top level',
                  disabled: folder.parentId === null,
                  onClick: () => folders.moveFolder(folder.id, null),
                },
                ...folderChoices
                  .filter((c) => !banned.has(c.id))
                  .map((c) => ({
                    label: c.label,
                    disabled: c.id === folder.parentId,
                    onClick: () => folders.moveFolder(folder.id, c.id),
                  })),
              ],
            },
          },
          {
            label: 'Delete folder',
            separator: true,
            title: 'Playlists inside move up a level — nothing is removed from Spotify',
            onClick: () => folders.deleteFolder(folder.id),
          },
        ],
      });
    },
    [folders, folderChoices],
  );

  /** Shared by folder tiles and the breadcrumb, which are both drop targets. */
  const handleDrop = useCallback(
    (e: React.DragEvent, folderId: string | null) => {
      e.preventDefault();
      setDropTarget(null);
      const playlistId = e.dataTransfer.getData(DRAG_PLAYLIST);
      if (playlistId) {
        folders.assignPlaylist(playlistId, folderId);
        return;
      }
      const draggedFolder = e.dataTransfer.getData(DRAG_FOLDER);
      if (draggedFolder) folders.moveFolder(draggedFolder, folderId);
    },
    [folders],
  );

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
        <button
          type="button"
          className="sp-library-queue-btn"
          onClick={onOpenDj}
          aria-label="Open DJ suggestions"
          title="What should follow this?"
        >
          <span>DJ</span>
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
          {/* Pinned above the filters rather than mixed into the grid: these
              two aren't playlists or albums, so no filter pill should ever
              hide them. Inside a folder the breadcrumb takes the slot —
              Liked Songs and Stats aren't in the folder you opened, and
              leaving them there reads as though they were. */}
          {openFolderId !== null ? (
            <div className="sp-library-crumbs">
              <button
                type="button"
                className="sp-library-crumb"
                data-drop={dropTarget === '__root__' ? 'true' : 'false'}
                onClick={() => setOpenFolderId(null)}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDropTarget('__root__');
                }}
                onDragLeave={() => setDropTarget(null)}
                onDrop={(e) => handleDrop(e, null)}
              >
                Library
              </button>
              {breadcrumb.map((f, i) => {
                const last = i === breadcrumb.length - 1;
                return (
                  <span key={f.id} className="sp-library-crumb-group">
                    <span className="sp-library-crumb-sep" aria-hidden>
                      ›
                    </span>
                    <button
                      type="button"
                      className="sp-library-crumb"
                      data-current={last ? 'true' : 'false'}
                      data-drop={dropTarget === f.id ? 'true' : 'false'}
                      aria-current={last ? 'page' : undefined}
                      onClick={() => setOpenFolderId(f.id)}
                      onContextMenu={(e) => openFolderMenu(e, f)}
                      onDragOver={(e) => {
                        e.preventDefault();
                        setDropTarget(f.id);
                      }}
                      onDragLeave={() => setDropTarget(null)}
                      onDrop={(e) => handleDrop(e, f.id)}
                    >
                      {f.name}
                    </button>
                  </span>
                );
              })}
            </div>
          ) : (
          <div className="sp-library-pinned">
            <button
              type="button"
              className="sp-library-pinned-btn"
              data-selected={likedSelected ? 'true' : 'false'}
              onClick={onSelectLikedSongs}
            >
              <span className="sp-library-pinned-icon sp-liked-cover" aria-hidden>
                <IconHeartSmall />
              </span>
              <span className="sp-library-pinned-text">
                <span className="sp-library-pinned-title">Liked Songs</span>
                <span className="sp-library-pinned-sub">Everything you've saved</span>
              </span>
            </button>
            <button
              type="button"
              className="sp-library-pinned-btn"
              onClick={onOpenStats}
            >
              <span className="sp-library-pinned-icon sp-stats-cover" aria-hidden>
                <IconStats />
              </span>
              <span className="sp-library-pinned-text">
                <span className="sp-library-pinned-title">Your Stats</span>
                <span className="sp-library-pinned-sub">Top tracks, artists & movement</span>
              </span>
            </button>
          </div>
          )}

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
            <NewPlaylistButton onCreate={onCreatePlaylist} />
            {filter !== 'albums' && (
              <InlineNameButton
                label="+ Folder"
                title={
                  openFolderId === null
                    ? 'Create a folder'
                    : `Create a folder inside ${breadcrumb[breadcrumb.length - 1]?.name ?? ''}`
                }
                placeholder="Folder name"
                // Creates inside whatever folder is open, which is what the
                // breadcrumb already implies. A separate "new subfolder"
                // affordance would say the same thing twice.
                onCommit={(name) => folders.createFolder(name, openFolderId)}
              />
            )}
            {/* Stays available rather than vanishing after the first run:
                the import is additive and matches folders by name, so a
                second pass picks up folders made in Spotify since. */}
            {openFolderId === null && filter !== 'albums' && (
              <ImportFoldersButton playlistIds={playlistIds} onImport={folders.importRootlist} />
            )}
          </div>

          <div className="sp-library-scroll">
            {(playlistsLoading || albumsLoading) &&
            filteredItems.length === 0 &&
            visibleFolders.length === 0 ? (
              <div className="sp-empty-state">
                <div className="sp-empty-sub">Loading your library…</div>
              </div>
            ) : filteredItems.length === 0 && visibleFolders.length === 0 ? (
              <div className="sp-empty-state">
                <div className="sp-empty-title">
                  {openFolderId !== null ? 'This folder is empty' : 'Nothing here yet'}
                </div>
                <div className="sp-empty-sub">
                  {openFolderId !== null
                    ? 'Drag playlists onto a folder, or right-click one and pick Move to folder.'
                    : filter === 'albums'
                      ? "Save an album in Spotify and it'll show up here."
                      : filter === 'playlists'
                        ? "Follow a playlist and it'll show up here."
                        : 'Save albums or playlists in Spotify to fill your library.'}
                </div>
              </div>
            ) : (
              <div className="sp-library-grid">
                {/* Folders first, so opening one never means hunting for it
                    among a few dozen playlist tiles. */}
                {visibleFolders.map((f) => (
                  <FolderTile
                    key={`f-${f.id}`}
                    folder={f}
                    count={countIn(folders.assignments, folders.folders, f.id)}
                    playing={playingFolderIds.has(f.id)}
                    renaming={renamingId === f.id}
                    dropping={dropTarget === f.id}
                    onOpen={() => setOpenFolderId(f.id)}
                    onRename={(name) => {
                      folders.renameFolder(f.id, name);
                      setRenamingId(null);
                    }}
                    onCancelRename={() => setRenamingId(null)}
                    onContextMenu={(e) => openFolderMenu(e, f)}
                    onDragStart={(e) => {
                      e.dataTransfer.setData(DRAG_FOLDER, f.id);
                      e.dataTransfer.effectAllowed = 'move';
                    }}
                    onDragOver={(e) => {
                      e.preventDefault();
                      setDropTarget(f.id);
                    }}
                    onDragLeave={() => setDropTarget(null)}
                    onDrop={(e) => handleDrop(e, f.id)}
                  />
                ))}
                {filteredItems.map((entry) =>
                  entry.kind === 'playlist' ? (
                    <PlaylistTile
                      key={`p-${entry.item.id}`}
                      playlist={entry.item}
                      selected={entry.item.id === selectedPlaylistId}
                      playing={entry.item.uri === playingContextUri}
                      onClick={() => onSelectPlaylist(entry.item)}
                      onContextMenu={(e) => openPlaylistMenu(e, entry.item)}
                      onDragStart={(e) => {
                        e.dataTransfer.setData(DRAG_PLAYLIST, entry.item.id);
                        e.dataTransfer.effectAllowed = 'move';
                      }}
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
      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />
      )}
    </div>
  );
}

/** How many playlists sit anywhere beneath a folder. The tile shows the
 *  whole subtree, not just direct children — a folder holding only folders
 *  would otherwise read "0 playlists" while plainly containing plenty. */
function countIn(
  assignments: Record<string, string>,
  folders: PlaylistFolder[],
  rootId: string,
): number {
  const ids = new Set<string>([rootId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const f of folders) {
      if (f.parentId && ids.has(f.parentId) && !ids.has(f.id)) {
        ids.add(f.id);
        grew = true;
      }
    }
  }
  let n = 0;
  for (const folderId of Object.values(assignments)) if (ids.has(folderId)) n += 1;
  return n;
}

interface FolderTileProps {
  folder: PlaylistFolder;
  count: number;
  /** Something beneath this folder is what's playing. */
  playing: boolean;
  renaming: boolean;
  dropping: boolean;
  onOpen: () => void;
  onRename: (name: string) => void;
  onCancelRename: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
  onDragStart: (e: React.DragEvent) => void;
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: () => void;
  onDrop: (e: React.DragEvent) => void;
}

function FolderTile({
  folder,
  count,
  playing,
  renaming,
  dropping,
  onOpen,
  onRename,
  onCancelRename,
  onContextMenu,
  onDragStart,
  onDragOver,
  onDragLeave,
  onDrop,
}: FolderTileProps) {
  const [draft, setDraft] = useState(folder.name);

  // Reset the draft whenever the tile re-enters rename mode, so a cancelled
  // edit doesn't come back the next time it's opened.
  useEffect(() => {
    if (renaming) setDraft(folder.name);
  }, [renaming, folder.name]);

  if (renaming) {
    return (
      <div className="sp-library-tile sp-library-folder-tile">
        <div className="sp-library-tile-cover sp-library-folder-cover" aria-hidden>
          <IconFolder />
        </div>
        <input
          className="sp-library-new-input sp-library-folder-rename"
          value={draft}
          autoFocus
          spellCheck={false}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => onRename(draft)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onRename(draft);
            if (e.key === 'Escape') onCancelRename();
          }}
          aria-label="Folder name"
        />
      </div>
    );
  }

  return (
    <button
      type="button"
      className="sp-library-tile sp-library-folder-tile"
      data-drop={dropping ? 'true' : 'false'}
      data-playing={playing ? 'true' : 'false'}
      onClick={onOpen}
      onContextMenu={onContextMenu}
      draggable
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      title={
        playing
          ? `${folder.name} — ${count} playlist${count === 1 ? '' : 's'} (playing from this folder)`
          : `${folder.name} — ${count} playlist${count === 1 ? '' : 's'}`
      }
    >
      <div className="sp-library-tile-cover sp-library-folder-cover">
        <IconFolder />
        {playing && <EqualizerMark />}
      </div>
      <div className="sp-library-tile-name">{folder.name}</div>
      <div className="sp-library-tile-meta">
        Folder · {count} playlist{count === 1 ? '' : 's'}
      </div>
    </button>
  );
}

function IconFolder() {
  return (
    <svg viewBox="0 0 24 24" width="34" height="34" fill="currentColor" aria-hidden>
      <path d="M4 5h5.2l1.6 2H20a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z" />
    </svg>
  );
}

/**
 * Seeds local folders from the Spotify desktop app's cache.
 *
 * Deliberately says where it reads from. There is no API for folders, so
 * this parses Spotify's own on-disk format — which will break whenever
 * Spotify changes it. The failure is harmless (nothing is written, you file
 * by hand instead), but a button that just said "Import" would leave someone
 * wondering why it stopped working one day.
 */
function ImportFoldersButton({
  playlistIds,
  onImport,
}: {
  playlistIds: Set<string>;
  onImport: (nodes: RootlistNode[], known: Set<string>) => ImportSummary;
}) {
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = useCallback(() => {
    if (busy) return;
    setBusy(true);
    setStatus(null);
    void window.api.spotifyFolders
      .read()
      .then((result: RootlistResult) => {
        if (result.kind === 'unavailable') {
          setStatus(
            result.reason === 'no-cache'
              ? "No Spotify desktop app found on this Mac — that's where folders live."
              : result.reason === 'no-rootlist'
                ? "Spotify hasn't cached your folders yet. Open it, then try again."
                : "Couldn't read Spotify's folder cache — its format has probably changed.",
          );
          return;
        }
        const summary = onImport(result.nodes, playlistIds);
        const parts = [
          `Imported ${summary.foldersCreated} folder${summary.foldersCreated === 1 ? '' : 's'}`,
          `${summary.playlistsFiled} playlist${summary.playlistsFiled === 1 ? '' : 's'} filed`,
        ];
        // Named rather than hidden: these are Spotify's own algorithmic
        // playlists, which third-party apps lost access to in Feb 2026. The
        // folders arrive looking short and the reason isn't guessable.
        if (summary.unavailable > 0) {
          parts.push(`${summary.unavailable} skipped (Spotify-made, not available to apps)`);
        }
        setStatus(`${parts.join(' · ')}.`);
      })
      .catch((err: unknown) => {
        console.error('importFolders failed:', err);
        setStatus("Couldn't read Spotify's folder cache.");
      })
      .finally(() => setBusy(false));
  }, [busy, onImport, playlistIds]);

  return (
    <>
      <button
        type="button"
        className="sp-library-new-btn"
        onClick={run}
        disabled={busy}
        title="Read your folder structure from the Spotify desktop app on this Mac"
      >
        {busy ? 'Importing…' : 'Import from Spotify'}
      </button>
      {status && <span className="sp-library-import-status">{status}</span>}
    </>
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
  /** This playlist is what the player is playing from. */
  playing: boolean;
  onClick: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
  onDragStart: (e: React.DragEvent) => void;
}

function PlaylistTile({
  playlist,
  selected,
  playing,
  onClick,
  onContextMenu,
  onDragStart,
}: PlaylistTileProps) {
  const coverUrl = pickMediumImage(playlist.images);
  const ownerLabel = playlist.owner.display_name ?? playlist.owner.id;
  return (
    <button
      type="button"
      className="sp-library-tile"
      data-selected={selected ? 'true' : 'false'}
      data-playing={playing ? 'true' : 'false'}
      onClick={onClick}
      onContextMenu={onContextMenu}
      draggable
      onDragStart={onDragStart}
      title={
        playing
          ? `${playlist.name} — ${ownerLabel} (playing)`
          : `${playlist.name} — ${ownerLabel}`
      }
    >
      <span className="sp-library-tile-art">
        {coverUrl ? (
          <img className="sp-library-tile-cover" src={coverUrl} alt="" loading="lazy" draggable={false} />
        ) : (
          <span className="sp-library-tile-cover sp-library-tile-cover-fallback" />
        )}
        {playing && <EqualizerMark />}
      </span>
      <div className="sp-library-tile-name">{playlist.name}</div>
      <div className="sp-library-tile-meta">Playlist · {ownerLabel}</div>
    </button>
  );
}

/**
 * The "this is what's playing" mark, as Spotify puts on the playing entry in
 * its sidebar. Three bars rather than a speaker glyph: at tile size the
 * motion is what reads, and a static icon on a busy cover just looks like
 * part of the artwork.
 *
 * `aria-label` rather than a title, because the tile's own title already
 * says "(playing)" and two tooltips on one control fight each other.
 */
function EqualizerMark() {
  return (
    <span className="sp-playing-mark" role="img" aria-label="Playing">
      <i />
      <i />
      <i />
    </span>
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

/** Inline name entry rather than a dialog — one field, and the playlist
 *  opens as soon as it exists, so a modal would be in the way. */
function NewPlaylistButton({ onCreate }: { onCreate: (name: string) => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  const commit = useCallback(() => {
    const trimmed = name.trim();
    setEditing(false);
    setName('');
    if (!trimmed || busy) return;
    setBusy(true);
    void onCreate(trimmed)
      .catch((err: unknown) => console.error('createPlaylist failed:', err))
      .finally(() => setBusy(false));
  }, [name, busy, onCreate]);

  if (!editing) {
    return (
      <button
        type="button"
        className="sp-library-new-btn"
        onClick={() => setEditing(true)}
        title="Create a new playlist"
      >
        + New
      </button>
    );
  }
  return (
    <input
      className="sp-library-new-input"
      value={name}
      autoFocus
      spellCheck={false}
      placeholder="Playlist name…"
      onChange={(e) => setName(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit();
        if (e.key === 'Escape') {
          setEditing(false);
          setName('');
        }
      }}
      aria-label="New playlist name"
    />
  );
}

/** The same inline-entry shape as NewPlaylistButton, for things that are
 *  created locally and so resolve synchronously — no busy state to hold. */
function InlineNameButton({
  label,
  title,
  placeholder,
  onCommit,
}: {
  label: string;
  title: string;
  placeholder: string;
  onCommit: (name: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState('');

  const commit = useCallback(() => {
    const trimmed = name.trim();
    setEditing(false);
    setName('');
    if (trimmed) onCommit(trimmed);
  }, [name, onCommit]);

  if (!editing) {
    return (
      <button
        type="button"
        className="sp-library-new-btn"
        onClick={() => setEditing(true)}
        title={title}
      >
        {label}
      </button>
    );
  }
  return (
    <input
      className="sp-library-new-input"
      value={name}
      autoFocus
      spellCheck={false}
      placeholder={placeholder}
      onChange={(e) => setName(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit();
        if (e.key === 'Escape') {
          setEditing(false);
          setName('');
        }
      }}
      aria-label={placeholder}
    />
  );
}

function IconHeartSmall() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M12 21s-7.5-4.7-9.3-9A5.3 5.3 0 0 1 12 6.6 5.3 5.3 0 0 1 21.3 12c-1.8 4.3-9.3 9-9.3 9z"
        fill="currentColor"
      />
    </svg>
  );
}

function IconStats() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
      <rect x="3" y="12" width="4" height="9" rx="1" fill="currentColor" />
      <rect x="10" y="7" width="4" height="14" rx="1" fill="currentColor" />
      <rect x="17" y="3" width="4" height="18" rx="1" fill="currentColor" />
    </svg>
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

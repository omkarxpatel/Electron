import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRenderCount } from '../perf';
import type { SpotifyPlaylist, SpotifyTrack } from '../spotify/types';
import { sourceKey, type TrackSource } from '../spotify/useSpotify';
import { formatDuration } from '../shared/format';
import { smallestImage } from '../shared/image';
import { ContextMenu, type ContextMenuItem } from './ContextMenu';
import { addToQueue, canEditPlaylist, isMissingScopeError } from '../spotify/api';

interface Props {
  /** What to show: a playlist, Liked Songs, or nothing picked yet. */
  source: TrackSource | null;
  tracks: SpotifyTrack[];
  /** Server-side total for the source, which can exceed `tracks.length`
   *  while pages are still being loaded. */
  tracksTotal: number;
  loading: boolean;
  currentlyPlayingId: string | null;
  onPlay: (track: SpotifyTrack, contextUri?: string) => void;
  /** Play an explicit URI run — Liked Songs has no context URI. */
  onPlayTracks: (uris: string[]) => void;
  onLoadMore: () => void;
  hasMore: boolean;
  /** Raw playlist position paged through so far, or null once everything is
   *  loaded. Needed to tell whether row indices match Spotify's positions. */
  rawLoadedThrough: number | null;
  /** Player shuffle state. Decides where the header Play button starts. */
  shuffle: boolean;
  /** Every playlist we know about; the row menu offers the writable ones as
   *  "Add to playlist" targets. */
  playlists: SpotifyPlaylist[];
  /** Signed-in user's id — decides which of those are writable. */
  userId: string | null;
  onAddToPlaylist: (playlistId: string, track: SpotifyTrack) => Promise<void>;
  /** Removes from whichever source is open (playlist row, or unlike). */
  onRemoveFromSource: (track: SpotifyTrack) => Promise<void>;
  onGoToAlbum: (track: SpotifyTrack) => void;
  onRenamePlaylist: (playlistId: string, name: string) => Promise<void>;
  onDeletePlaylist: (playlist: SpotifyPlaylist) => Promise<void>;
  onMoveTrack: (from: number, to: number) => Promise<void>;
}

/** How long a row-menu result stays on screen. */
const NOTICE_MS = 2600;

interface MenuState {
  x: number;
  y: number;
  track: SpotifyTrack;
}

export const SpotifyTrackList = memo(SpotifyTrackListImpl);

function SpotifyTrackListImpl({
  source,
  tracks,
  tracksTotal,
  loading,
  currentlyPlayingId,
  onPlay,
  onPlayTracks,
  onLoadMore,
  hasMore,
  rawLoadedThrough,
  shuffle,
  playlists,
  userId,
  onAddToPlaylist,
  onRemoveFromSource,
  onGoToAlbum,
  onRenamePlaylist,
  onDeletePlaylist,
  onMoveTrack,
}: Props) {
  useRenderCount('SpotifyTrackList');
  const scrollRef = useRef<HTMLDivElement>(null);
  // RAF-throttle the scroll handler. Without this, fast scrolls fire onScroll
  // dozens of times per frame, each forcing a layout read (scrollHeight,
  // scrollTop, clientHeight) — a measurable per-event cost on long lists.
  const scrollRafRef = useRef<number | null>(null);

  const scheduleScrollCheck = useCallback(() => {
    if (scrollRafRef.current !== null) return;
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRafRef.current = null;
      const el = scrollRef.current;
      if (!el || loading || !hasMore) return;
      const threshold = 300;
      if (el.scrollHeight - el.scrollTop - el.clientHeight < threshold) {
        onLoadMore();
      }
    });
  }, [loading, hasMore, onLoadMore]);

  useEffect(() => {
    return () => {
      if (scrollRafRef.current !== null) {
        cancelAnimationFrame(scrollRafRef.current);
        scrollRafRef.current = null;
      }
    };
  }, []);

  // ── ⌘F: filter the loaded rows ──────────────────────────────────────────
  // Deliberately a filter over what's already loaded, not a Spotify search.
  // It answers "where is that song in this playlist", and going to the API
  // for that would return songs that aren't in the playlist at all.
  const [filterOpen, setFilterOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const filterInputRef = useRef<HTMLInputElement>(null);

  const closeFilter = useCallback(() => {
    setFilterOpen(false);
    setFilter('');
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        setFilterOpen(true);
        // Already open: re-focus and select so a second ⌘F starts a new query
        // rather than appending to the old one.
        filterInputRef.current?.select();
        return;
      }
      if (e.key === 'Escape' && filterOpen) closeFilter();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [filterOpen, closeFilter]);

  useEffect(() => {
    if (filterOpen) filterInputRef.current?.focus();
  }, [filterOpen]);

  // Switching source drops a filter that no longer refers to anything.
  useEffect(() => {
    closeFilter();
  }, [source, closeFilter]);

  const activeSourceKey = sourceKey(source);

  const visibleTracks = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return tracks;
    return tracks.filter(
      (t) =>
        t.name.toLowerCase().includes(q) ||
        t.artists.some((a) => a.name.toLowerCase().includes(q)) ||
        t.album.name.toLowerCase().includes(q),
    );
  }, [tracks, filter]);

  // Infinite scroll has to keep working while filtered: a query matching
  // nothing in the loaded pages should pull more pages rather than sit on an
  // empty list, since the match may simply not be loaded yet.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || loading || !hasMore) return;
    if (el.scrollHeight <= el.clientHeight + 50) {
      onLoadMore();
    }
  }, [visibleTracks.length, loading, hasMore, onLoadMore]);

  // ── Playback ────────────────────────────────────────────────────────────
  const contextUri = source?.kind === 'playlist' ? source.playlist.uri : undefined;

  const playFrom = useCallback(
    (track: SpotifyTrack) => {
      if (contextUri) {
        onPlay(track, contextUri);
        return;
      }
      // Liked Songs: no context to hand Spotify, so send the run of URIs
      // from here on instead — otherwise playback stops after one song.
      const start = tracks.findIndex((t) => t.uri === track.uri);
      onPlayTracks(tracks.slice(start < 0 ? 0 : start).map((t) => t.uri));
    },
    [contextUri, onPlay, onPlayTracks, tracks],
  );

  // Stable per-row play handler. Each TrackRow needs a *stable* callback
  // (otherwise React.memo wouldn't help — a fresh closure on every parent
  // render would invalidate the memo). The row passes its own track back so
  // we don't need to capture index in the closure.
  const handlePlayTrack = useCallback((track: SpotifyTrack) => playFrom(track), [playFrom]);

  // With shuffle on, start somewhere random rather than on track 1. Handing
  // Spotify no offset at all and letting its own shuffle choose would be
  // tidier, but it isn't dependable — a shuffled context still tends to open
  // on the first track, which is the thing this is meant to avoid.
  // The draw is over the tracks loaded so far, so on a long list it favours
  // the earlier pages until you've scrolled further in.
  const handlePlayAll = useCallback(() => {
    if (tracks.length === 0) return;
    playFrom(shuffle ? tracks[Math.floor(Math.random() * tracks.length)] : tracks[0]);
  }, [playFrom, tracks, shuffle]);

  // Transient result line for the row-menu actions. Writes that fail
  // silently are the worst outcome here: the user's next move would be to
  // open Spotify to check, which is what this menu exists to avoid.
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimerRef = useRef<number | null>(null);
  const showNotice = useCallback((text: string) => {
    setNotice(text);
    if (noticeTimerRef.current !== null) window.clearTimeout(noticeTimerRef.current);
    noticeTimerRef.current = window.setTimeout(() => {
      setNotice(null);
      noticeTimerRef.current = null;
    }, NOTICE_MS);
  }, []);
  useEffect(() => {
    return () => {
      if (noticeTimerRef.current !== null) window.clearTimeout(noticeTimerRef.current);
    };
  }, []);

  // ── Drag to reorder ─────────────────────────────────────────────────────
  /**
   * Whether a row's index in `tracks` equals its position in the playlist as
   * Spotify holds it.
   *
   * Null entries — removed or local-only tracks — are dropped on read, so
   * once one exists earlier in the list every later row is offset and the
   * reorder endpoint would move the wrong song. The loaded raw span is
   * exactly `tracksNextOffset` (or the total, once fully paged), so the two
   * agreeing means nothing was dropped.
   */
  const positionsAreExact = tracks.length === (rawLoadedThrough ?? tracksTotal);

  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);

  const canReorder =
    source?.kind === 'playlist' &&
    canEditPlaylist(source.playlist, userId) &&
    positionsAreExact &&
    filter.trim().length === 0;

  const cancelDrag = useCallback(() => {
    setDragFrom(null);
    setDragOver(null);
  }, []);

  const handleDrop = useCallback(
    (to: number) => {
      const from = dragFrom;
      setDragFrom(null);
      setDragOver(null);
      if (from === null || from === to) return;
      void onMoveTrack(from, to).catch((err: unknown) => {
        console.error('reorder failed:', err);
        showNotice('Spotify rejected that move — nothing changed');
      });
    },
    [dragFrom, onMoveTrack, showNotice],
  );

  // ── Row context menu ────────────────────────────────────────────────────
  // State lives here so closing the menu doesn't re-render every row.
  const [menu, setMenu] = useState<MenuState | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const handleRowContextMenu = useCallback((track: SpotifyTrack, e: React.MouseEvent) => {
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY, track });
  }, []);

  const runEdit = useCallback(
    (okText: string, fn: () => Promise<void>) => {
      void fn().then(
        () => showNotice(okText),
        (err: unknown) => {
          console.error('playlist edit failed:', err);
          // A missing scope never resolves by retrying — the token was issued
          // before playlist-modify-* was requested, so say what actually
          // fixes it instead of showing a generic failure.
          showNotice(
            isMissingScopeError(err)
              ? 'Reconnect Spotify in Settings to allow playlist edits'
              : 'Spotify rejected that — nothing changed',
          );
        },
      );
    },
    [showNotice],
  );

  const menuItems = useMemo<ContextMenuItem[]>(() => {
    if (!menu) return [];
    const track = menu.track;

    const targets: ContextMenuItem[] = playlists
      .filter((p) => canEditPlaylist(p, userId))
      .map((p) => ({
        label: p.name,
        onClick: () => runEdit(`Added to ${p.name}`, () => onAddToPlaylist(p.id, track)),
      }));

    // Spotify's playlist remove ignores the position you pass and deletes
    // every copy of the URI, so the label has to say so when we can see
    // duplicates. Only the loaded span is countable — further copies may lurk
    // past it, which is why the singular wording claims nothing about "just
    // this one". Liked Songs can't hold duplicates at all.
    const copies = tracks.filter((t) => t.uri === track.uri).length;
    const liked = source?.kind === 'liked';
    const editable = liked || (source ? canEditPlaylist(source.playlist, userId) : false);
    const removeLabel = liked
      ? 'Remove from Liked Songs'
      : copies > 1
        ? `Remove all ${copies} copies from this playlist`
        : 'Remove from this playlist';

    return [
      {
        label: 'Add to playlist',
        submenu: {
          items: targets,
          filterPlaceholder: 'Find a playlist',
          emptyLabel: userId ? 'No playlists you can edit' : 'Loading your playlists…',
        },
      },
      {
        label: removeLabel,
        disabled: !editable,
        title: editable ? undefined : 'You can only edit playlists you own or collaborate on',
        onClick: () =>
          runEdit(liked ? 'Removed from Liked Songs' : 'Removed', () =>
            onRemoveFromSource(track),
          ),
      },
      {
        label: 'Add to queue',
        onClick: () => {
          void addToQueue(track.uri).catch((err) => {
            console.error('addToQueue failed:', err);
          });
        },
      },
      {
        separator: true,
        label: 'Go to album',
        onClick: () => onGoToAlbum(track),
      },
      {
        label: 'Copy Spotify link',
        onClick: () => {
          void navigator.clipboard
            .writeText(`https://open.spotify.com/track/${track.id}`)
            .then(() => showNotice('Link copied'))
            .catch((err) => console.error('clipboard write failed:', err));
        },
      },
    ];
  }, [
    menu,
    tracks,
    source,
    playlists,
    userId,
    runEdit,
    onAddToPlaylist,
    onRemoveFromSource,
    onGoToAlbum,
    showNotice,
  ]);

  // Precompute artist-name strings once per track so the row component can
  // skip re-doing the same map+join on every render.
  const artistStrings = useMemo(
    () => visibleTracks.map((t) => t.artists.map((a) => a.name).join(', ')),
    [visibleTracks],
  );

  if (source === null) {
    return (
      <div className="sp-track-view">
        <div className="sp-empty-state">
          <div className="sp-empty-title">Pick a playlist</div>
          <div className="sp-empty-sub">
            Choose one from the sidebar, or open your Liked Songs.
          </div>
        </div>
      </div>
    );
  }

  const filtering = filter.trim().length > 0;

  return (
    <div className="sp-track-view">
      {source.kind === 'liked' ? (
        <LikedHeader total={tracksTotal} onPlay={handlePlayAll} canPlay={tracks.length > 0} shuffle={shuffle} />
      ) : (
        <PlaylistHeader
          playlist={source.playlist}
          onPlay={handlePlayAll}
          canPlay={tracks.length > 0}
          shuffle={shuffle}
          editable={canEditPlaylist(source.playlist, userId)}
          onRename={onRenamePlaylist}
          onDelete={onDeletePlaylist}
          onNotice={showNotice}
        />
      )}

      {filterOpen && (
        <div className="sp-track-filter">
          <input
            ref={filterInputRef}
            className="sp-track-filter-input"
            type="text"
            value={filter}
            spellCheck={false}
            placeholder="Filter loaded songs…"
            onChange={(e) => setFilter(e.target.value)}
          />
          <span className="sp-track-filter-count">
            {filtering ? `${visibleTracks.length} of ${tracks.length}` : `${tracks.length} loaded`}
          </span>
          <button
            type="button"
            className="sp-track-filter-close"
            onClick={closeFilter}
            aria-label="Close filter"
          >
            ✕
          </button>
        </div>
      )}

      {loading && tracks.length === 0 ? (
        <div className="sp-empty-state">
          <div className="sp-empty-sub">Loading tracks…</div>
        </div>
      ) : visibleTracks.length === 0 ? (
        <div className="sp-empty-state">
          <div className="sp-empty-sub">
            {filtering
              ? `Nothing loaded matches “${filter.trim()}”.`
              : source.kind === 'liked'
                ? "You haven't liked any songs yet."
                : 'No tracks in this playlist.'}
          </div>
        </div>
      ) : (
        // Keyed on the source so switching playlists mounts a fresh scroll
        // container, the way LyricsPane keys on track.id. Resetting scrollTop
        // from an effect does not work here: openSource clears `tracks` and
        // sets `tracksLoading` in the same update as `source`, so the render
        // right after a switch takes the "Loading tracks…" branch and the
        // scroll div isn't mounted — the effect runs against a null ref. React
        // then reconciles the loading div and this one as the same element
        // type in the same position, reuses the DOM node, and its scrollTop
        // rides along into the new playlist.
        <div
          key={activeSourceKey ?? 'none'}
          className="sp-track-scroll"
          ref={scrollRef}
          onScroll={scheduleScrollCheck}
        >
          <table className="sp-track-table">
            <tbody>
              {visibleTracks.map((track, index) => (
                <TrackRow
                  key={`${track.id}-${index}`}
                  track={track}
                  index={index}
                  artistNames={artistStrings[index]}
                  isPlaying={track.id === currentlyPlayingId}
                  onPlay={handlePlayTrack}
                  onContextMenu={handleRowContextMenu}
                  draggable={canReorder}
                  dragging={dragFrom === index}
                  dropTarget={dragOver === index}
                  onDragStart={setDragFrom}
                  onDragOver={setDragOver}
                  onDrop={handleDrop}
                  onDragEnd={cancelDrag}
                />
              ))}
            </tbody>
          </table>
          {loading && tracks.length > 0 && (
            <div className="sp-track-loading-more">Loading more tracks…</div>
          )}
          {!hasMore && tracks.length > 0 && !filtering && (
            <div className="sp-track-loading-more sp-track-end">— end of list —</div>
          )}
        </div>
      )}

      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={closeMenu} />}

      {notice && (
        <div className="sp-track-notice" role="status">
          {notice}
        </div>
      )}
    </div>
  );
}

interface HeaderProps {
  onPlay: () => void;
  canPlay: boolean;
  shuffle: boolean;
}

function PlaylistHeader({
  playlist,
  onPlay,
  canPlay,
  shuffle,
  editable,
  onRename,
  onDelete,
  onNotice,
}: HeaderProps & {
  playlist: SpotifyPlaylist;
  editable: boolean;
  onRename: (playlistId: string, name: string) => Promise<void>;
  onDelete: (playlist: SpotifyPlaylist) => Promise<void>;
  onNotice: (text: string) => void;
}) {
  const coverUrl = playlist.images[0]?.url;
  // Absent for playlists the user doesn't own, on either side of the Feb 2026
  // field rename — show no count rather than claiming zero.
  const trackTotal = playlist.items?.total ?? playlist.tracks?.total;

  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(playlist.name);
  // Two-step delete rather than a confirm() dialog: unfollowing is how
  // Spotify deletes a playlist and there is no undo for it.
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  /** Viewport anchor for the overflow menu, or null when closed. */
  const [moreMenu, setMoreMenu] = useState<{ x: number; y: number } | null>(null);

  const startRename = useCallback(() => {
    setDraft(playlist.name);
    setRenaming(true);
  }, [playlist.name]);

  // Rename and Delete used to sit in the action row as pills. Next to Play
  // they wrapped onto a second line, and an unfollow with no undo sat one
  // stray click away. Behind the overflow they keep the two-step confirm and
  // stop competing with the primary action.
  const moreItems = useMemo<ContextMenuItem[]>(() => {
    const items: ContextMenuItem[] = [];
    if (editable) items.push({ label: 'Rename', onClick: startRename });
    // Offered for every playlist, not just editable ones — a link to someone
    // else's playlist is the case you most want to share.
    items.push({
      label: 'Copy Spotify link',
      onClick: () => {
        void navigator.clipboard
          .writeText(`https://open.spotify.com/playlist/${playlist.id}`)
          .then(() => onNotice('Link copied'))
          .catch((err) => console.error('clipboard write failed:', err));
      },
    });
    if (editable) {
      items.push({
        separator: true,
        label: 'Delete playlist',
        title: 'Unfollow — this is how Spotify deletes a playlist',
        onClick: () => setConfirmingDelete(true),
      });
    }
    return items;
  }, [editable, startRename, playlist.id, onNotice]);

  const commitRename = useCallback(() => {
    const name = draft.trim();
    setRenaming(false);
    if (!name || name === playlist.name) return;
    void onRename(playlist.id, name).then(
      () => onNotice('Playlist renamed'),
      (err: unknown) => {
        console.error('rename failed:', err);
        onNotice(
          isMissingScopeError(err)
            ? 'Reconnect Spotify in Settings to allow playlist edits'
            : 'Spotify rejected the rename',
        );
      },
    );
  }, [draft, playlist.id, playlist.name, onRename, onNotice]);

  return (
    <header className="sp-track-header">
      {coverUrl ? (
        <img className="sp-track-header-cover" src={coverUrl} alt="" loading="lazy" draggable={false} />
      ) : (
        <div className="sp-track-header-cover sp-track-header-cover-fallback" />
      )}
      <div className="sp-track-header-text">
        <div className="sp-track-header-eyebrow">Playlist</div>
        {renaming ? (
          <input
            className="sp-track-header-rename"
            value={draft}
            autoFocus
            spellCheck={false}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitRename();
              if (e.key === 'Escape') setRenaming(false);
            }}
            aria-label="Playlist name"
          />
        ) : (
          <h1 className="sp-track-header-title">{playlist.name}</h1>
        )}
        {playlist.description ? (
          <div className="sp-track-header-desc">{playlist.description}</div>
        ) : null}
        <div className="sp-track-header-meta">
          {playlist.owner.display_name ?? playlist.owner.id}
          {trackTotal !== undefined ? ` · ${trackTotal} tracks` : null}
        </div>
        <div className="sp-track-header-actions">
          {canPlay && <PlayButton onPlay={onPlay} shuffle={shuffle} label={playlist.name} />}
          {confirmingDelete ? (
            <>
              <button
                type="button"
                className="sp-track-header-action sp-track-header-action-danger"
                onClick={() => {
                  setConfirmingDelete(false);
                  void onDelete(playlist).then(
                    () => onNotice(`Deleted “${playlist.name}”`),
                    (err: unknown) => {
                      console.error('delete failed:', err);
                      onNotice('Spotify rejected the delete');
                    },
                  );
                }}
              >
                Really delete?
              </button>
              <button
                type="button"
                className="sp-track-header-action"
                onClick={() => setConfirmingDelete(false)}
              >
                Cancel
              </button>
            </>
          ) : (
            !renaming && (
              <button
                type="button"
                className="sp-track-header-more"
                aria-label="More actions"
                aria-haspopup="menu"
                title="More actions"
                onClick={(e) => {
                  const r = e.currentTarget.getBoundingClientRect();
                  setMoreMenu({ x: r.left, y: r.bottom + 6 });
                }}
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                  <circle cx="5" cy="12" r="2" />
                  <circle cx="12" cy="12" r="2" />
                  <circle cx="19" cy="12" r="2" />
                </svg>
              </button>
            )
          )}
        </div>
        {moreMenu && (
          <ContextMenu
            x={moreMenu.x}
            y={moreMenu.y}
            items={moreItems}
            onClose={() => setMoreMenu(null)}
          />
        )}
      </div>
    </header>
  );
}

function LikedHeader({ total, onPlay, canPlay, shuffle }: HeaderProps & { total: number }) {
  return (
    <header className="sp-track-header">
      <div className="sp-track-header-cover sp-liked-cover" aria-hidden>
        <IconHeart />
      </div>
      <div className="sp-track-header-text">
        <div className="sp-track-header-eyebrow">Collection</div>
        <h1 className="sp-track-header-title">Liked Songs</h1>
        <div className="sp-track-header-meta">{total} songs</div>
        <div className="sp-track-header-actions">
          {canPlay && <PlayButton onPlay={onPlay} shuffle={shuffle} label="Liked Songs" />}
        </div>
      </div>
    </header>
  );
}

function PlayButton({
  onPlay,
  shuffle,
  label,
}: {
  onPlay: () => void;
  shuffle: boolean;
  label: string;
}) {
  return (
    <button
      type="button"
      className="sp-track-header-play"
      onClick={onPlay}
      title={shuffle ? 'Play from a random track' : 'Play'}
      aria-label={`Play ${label}`}
    >
      <IconPlay />
      Play
    </button>
  );
}

function IconPlay() {
  return (
    <svg width="11" height="12" viewBox="0 0 11 12" aria-hidden="true">
      <path d="M1 1.2 9.6 6 1 10.8z" fill="currentColor" />
    </svg>
  );
}

function IconHeart() {
  return (
    <svg width="44" height="44" viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M12 21s-7.5-4.7-9.3-9A5.3 5.3 0 0 1 12 6.6 5.3 5.3 0 0 1 21.3 12c-1.8 4.3-9.3 9-9.3 9z"
        fill="currentColor"
      />
    </svg>
  );
}

interface TrackRowProps {
  track: SpotifyTrack;
  index: number;
  artistNames: string;
  isPlaying: boolean;
  onPlay: (track: SpotifyTrack) => void;
  onContextMenu: (track: SpotifyTrack, e: React.MouseEvent) => void;
  draggable: boolean;
  dragging: boolean;
  dropTarget: boolean;
  onDragStart: (index: number) => void;
  onDragOver: (index: number) => void;
  onDrop: (index: number) => void;
  onDragEnd: () => void;
}

const TrackRow = memo(TrackRowImpl);

function TrackRowImpl({
  track,
  index,
  artistNames,
  isPlaying,
  onPlay,
  onContextMenu,
  draggable,
  dragging,
  dropTarget,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
}: TrackRowProps) {
  const thumbUrl = smallestImage(track.album.images);
  const albumName = track.album.name;
  return (
    <tr
      className="sp-track-row"
      data-play="dblclick"
      data-playing={isPlaying ? 'true' : 'false'}
      data-dragging={dragging ? 'true' : undefined}
      data-drop-target={dropTarget ? 'true' : undefined}
      draggable={draggable}
      // Double-click to play, as Spotify does. A single click used to start
      // the track, which meant every attempt to right-click, drag-reorder or
      // just read a row risked replacing what was playing.
      onDoubleClick={() => onPlay(track)}
      onContextMenu={(e) => onContextMenu(track, e)}
      onDragStart={(e) => {
        // Firefox refuses to start a drag without payload; the index travels
        // in component state, so the contents don't matter.
        e.dataTransfer.setData('text/plain', String(index));
        e.dataTransfer.effectAllowed = 'move';
        onDragStart(index);
      }}
      onDragOver={(e) => {
        if (!draggable) return;
        // Without preventDefault the browser treats the row as an invalid
        // drop target and never fires onDrop.
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        onDragOver(index);
      }}
      onDrop={(e) => {
        e.preventDefault();
        onDrop(index);
      }}
      onDragEnd={onDragEnd}
    >
      <td className="sp-track-index">
        {isPlaying ? (
          // No play button on the row that's already playing — there is no
          // sensible "play" there, and the ♫ is what marks it.
          <span className="sp-track-playing-icon">♫</span>
        ) : (
          <>
            <span className="sp-track-number">{index + 1}</span>
            {/* Swapped with the number on hover, purely in CSS. Tracking hover
                in React state would re-render a row per pointer move down a
                list that can run to hundreds. */}
            <button
              type="button"
              className="sp-track-play-btn"
              onClick={() => onPlay(track)}
              aria-label={`Play ${track.name}`}
              title={`Play ${track.name}`}
            >
              <IconPlay />
            </button>
          </>
        )}
      </td>
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
            {artistNames}
          </div>
        </div>
      </td>
      <td className="sp-track-album">{albumName}</td>
      <td className="sp-track-duration">{formatDuration(track.duration_ms)}</td>
    </tr>
  );
}

import { useState, type KeyboardEvent } from 'react';
import type { SpotifyImage, SpotifyPlaylist } from '../spotify/types';

interface Props {
  playlists: SpotifyPlaylist[];
  selectedId: string | null;
  loading: boolean;
  onSelect: (playlist: SpotifyPlaylist) => void;
  onReconnect: () => void;
  authing: boolean;
}

const COLLAPSE_KEY = 'av.spotify.sidebarCollapsed';

function pickSmallestImage(images: SpotifyImage[]): string | undefined {
  if (!images || images.length === 0) return undefined;
  // Spotify returns images large → small typically; pick the last with a url.
  return images[images.length - 1]?.url;
}

export function SpotifyPlaylistList({
  playlists,
  selectedId,
  loading,
  onSelect,
  onReconnect,
  authing,
}: Props) {
  const showLoading = loading && playlists.length === 0;
  const showEmpty = !loading && playlists.length === 0;
  const [collapsed, setCollapsed] = useState<boolean>(
    () => localStorage.getItem(COLLAPSE_KEY) === 'true',
  );

  const toggle = () => {
    setCollapsed((c) => {
      const next = !c;
      localStorage.setItem(COLLAPSE_KEY, String(next));
      return next;
    });
  };

  const selectedName =
    playlists.find((p) => p.id === selectedId)?.name ?? null;

  return (
    <aside className={`sp-sidebar ${collapsed ? 'is-collapsed' : ''}`}>
      <button
        type="button"
        className="sp-sidebar-header"
        onClick={toggle}
        aria-expanded={!collapsed}
        title={collapsed ? 'Expand library' : 'Collapse library'}
      >
        <span className="sp-sidebar-header-label">
          {collapsed && selectedName ? selectedName : 'Your Library'}
        </span>
        <span className="sp-sidebar-caret" aria-hidden>
          {collapsed ? '▾' : '▴'}
        </span>
      </button>
      {collapsed ? null : showLoading ? (
        <div className="sp-sidebar-empty">Loading playlists…</div>
      ) : showEmpty ? (
        <div className="sp-sidebar-empty">
          <div className="sp-sidebar-empty-text">No playlists found.</div>
          <button
            type="button"
            className="sp-sidebar-reconnect"
            onClick={onReconnect}
            disabled={authing}
          >
            {authing ? 'Reconnecting…' : '↻  Reconnect to Spotify'}
          </button>
        </div>
      ) : (
        <ul className="sp-playlist-list">
          {playlists.map((playlist) => {
            const thumbUrl = pickSmallestImage(playlist.images);
            const ownerLabel =
              playlist.owner.display_name ?? playlist.owner.id;
            const isSelected = playlist.id === selectedId;

            const handleSelect = () => onSelect(playlist);
            const handleKeyDown = (event: KeyboardEvent<HTMLLIElement>) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onSelect(playlist);
              }
            };

            return (
              <li
                key={playlist.id}
                className="sp-playlist-item"
                data-selected={isSelected ? 'true' : 'false'}
                role="button"
                tabIndex={0}
                onClick={handleSelect}
                onKeyDown={handleKeyDown}
              >
                {thumbUrl ? (
                  <img
                    className="sp-playlist-thumb"
                    src={thumbUrl}
                    alt=""
                    loading="lazy"
                    draggable={false}
                  />
                ) : (
                  <div className="sp-playlist-thumb sp-playlist-thumb-fallback" />
                )}
                <div className="sp-playlist-text">
                  <div className="sp-playlist-name">{playlist.name}</div>
                  <div className="sp-playlist-meta">
                    {playlist.tracks.total} tracks · {ownerLabel}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </aside>
  );
}

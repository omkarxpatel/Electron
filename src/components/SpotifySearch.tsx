import { useEffect, useRef, useState } from 'react';
import type { SpotifyImage, SpotifyTrack } from '../spotify/types';

interface Props {
  searchTracks: (query: string) => Promise<SpotifyTrack[]>;
  onPlay: (track: SpotifyTrack) => void;
  currentlyPlayingId: string | null;
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

const DEBOUNCE_MS = 280;

export function SpotifySearch({ searchTracks, onPlay, currentlyPlayingId }: Props) {
  const [query, setQuery] = useState<string>('');
  const [results, setResults] = useState<SpotifyTrack[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const inputRef = useRef<HTMLInputElement>(null);
  // Each keystroke bumps this; in-flight fetches check their id before
  // committing results so out-of-order responses can't overwrite newer ones.
  const requestIdRef = useRef<number>(0);

  // Debounced fetch — every keystroke schedules a fetch DEBOUNCE_MS in the
  // future; new keystrokes clear the pending timer. Empty query clears.
  useEffect(() => {
    const q = query.trim();
    if (q.length === 0) {
      requestIdRef.current++;
      setResults([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const myId = ++requestIdRef.current;
    const timer = window.setTimeout(() => {
      searchTracks(q)
        .then((items) => {
          if (requestIdRef.current !== myId) return;
          setResults(items);
          setLoading(false);
        })
        .catch(() => {
          if (requestIdRef.current !== myId) return;
          setResults([]);
          setLoading(false);
        });
    }, DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [query, searchTracks]);

  const hasQuery = query.trim().length > 0;

  const handleClear = (): void => {
    setQuery('');
    inputRef.current?.focus();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Escape' && hasQuery) {
      e.preventDefault();
      handleClear();
    }
  };

  return (
    <>
      <div className="sp-search-bar">
        <span className="sp-search-icon" aria-hidden>
          <IconSearch />
        </span>
        <input
          ref={inputRef}
          type="search"
          className="sp-search-input"
          placeholder="Search Spotify"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          spellCheck={false}
          autoComplete="off"
          aria-label="Search Spotify"
        />
        {hasQuery && (
          <button
            type="button"
            className="sp-search-clear"
            onClick={handleClear}
            aria-label="Clear search"
            title="Clear (Esc)"
          >
            ×
          </button>
        )}
      </div>

      {hasQuery && (
        <div className="sp-search-results">
          {loading && results.length === 0 ? (
            <div className="sp-empty-state">
              <div className="sp-empty-sub">Searching…</div>
            </div>
          ) : results.length === 0 ? (
            <div className="sp-empty-state">
              <div className="sp-empty-sub">No tracks found.</div>
            </div>
          ) : (
            <div className="sp-search-scroll">
              <div className="sp-search-header">
                <span>{results.length} track{results.length === 1 ? '' : 's'}</span>
                {loading && <span className="sp-search-spinner">refreshing…</span>}
              </div>
              <table className="sp-track-table sp-search-table">
                <tbody>
                  {results.map((track, index) => {
                    const isPlaying = track.id === currentlyPlayingId;
                    const thumbUrl = smallestImage(track.album.images);
                    const artistNames = track.artists.map((a) => a.name).join(', ');
                    return (
                      <tr
                        key={`${track.id}-${index}`}
                        className="sp-track-row"
                        data-playing={isPlaying ? 'true' : 'false'}
                        onClick={() => onPlay(track)}
                      >
                        <td className="sp-track-title-cell">
                          {thumbUrl ? (
                            <img
                              className="sp-track-thumb"
                              src={thumbUrl}
                              alt=""
                              loading="lazy"
                              draggable={false}
                            />
                          ) : (
                            <div className="sp-track-thumb sp-track-thumb-fallback" />
                          )}
                          <div className="sp-track-text">
                            <div className="sp-track-name">{track.name}</div>
                            <div className="sp-track-artists">
                              {track.explicit ? (
                                <span className="sp-track-explicit">E</span>
                              ) : null}
                              {artistNames}
                            </div>
                          </div>
                        </td>
                        <td className="sp-track-album">{track.album.name}</td>
                        <td className="sp-track-duration">
                          {formatDuration(track.duration_ms)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </>
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

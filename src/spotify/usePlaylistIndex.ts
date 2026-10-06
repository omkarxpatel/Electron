/**
 * Subscribes a component to the playlist index so its menu re-renders as
 * playlists finish being read, instead of showing whatever was known when the
 * menu first opened. See playlistIndex.ts for why the crawl is progressive.
 */
import { useEffect, useState } from 'react';
import { subscribe } from './playlistIndex';

export function usePlaylistIndex(): number {
  const [revision, setRevision] = useState(0);
  useEffect(() => subscribe(() => setRevision((r) => r + 1)), []);
  return revision;
}

import type { ContextMenuItem } from '../components/ContextMenu';
import type { SpotifyPlaylist, SpotifyTrack } from './types';
import { addToQueue, canEditPlaylist, isMissingScopeError } from './api';

/**
 * The one definition of a track's right-click menu.
 *
 * Two places show it — a row in the track list, and the now-playing track in
 * the player bar — and they have to agree. The wording here is not decorative:
 * the remove label tells you how many copies Spotify is about to delete, and
 * the failure text names the one thing that actually fixes a missing scope.
 * Two copies of that drift, and the copy that drifts is the one nobody is
 * looking at.
 */

/** What "Remove from…" acts on. */
export type TrackMenuSource =
  | { kind: 'liked' }
  | { kind: 'playlist'; playlist: SpotifyPlaylist };

export interface TrackMenuOptions {
  track: SpotifyTrack;
  /** Candidates for "Add to playlist"; filtered to the editable ones. */
  playlists: SpotifyPlaylist[];
  userId: string | null;
  /**
   * The list to remove from, or null to leave the item out entirely.
   *
   * null rather than disabled on purpose. The player bar is the case: the
   * track playing is often not from the list you have open, and a greyed
   * "Remove from this playlist" there is worse than no item — it invites you
   * to wonder which playlist it meant, and the honest answer is one you
   * cannot see.
   */
  source: TrackMenuSource | null;
  /** Loaded tracks of `source`, for the duplicate count. Empty is fine. */
  sourceTracks: SpotifyTrack[];
  /**
   * Include a Liked Songs toggle when this is a boolean. null means the
   * saved state hasn't loaded, and the item renders disabled rather than
   * guessing a direction — offering "Save" for something already saved
   * un-saves it on click, which is the opposite of what was asked.
   * undefined leaves the item out.
   */
  saved?: boolean | null;
  onToggleSaved?: () => Promise<void> | void;
  onAddToPlaylist: (playlistId: string, track: SpotifyTrack) => Promise<void>;
  onRemoveFromSource: (track: SpotifyTrack) => Promise<void>;
  onGoToAlbum: (track: SpotifyTrack) => void;
  /** Omitted where there is nowhere to navigate to. */
  onGoToArtist?: (track: SpotifyTrack) => void;
  /** Runs a write and reports it — see createEditRunner. */
  runEdit: (okText: string, fn: () => Promise<void>) => void;
  showNotice: (text: string) => void;
}

/**
 * Wraps a playlist write so the result is always visible.
 *
 * A write that fails silently is the worst outcome here: the next move is to
 * open Spotify to check, which is the thing this menu exists to avoid.
 */
export function createEditRunner(
  showNotice: (text: string) => void,
): (okText: string, fn: () => Promise<void>) => void {
  return (okText, fn) => {
    void fn().then(
      () => showNotice(okText),
      (err: unknown) => {
        console.error('playlist edit failed:', err);
        // A missing scope never resolves by retrying — the token was issued
        // before playlist-modify-* was requested, so say what actually fixes
        // it instead of showing a generic failure.
        showNotice(
          isMissingScopeError(err)
            ? 'Reconnect Spotify in Settings to allow playlist edits'
            : 'Spotify rejected that — nothing changed',
        );
      },
    );
  };
}

export function buildTrackMenuItems(opts: TrackMenuOptions): ContextMenuItem[] {
  const {
    track,
    playlists,
    userId,
    source,
    sourceTracks,
    saved,
    onToggleSaved,
    onAddToPlaylist,
    onRemoveFromSource,
    onGoToAlbum,
    onGoToArtist,
    runEdit,
    showNotice,
  } = opts;

  const targets: ContextMenuItem[] = playlists
    .filter((p) => canEditPlaylist(p, userId))
    .map((p) => ({
      label: p.name,
      onClick: () => runEdit(`Added to ${p.name}`, () => onAddToPlaylist(p.id, track)),
    }));

  const items: ContextMenuItem[] = [
    {
      label: 'Add to playlist',
      submenu: {
        items: targets,
        filterPlaceholder: 'Find a playlist',
        emptyLabel: userId ? 'No playlists you can edit' : 'Loading your playlists…',
      },
    },
  ];

  if (source) {
    // Spotify's playlist remove ignores the position you pass and deletes
    // every copy of the URI, so the label has to say so when we can see
    // duplicates. Only the loaded span is countable — further copies may lurk
    // past it, which is why the singular wording claims nothing about "just
    // this one". Liked Songs can't hold duplicates at all.
    const copies = sourceTracks.filter((t) => t.uri === track.uri).length;
    const liked = source.kind === 'liked';
    const editable = liked || canEditPlaylist(source.playlist, userId);
    const removeLabel = liked
      ? 'Remove from Liked Songs'
      : copies > 1
        ? `Remove all ${copies} copies from this playlist`
        : 'Remove from this playlist';

    items.push({
      label: removeLabel,
      disabled: !editable,
      title: editable ? undefined : 'You can only edit playlists you own or collaborate on',
      onClick: () =>
        runEdit(liked ? 'Removed from Liked Songs' : 'Removed', () => onRemoveFromSource(track)),
    });
  }

  if (saved !== undefined && onToggleSaved) {
    items.push({
      label: saved ? 'Remove from Liked Songs' : 'Save to Liked Songs',
      disabled: saved === null,
      onClick: () => {
        void Promise.resolve(onToggleSaved()).then(
          () => showNotice(saved ? 'Removed from Liked Songs' : 'Saved to Liked Songs'),
          (err: unknown) => {
            console.error('toggleSaved failed:', err);
            showNotice('Spotify rejected that — nothing changed');
          },
        );
      },
    });
  }

  items.push({
    label: 'Add to queue',
    onClick: () => {
      void addToQueue(track.uri).then(
        () => showNotice('Added to queue'),
        (err: unknown) => {
          console.error('addToQueue failed:', err);
          showNotice('Spotify rejected that — nothing changed');
        },
      );
    },
  });

  items.push({
    separator: true,
    label: 'Go to album',
    disabled: !track.album?.id,
    onClick: () => onGoToAlbum(track),
  });

  if (onGoToArtist) {
    items.push({
      label: 'Go to artist',
      disabled: !track.artists[0]?.id,
      onClick: () => onGoToArtist(track),
    });
  }

  items.push({
    label: 'Copy Spotify link',
    onClick: () => {
      void navigator.clipboard
        .writeText(`https://open.spotify.com/track/${track.id}`)
        .then(() => showNotice('Link copied'))
        .catch((err: unknown) => console.error('clipboard write failed:', err));
    },
  });

  return items;
}

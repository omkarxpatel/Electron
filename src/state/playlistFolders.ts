import { useCallback, useSyncExternalStore } from 'react';
import type { RootlistNode } from '../types/api';

/**
 * Local playlist folders.
 *
 * Spotify has folders and no way to read or write them over the API, so these
 * are ours: they live on this machine, they never sync back, and a playlist
 * being in one has no effect on the user's Spotify account. The import in
 * `importRootlist` seeds them from the desktop app's cache once; after that
 * the two drift independently, and pretending otherwise would be the lie.
 *
 * Shape note: folders are stored **flat** with a `parentId`, and membership is
 * a playlist-id → folder-id map, rather than a nested tree of playlist
 * objects. The playlists themselves come from the API on every launch and
 * their ids are the only durable thing about them; storing a tree of them
 * would mean reconciling two orderings on every refresh, and a playlist that
 * disappeared from the API would leave a hole in the tree instead of simply
 * having no assignment.
 */

// ── Model ──────────────────────────────────────────────────────────────────

export interface PlaylistFolder {
  id: string;
  name: string;
  /** null = top level. */
  parentId: string | null;
}

export interface FolderState {
  folders: PlaylistFolder[];
  /** playlist id → folder id. Absent means "loose at the top level". */
  assignments: Record<string, string>;
}

export interface ImportSummary {
  foldersCreated: number;
  playlistsFiled: number;
  /**
   * Rootlist entries we dropped because the API doesn't return them. These
   * are Spotify's own algorithmic playlists (Blends, Daily Mixes — the
   * `37i9dQZ…` ids), which third-party apps lost access to in Feb 2026.
   * Filing them would produce folders full of rows that open onto nothing,
   * so the count is surfaced instead of silently swallowed.
   */
  unavailable: number;
}

const STORAGE_KEY = 'av.spotify.folders.v1';

const EMPTY: FolderState = { folders: [], assignments: {} };

// ── Persistence ────────────────────────────────────────────────────────────

function load(): FolderState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return EMPTY;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return EMPTY;
    const { folders, assignments } = parsed as Partial<FolderState>;
    if (!Array.isArray(folders) || !assignments || typeof assignments !== 'object') {
      return EMPTY;
    }
    // Drop assignments pointing at folders that no longer exist. Without this
    // a half-written state hides playlists forever: they'd be filed under an
    // id with no folder to open, so no view would ever list them.
    const ids = new Set(folders.map((f) => f.id));
    const clean: Record<string, string> = {};
    for (const [playlistId, folderId] of Object.entries(assignments)) {
      if (ids.has(folderId)) clean[playlistId] = folderId;
    }
    return { folders, assignments: clean };
  } catch {
    return EMPTY;
  }
}

let state: FolderState = load();
const listeners = new Set<() => void>();

function commit(next: FolderState): void {
  state = next;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch (err) {
    // A full or disabled localStorage shouldn't take the library down — the
    // folders just won't survive the session.
    console.error('playlistFolders: persist failed', err);
  }
  for (const fn of listeners) fn();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function getSnapshot(): FolderState {
  return state;
}

// ── Tree helpers ───────────────────────────────────────────────────────────

/** Every folder id at or beneath `id`, including `id` itself. */
function subtreeIds(folders: PlaylistFolder[], id: string): Set<string> {
  const out = new Set<string>([id]);
  // Repeat until nothing new is added rather than recursing, so a corrupted
  // state with a parent cycle terminates instead of blowing the stack.
  let grew = true;
  while (grew) {
    grew = false;
    for (const f of folders) {
      if (f.parentId && out.has(f.parentId) && !out.has(f.id)) {
        out.add(f.id);
        grew = true;
      }
    }
  }
  return out;
}

export function folderPath(folders: PlaylistFolder[], id: string | null): PlaylistFolder[] {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const path: PlaylistFolder[] = [];
  const seen = new Set<string>();
  let cursor = id;
  while (cursor) {
    const f = byId.get(cursor);
    if (!f || seen.has(f.id)) break; // cycle guard — see subtreeIds
    seen.add(f.id);
    path.unshift(f);
    cursor = f.parentId;
  }
  return path;
}

let idCounter = 0;
function newId(): string {
  idCounter += 1;
  return `f${Date.now().toString(36)}${idCounter.toString(36)}`;
}

// ── Operations ─────────────────────────────────────────────────────────────

function createFolder(name: string, parentId: string | null): string {
  const id = newId();
  commit({
    ...state,
    folders: [...state.folders, { id, name: name.trim() || 'New Folder', parentId }],
  });
  return id;
}

function renameFolder(id: string, name: string): void {
  const trimmed = name.trim();
  if (!trimmed) return;
  commit({
    ...state,
    folders: state.folders.map((f) => (f.id === id ? { ...f, name: trimmed } : f)),
  });
}

/**
 * Delete a folder, lifting everything it held up to its parent.
 *
 * Deleting the contents instead would be destructive in a way the user can't
 * undo and didn't ask for — a folder here is a label, not a container, and
 * removing a label must not remove what it was on.
 */
function deleteFolder(id: string): void {
  const target = state.folders.find((f) => f.id === id);
  if (!target) return;
  const folders = state.folders
    .filter((f) => f.id !== id)
    .map((f) => (f.parentId === id ? { ...f, parentId: target.parentId } : f));
  const assignments: Record<string, string> = {};
  for (const [playlistId, folderId] of Object.entries(state.assignments)) {
    if (folderId !== id) assignments[playlistId] = folderId;
    else if (target.parentId) assignments[playlistId] = target.parentId;
    // else: drops out of the map entirely, i.e. back to the top level
  }
  commit({ folders, assignments });
}

/** Reparent a folder. A move into the folder's own subtree is refused — that
 *  detaches the whole branch from the root and it vanishes from every view. */
function moveFolder(id: string, parentId: string | null): void {
  if (id === parentId) return;
  if (parentId && subtreeIds(state.folders, id).has(parentId)) return;
  commit({
    ...state,
    folders: state.folders.map((f) => (f.id === id ? { ...f, parentId } : f)),
  });
}

function assignPlaylist(playlistId: string, folderId: string | null): void {
  const assignments = { ...state.assignments };
  if (folderId) assignments[playlistId] = folderId;
  else delete assignments[playlistId];
  commit({ ...state, assignments });
}

/**
 * Seed folders from the Spotify desktop cache.
 *
 * Additive on purpose: folders you already made are left alone, and a
 * playlist that already has a home is not moved. Re-importing after
 * reorganising here would otherwise quietly undo the reorganising, and the
 * cache is a stale snapshot — it can easily be older than the local state
 * it would be overwriting.
 *
 * `knownPlaylistIds` is what the API actually returns; anything else in the
 * rootlist is counted as unavailable rather than filed. See ImportSummary.
 */
function importRootlist(nodes: RootlistNode[], knownPlaylistIds: Set<string>): ImportSummary {
  const folders = [...state.folders];
  const assignments = { ...state.assignments };
  const summary: ImportSummary = { foldersCreated: 0, playlistsFiled: 0, unavailable: 0 };

  const walk = (list: RootlistNode[], parentId: string | null): void => {
    for (const node of list) {
      if (node.kind === 'folder') {
        // Match an existing folder by name under the same parent so a second
        // import doesn't leave two "Blends" side by side.
        const existing = folders.find((f) => f.parentId === parentId && f.name === node.name);
        let id: string;
        if (existing) {
          id = existing.id;
        } else {
          id = newId();
          folders.push({ id, name: node.name, parentId });
          summary.foldersCreated += 1;
        }
        walk(node.children, id);
        continue;
      }
      const playlistId = node.uri.split(':').pop() ?? '';
      if (!playlistId) continue;
      if (!knownPlaylistIds.has(playlistId)) {
        summary.unavailable += 1;
        continue;
      }
      // Top-level playlists need no assignment, and overwriting an existing
      // one would undo a deliberate local move.
      if (parentId && !assignments[playlistId]) {
        assignments[playlistId] = parentId;
        summary.playlistsFiled += 1;
      }
    }
  };

  walk(nodes, null);
  commit({ folders, assignments });
  return summary;
}

// ── Hook ───────────────────────────────────────────────────────────────────

export interface PlaylistFoldersApi extends FolderState {
  createFolder(name: string, parentId: string | null): string;
  renameFolder(id: string, name: string): void;
  deleteFolder(id: string): void;
  moveFolder(id: string, parentId: string | null): void;
  assignPlaylist(playlistId: string, folderId: string | null): void;
  importRootlist(nodes: RootlistNode[], knownPlaylistIds: Set<string>): ImportSummary;
  /** Direct children of `parentId`, in creation order. */
  childFolders(parentId: string | null): PlaylistFolder[];
}

export function usePlaylistFolders(): PlaylistFoldersApi {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot);

  const childFolders = useCallback(
    (parentId: string | null): PlaylistFolder[] =>
      snapshot.folders.filter((f) => f.parentId === parentId),
    [snapshot.folders],
  );

  return {
    ...snapshot,
    createFolder,
    renameFolder,
    deleteFolder,
    moveFolder,
    assignPlaylist,
    importRootlist,
    childFolders,
  };
}

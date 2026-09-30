/**
 * Recovers the user's playlist-FOLDER tree from the Spotify desktop client's
 * local cache.
 *
 * Why read a private cache at all: folders do not exist in the Web API. No
 * playlist object carries a folder field, and the internal spclient
 * `rootlist` endpoint answers `403 RBAC: access denied` to a third-party
 * token — both verified against a live account. The desktop app's LevelDB
 * cache is the only place on this machine where the structure exists, so we
 * decode it ourselves.
 *
 * That makes this a best-effort convenience on an undocumented format Spotify
 * can change without telling anyone. Every failure resolves to `unavailable`
 * and nothing in here is allowed to throw: a cache we can't read must cost the
 * user a folder list, never app startup.
 *
 * The cache is read-only to us. We never write into Spotify's directory.
 *
 * `readSpotifyRootlist` is the whole renderer-facing contract. The snappy
 * decoder, the tree builder and the name decoder are also exported, but only
 * so `scripts/check-folders.mjs` can assert them directly — typecheck cannot
 * tell you a decoder returned a plausible, wrong tree.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// ── Public contract ──────────────────────────────────────────────────

export type RootlistNode =
  | { kind: 'playlist'; uri: string }
  | { kind: 'folder'; id: string; name: string; children: RootlistNode[] };

export type RootlistResult =
  | { kind: 'ok'; nodes: RootlistNode[]; folderCount: number; playlistCount: number }
  | { kind: 'unavailable'; reason: 'no-cache' | 'no-rootlist' | 'unreadable' };

// ── Varints ──────────────────────────────────────────────────────────

interface Varint {
  value: number;
  /** Index just past the varint, so the next read starts here. */
  next: number;
}

/**
 * LevelDB varints are little-endian base-128. Accumulated with `*` and `+`
 * rather than `<<` and `|` on purpose: JS bitwise operators truncate to 32
 * bits, so a block offset past 2 GB would silently come back negative and
 * point the reader at nonsense.
 */
function readVarint(buf: Buffer, at: number): Varint {
  let value = 0;
  let scale = 1;
  let i = at;
  while (i < buf.length) {
    const byte = buf[i];
    i += 1;
    value += (byte & 0x7f) * scale;
    if ((byte & 0x80) === 0) return { value, next: i };
    scale *= 128;
  }
  throw new Error('varint ran off the end of the buffer');
}

// ── Snappy ───────────────────────────────────────────────────────────

/**
 * A mis-parsed block offset lands on arbitrary bytes, whose first varint can
 * claim any length at all. Without a ceiling that becomes a multi-gigabyte
 * allocation in the main process over a cache file we were only guessing at.
 */
const MAX_UNCOMPRESSED_BLOCK_BYTES = 64 * 1024 * 1024;

/**
 * Snappy, decompressed in-process. There is no snappy dependency in this repo
 * and adding a native one to read an optional cache is a bad trade — the
 * format is a varint length followed by literal and copy tags, and that's it.
 */
export function snappyDecompress(input: Buffer): Buffer {
  const header = readVarint(input, 0);
  const expectedLengthBytes = header.value;
  if (expectedLengthBytes > MAX_UNCOMPRESSED_BLOCK_BYTES) {
    throw new Error(`snappy: implausible uncompressed length ${expectedLengthBytes}`);
  }

  const out = Buffer.allocUnsafe(expectedLengthBytes);
  let written = 0;
  let i = header.next;

  while (i < input.length) {
    const tag = input[i];
    i += 1;

    if ((tag & 0x03) === 0) {
      // Literal. Lengths 60..63 mean "the real length is in the next 1..4 bytes".
      let lengthBytes = tag >> 2;
      if (lengthBytes >= 60) {
        const extra = lengthBytes - 59;
        lengthBytes = input.readUIntLE(i, extra);
        i += extra;
      }
      lengthBytes += 1;
      if (written + lengthBytes > expectedLengthBytes) throw new Error('snappy: literal overruns output');
      input.copy(out, written, i, i + lengthBytes);
      written += lengthBytes;
      i += lengthBytes;
      continue;
    }

    let lengthBytes: number;
    let offsetBytes: number;
    if ((tag & 0x03) === 1) {
      lengthBytes = 4 + ((tag >> 2) & 0x07);
      offsetBytes = ((tag >> 5) << 8) | input[i];
      i += 1;
    } else if ((tag & 0x03) === 2) {
      lengthBytes = (tag >> 2) + 1;
      offsetBytes = input.readUInt16LE(i);
      i += 2;
    } else {
      lengthBytes = (tag >> 2) + 1;
      offsetBytes = input.readUInt32LE(i);
      i += 4;
    }

    if (offsetBytes === 0 || offsetBytes > written) throw new Error('snappy: copy offset out of range');
    if (written + lengthBytes > expectedLengthBytes) throw new Error('snappy: copy overruns output');

    /*
     * Copied byte by byte, and NOT with copyWithin, because the source and
     * destination ranges are meant to overlap: a copy of length 8 at offset 2
     * is how snappy encodes a run, and it expects to re-read the bytes this
     * very loop is writing. A bulk copy reads the pre-loop contents instead,
     * produces the right number of bytes, and corrupts them all silently —
     * the decode still "succeeds", the tree just comes out wrong.
     */
    const from = written - offsetBytes;
    for (let k = 0; k < lengthBytes; k++) out[written + k] = out[from + k];
    written += lengthBytes;
  }

  if (written !== expectedLengthBytes) {
    throw new Error(`snappy: produced ${written} bytes, header claimed ${expectedLengthBytes}`);
  }
  return out;
}

// ── LevelDB SSTables ─────────────────────────────────────────────────

/** Trailing magic on every SSTable footer. A file without it isn't one. */
const SSTABLE_MAGIC = Buffer.from([0x57, 0xfb, 0x80, 0x8b, 0x24, 0x75, 0x47, 0xdb]);

const FOOTER_LENGTH_BYTES = 48;

/** Compression byte then a 4-byte CRC follow every block's payload. */
const BLOCK_TRAILER_LENGTH_BYTES = 5;

const COMPRESSION_SNAPPY = 1;

/** Each restart point in a block's tail is a 4-byte offset. */
const RESTART_ENTRY_LENGTH_BYTES = 4;

interface BlockEntry {
  key: Buffer;
  value: Buffer;
}

function readBlock(file: Buffer, offsetBytes: number, sizeBytes: number): Buffer {
  if (offsetBytes + sizeBytes + BLOCK_TRAILER_LENGTH_BYTES > file.length) {
    throw new Error('block extends past the end of the file');
  }
  const payload = file.subarray(offsetBytes, offsetBytes + sizeBytes);
  return file[offsetBytes + sizeBytes] === COMPRESSION_SNAPPY ? snappyDecompress(payload) : payload;
}

/**
 * Block entries are prefix-compressed against the entry before them, so keys
 * only make sense read in order from the start of the block.
 */
function blockEntries(block: Buffer): BlockEntry[] {
  if (block.length < RESTART_ENTRY_LENGTH_BYTES) throw new Error('block too short for a restart count');
  const restartCount = block.readUInt32LE(block.length - RESTART_ENTRY_LENGTH_BYTES);
  const end = block.length - RESTART_ENTRY_LENGTH_BYTES - restartCount * RESTART_ENTRY_LENGTH_BYTES;
  if (end < 0) throw new Error('restart count larger than the block');

  const entries: BlockEntry[] = [];
  let i = 0;
  let previousKey = Buffer.alloc(0);
  while (i < end) {
    const shared = readVarint(block, i);
    const nonShared = readVarint(block, shared.next);
    const valueLength = readVarint(block, nonShared.next);
    i = valueLength.next;

    const key = Buffer.concat([
      previousKey.subarray(0, shared.value),
      block.subarray(i, i + nonShared.value),
    ]);
    i += nonShared.value;
    const value = block.subarray(i, i + valueLength.value);
    i += valueLength.value;

    previousKey = key;
    entries.push({ key, value });
  }
  return entries;
}

/** Every key/value pair in one `.ldb` file, or `[]` if it isn't an SSTable. */
function tableEntries(file: Buffer): BlockEntry[] {
  if (file.length < FOOTER_LENGTH_BYTES) return [];
  const footer = file.subarray(file.length - FOOTER_LENGTH_BYTES);
  if (!footer.subarray(footer.length - SSTABLE_MAGIC.length).equals(SSTABLE_MAGIC)) return [];

  // The footer's first two varints locate the metaindex, which we don't need.
  const metaindexOffset = readVarint(footer, 0);
  const metaindexSize = readVarint(footer, metaindexOffset.next);
  const indexOffset = readVarint(footer, metaindexSize.next);
  const indexSize = readVarint(footer, indexOffset.next);

  const entries: BlockEntry[] = [];
  for (const indexEntry of blockEntries(readBlock(file, indexOffset.value, indexSize.value))) {
    // An index block's values are (offset, size) pairs naming a data block.
    const dataOffset = readVarint(indexEntry.value, 0);
    const dataSize = readVarint(indexEntry.value, dataOffset.next);
    try {
      entries.push(...blockEntries(readBlock(file, dataOffset.value, dataSize.value)));
    } catch {
      // Not everything an index points at is a data block in the shape above
      // (filter and stats blocks live in the same file). One unreadable block
      // is normal; it must not cost us the rest of the table.
      continue;
    }
  }
  return entries;
}

// ── Rootlist markers ─────────────────────────────────────────────────

/**
 * The rootlist value is protobuf, but the URIs inside it are plain ASCII and
 * appear in document order, which is all the structure we need. Scanning for
 * them beats decoding a schema we'd have to keep in step with Spotify.
 */
const MARKER_PATTERN = /spotify:(?:start-group|end-group|playlist):[0-9a-zA-Z:%_\- ]+/g;

const START_GROUP_PREFIX = 'spotify:start-group:';
const END_GROUP_PREFIX = 'spotify:end-group:';
const PLAYLIST_PREFIX = 'spotify:playlist:';

/**
 * Folder names are form-encoded: percent-escapes plus `+` for space.
 *
 * A literal `%` that isn't a valid escape makes decodeURIComponent throw a
 * URIError. One badly named folder must not take the whole import down, so a
 * failed decode keeps the raw string — the name looks slightly wrong, the
 * tree is still there.
 */
export function decodeFolderName(raw: string): string {
  try {
    return decodeURIComponent(raw.replace(/\+/g, ' '));
  } catch {
    return raw;
  }
}

export interface RootlistTree {
  nodes: RootlistNode[];
  folderCount: number;
  playlistCount: number;
}

/** Nest the flat marker sequence back into the tree it was flattened from. */
export function buildTree(markers: readonly string[]): RootlistTree {
  const roots: RootlistNode[] = [];
  const open: Extract<RootlistNode, { kind: 'folder' }>[] = [];
  let folderCount = 0;
  let playlistCount = 0;

  const siblings = (): RootlistNode[] => (open.length > 0 ? open[open.length - 1].children : roots);

  for (const marker of markers) {
    if (marker.startsWith(PLAYLIST_PREFIX)) {
      siblings().push({ kind: 'playlist', uri: marker });
      playlistCount += 1;
    } else if (marker.startsWith(START_GROUP_PREFIX)) {
      const rest = marker.slice(START_GROUP_PREFIX.length);
      const separator = rest.indexOf(':');
      const folder: Extract<RootlistNode, { kind: 'folder' }> = {
        kind: 'folder',
        id: separator === -1 ? rest : rest.slice(0, separator),
        name: separator === -1 ? '' : decodeFolderName(rest.slice(separator + 1)),
        children: [],
      };
      siblings().push(folder);
      open.push(folder);
      folderCount += 1;
    } else if (marker.startsWith(END_GROUP_PREFIX)) {
      // A close with nothing open is only possible from a truncated or
      // corrupt cache, and popping an empty stack would put every following
      // playlist at the root — a plausible-looking tree that is simply wrong.
      // Ignoring it keeps the damage to the part that was already broken.
      if (open.length > 0) open.pop();
    }
  }

  // Folders still open at the end are closed implicitly. They were attached to
  // their parent when they opened, so there is nothing left to do but stop.
  return { nodes: roots, folderCount, playlistCount };
}

// ── Cache location ───────────────────────────────────────────────────

const CACHE_USERS_DIR = path.join(
  os.homedir(),
  'Library/Application Support/Spotify/PersistentCache/Users',
);

const USER_DIR_SUFFIX = '-user';
const LDB_DIR_NAME = 'primary.ldb';

/**
 * Signing out and back in as another account leaves the previous account's
 * directory in place, so there can be several. Newest wins — that's the one
 * the running client is writing to, and reading a stale sibling would show a
 * folder tree belonging to somebody else's account.
 */
async function findLdbDir(): Promise<string | null> {
  let names: string[];
  try {
    names = await readdir(CACHE_USERS_DIR);
  } catch {
    return null;
  }

  const candidates: { dirPath: string; modifiedMs: number }[] = [];
  for (const name of names) {
    if (!name.endsWith(USER_DIR_SUFFIX)) continue;
    const dirPath = path.join(CACHE_USERS_DIR, name, LDB_DIR_NAME);
    try {
      candidates.push({ dirPath, modifiedMs: (await stat(dirPath)).mtimeMs });
    } catch {
      continue;
    }
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.modifiedMs - a.modifiedMs);
  return candidates[0].dirPath;
}

/**
 * The rootlist is one key among tens of thousands, spread over whichever
 * tables LevelDB last compacted it into. An older table can still hold a
 * superseded copy, so the richest match wins rather than the first.
 */
async function findRootlistValue(dirPath: string): Promise<string | null> {
  const names = (await readdir(dirPath)).filter((n) => n.endsWith('.ldb')).sort();

  let best: { text: string; matches: number } | null = null;
  for (const name of names) {
    let entries: BlockEntry[];
    try {
      entries = tableEntries(await readFile(path.join(dirPath, name)));
    } catch {
      // A table being compacted out from under us mid-read is routine.
      continue;
    }
    for (const { key, value } of entries) {
      if (!key.includes('rootlist')) continue;
      // latin1, not utf8: the value is protobuf, and utf8 decoding collapses
      // each invalid byte sequence into one U+FFFD. That shifts everything
      // after it and can swallow the leading bytes of a marker, so the regex
      // below would miss playlists that are really there.
      const text = value.toString('latin1');
      const matches = text.match(MARKER_PATTERN)?.length ?? 0;
      if (matches > 0 && (best === null || matches > best.matches)) best = { text, matches };
    }
  }
  return best === null ? null : best.text;
}

// ── Entry point ──────────────────────────────────────────────────────

export async function readSpotifyRootlist(): Promise<RootlistResult> {
  try {
    const dirPath = await findLdbDir();
    if (dirPath === null) return { kind: 'unavailable', reason: 'no-cache' };

    const value = await findRootlistValue(dirPath);
    if (value === null) return { kind: 'unavailable', reason: 'no-rootlist' };

    const { nodes, folderCount, playlistCount } = buildTree(value.match(MARKER_PATTERN) ?? []);
    return { kind: 'ok', nodes, folderCount, playlistCount };
  } catch {
    // Deliberately total. This is a convenience feature reading a format we
    // don't own; anything unexpected in it degrades to "no folders", never to
    // a rejected IPC call the renderer has to handle at startup.
    return { kind: 'unavailable', reason: 'unreadable' };
  }
}

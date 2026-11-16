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
/**
 * The most bytes a LevelDB varint can occupy: 64 bits at 7 per byte.
 *
 * Without a limit the loop keeps multiplying for as long as continuation bits
 * keep coming. Enough of them and `scale` overflows to Infinity, a zero
 * payload byte then contributes 0 * Infinity = NaN, and NaN compares false
 * against every ceiling in this file — so it walked straight past
 * MAX_UNCOMPRESSED_BLOCK_BYTES into Buffer.allocUnsafe(NaN).
 */
const MAX_VARINT_BYTES = 10;

function readVarint(buf: Buffer, at: number): Varint {
  let value = 0;
  let scale = 1;
  let i = at;
  while (i < buf.length) {
    if (i - at >= MAX_VARINT_BYTES) throw new Error('varint longer than 10 bytes');
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
        if (i + extra > input.length) throw new Error('snappy: literal length runs off the end of the input');
        lengthBytes = input.readUIntLE(i, extra);
        i += extra;
      }
      lengthBytes += 1;
      if (written + lengthBytes > expectedLengthBytes) throw new Error('snappy: literal overruns output');
      // Buffer.copy clamps a source range that runs past the end and says
      // nothing, while `written` below advances by the full claimed length.
      // `out` comes from allocUnsafe, so the bytes never copied were whatever
      // that memory last held — measured, fragments of this process's own
      // strings — returned as cache contents and then scanned for uris.
      if (i + lengthBytes > input.length) throw new Error('snappy: literal runs off the end of the input');
      input.copy(out, written, i, i + lengthBytes);
      written += lengthBytes;
      i += lengthBytes;
      continue;
    }

    // Checked before reading, for all three widths. Tag 1's offset low byte
    // is read with a plain index, and past the end that is `undefined`, which
    // ors into 0 — so a truncated copy didn't fail, it copied from an offset
    // made of the tag's high bits alone, which can clear every guard below
    // and return a full-length, wrong buffer. Tags 2 and 3 went through
    // readUInt16LE/readUInt32LE, which do throw, but as a Buffer RangeError
    // rather than as this decoder rejecting its input.
    const offsetWidthBytes = (tag & 0x03) === 1 ? 1 : (tag & 0x03) === 2 ? 2 : 4;
    if (i + offsetWidthBytes > input.length) throw new Error('snappy: copy offset runs off the end of the input');

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

/**
 * The densest a real block gets, with room to spare. Measured over every data
 * block in a real Spotify cache (94,339 blocks, 1.7M entries): the densest
 * block averaged one entry per 22.8 bytes, and the tightest run of 16
 * consecutive entries anywhere was 19.4 bytes each. Every key also carries
 * LevelDB's 8-byte sequence-and-type suffix, so an entry can't really go
 * below that plus its three length varints. 8 leaves a real table more than
 * twice the room it uses and still rejects the 3 a zero-filled block reads as.
 */
const MIN_BLOCK_ENTRY_BYTES = 8;

/** Entries a block may run ahead of that density before it is rejected, so a
 *  short burst of small keys straight after a restart point isn't mistaken
 *  for a degenerate block. */
const DENSITY_SLACK_ENTRIES = 16;

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

  // LevelDB writes a restart point at offset 0 of every block it builds, so a
  // real block never has zero of them — across the 94,339 data blocks in a
  // real Spotify cache the minimum was 1. A count of 0 is what a zero-filled
  // region reads as, and three zero bytes are three valid varints, so without
  // this it parsed as one empty entry every three bytes. LevelDB's own reader
  // treats a zero count as an empty block; so does this.
  if (restartCount === 0) return [];

  const entries: BlockEntry[] = [];
  let i = 0;
  let previousKey = Buffer.alloc(0);
  while (i < end) {
    const shared = readVarint(block, i);
    const nonShared = readVarint(block, shared.next);
    const valueLength = readVarint(block, nonShared.next);
    i = valueLength.next;

    // Both of these used to be silent. `subarray` clamps a range that runs
    // past the end, so a corrupt length produced a short key or a short
    // value rather than an error — and a short rootlist value is a folder
    // tree with the end missing.
    if (shared.value > previousKey.length) throw new Error('block entry shares more key than the previous one had');
    if (i + nonShared.value + valueLength.value > end) throw new Error('block entry runs past the end of the block');

    const key = Buffer.concat([
      previousKey.subarray(0, shared.value),
      block.subarray(i, i + nonShared.value),
    ]);
    i += nonShared.value;
    const value = block.subarray(i, i + valueLength.value);
    i += valueLength.value;

    previousKey = key;
    entries.push({ key, value });

    // The backstop for a block that is dense but otherwise well-formed. Each
    // entry is a live object holding two Buffers, about 360 bytes measured,
    // and MAX_UNCOMPRESSED_BLOCK_BYTES caps the INPUT, not what is built from
    // it — at 3 bytes an entry the 64 MB ceiling bought tens of millions of
    // them. Checked as it goes rather than at the end, so a degenerate block
    // is stopped a few dozen entries in, not after the allocation it exists
    // to prevent.
    if (entries.length > i / MIN_BLOCK_ENTRY_BYTES + DENSITY_SLACK_ENTRIES) {
      throw new Error('block entries are implausibly dense');
    }
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
      // One bad block must not cost the rest of the table. This used to say
      // that was routine because filter and stats blocks live alongside the
      // data — but in LevelDB's format those hang off the metaindex, which is
      // never read here, and every one of the 94,339 blocks an index pointed
      // at in a real Spotify cache decoded. What lands here is corruption, a
      // block caught mid-compaction, or one of the decoder's own guards
      // refusing something malformed.
      continue;
    }
  }
  return entries;
}

// ── Rootlist markers ─────────────────────────────────────────────────

// ── Write-ahead log ──────────────────────────────────────────────────

/*
 * A write reaches a `.ldb` table only when LevelDB compacts, which it may not
 * do for hours — until then it lives in the `.log`. Reading tables alone meant
 * the folder tree was whatever Spotify last compacted: on one machine the
 * tables still had a playlist loose at the root four hours after it was moved
 * into a folder, and re-importing could never fix it, because every copy in
 * the log already had it filed. The log is newer than every table by
 * construction, so what it holds wins.
 */

/** Log records are laid out in 32 KB blocks and never cross one. */
const LOG_BLOCK_BYTES = 32768;
/** crc32c(4) + length(2) + type(1), ahead of every record fragment. */
const LOG_HEADER_BYTES = 7;
const LOG_TYPE_FULL = 1;
const LOG_TYPE_FIRST = 2;
const LOG_TYPE_MIDDLE = 3;
const LOG_TYPE_LAST = 4;
/** sequence(8) + count(4), ahead of the first operation in a write batch. */
const BATCH_HEADER_BYTES = 12;
const BATCH_OP_DELETE = 0;
const BATCH_OP_PUT = 1;
/** tag(1) + a one-byte key length + a one-byte value length. */
const MIN_BATCH_OP_BYTES = 3;

/**
 * Reassemble a log file's write batches, in the order they were written.
 *
 * FULL stands alone; FIRST .. MIDDLE .. LAST rebuild into one batch. The
 * checksum is deliberately not verified: crc32c isn't in node's stdlib, and
 * the structural checks here are what actually protect the reader — a torn
 * fragment fails to decode into operations rather than quietly becoming some.
 *
 * Malformed input stops the read and keeps what came before it, rather than
 * throwing. Spotify is writing into this file while we read, so a half-written
 * record at the tail is the normal case and not corruption; LevelDB's own
 * reader treats it the same way.
 */
function logBatches(file: Buffer): Buffer[] {
  const batches: Buffer[] = [];
  let pending: Buffer[] | null = null;

  for (let blockStart = 0; blockStart < file.length; blockStart += LOG_BLOCK_BYTES) {
    const blockEnd = Math.min(blockStart + LOG_BLOCK_BYTES, file.length);
    let i = blockStart;
    while (i + LOG_HEADER_BYTES <= blockEnd) {
      const length = file.readUInt16LE(i + 4);
      const type = file[i + 6];
      // The tail of a block too short for another header is zero-filled, and
      // so is a log preallocated but not yet written into.
      if (type === 0 && length === 0) break;
      if (type < LOG_TYPE_FULL || type > LOG_TYPE_LAST) return batches;
      const dataStart = i + LOG_HEADER_BYTES;
      const dataEnd = dataStart + length;
      if (dataEnd > blockEnd) return batches;
      const data = file.subarray(dataStart, dataEnd);

      if (type === LOG_TYPE_FULL) {
        pending = null;
        batches.push(data);
      } else if (type === LOG_TYPE_FIRST) {
        pending = [data];
      } else if (pending !== null && (type === LOG_TYPE_MIDDLE || type === LOG_TYPE_LAST)) {
        pending.push(data);
        if (type === LOG_TYPE_LAST) {
          batches.push(Buffer.concat(pending));
          pending = null;
        }
      }
      // A MIDDLE or LAST with nothing open is a fragment whose FIRST we never
      // saw — the start of a log that was rotated, say. Skipped, not fatal.

      i = dataEnd;
    }
  }
  return batches;
}

/**
 * Every put in one write batch. Deletions carry no value, so they contribute
 * nothing to read; the rootlist key being deleted means the account signed
 * out, and the table copy is no better.
 */
function batchEntries(batch: Buffer): BlockEntry[] {
  if (batch.length < BATCH_HEADER_BYTES) return [];
  const count = batch.readUInt32LE(8);
  // The count is a claim from the file. Each operation costs at least three
  // bytes, so anything past that is malformed rather than merely dense — and
  // the loop below would otherwise trust it while reading past the batch.
  if (count > (batch.length - BATCH_HEADER_BYTES) / MIN_BATCH_OP_BYTES) return [];

  const entries: BlockEntry[] = [];
  let i = BATCH_HEADER_BYTES;
  for (let n = 0; n < count && i < batch.length; n += 1) {
    const op = batch[i];
    i += 1;
    if (op !== BATCH_OP_PUT && op !== BATCH_OP_DELETE) return entries;

    const keyLength = readVarint(batch, i);
    const keyEnd = keyLength.next + keyLength.value;
    if (keyEnd > batch.length) return entries;
    const key = batch.subarray(keyLength.next, keyEnd);
    if (op === BATCH_OP_DELETE) {
      i = keyEnd;
      continue;
    }

    const valueLength = readVarint(batch, keyEnd);
    const valueEnd = valueLength.next + valueLength.value;
    if (valueEnd > batch.length) return entries;
    entries.push({ key, value: batch.subarray(valueLength.next, valueEnd) });
    i = valueEnd;
  }
  return entries;
}

/** Every put in one log file, oldest first. */
function logEntries(file: Buffer): BlockEntry[] {
  const entries: BlockEntry[] = [];
  for (const batch of logBatches(file)) {
    try {
      entries.push(...batchEntries(batch));
    } catch {
      // A varint that ran off the end — the torn tail again. Keep the rest.
      break;
    }
  }
  return entries;
}

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

/**
 * The largest table worth reading. LevelDB closes a table at about 2 MB, and
 * the largest of the 143 in a real Spotify cache was 2.13 MB, so 64 MB is 30
 * times anything it writes. What it exists to stop is a pathological file —
 * a corrupt or sparse one — being pulled whole into the main process, where
 * the parse then blocks the event loop for the entire app. A skip is logged
 * because, if Spotify ever changed its table size, this is where its folders
 * would go missing.
 */
const MAX_LDB_FILE_BYTES = 64 * 1024 * 1024;
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
 *
 * The log is read after them and wins outright when it has the key, because
 * it holds every write LevelDB has not compacted yet — including, on the
 * machine this was found on, a folder move the tables were four hours behind
 * on. The richest-match rule cannot find that one: moving a playlist between
 * folders changes no marker count at all.
 */
async function findRootlistValue(dirPath: string): Promise<string | null> {
  const names = (await readdir(dirPath)).filter((n) => n.endsWith('.ldb')).sort();

  let best: { text: string; matches: number } | null = null;
  for (const name of names) {
    const filePath = path.join(dirPath, name);
    let entries: BlockEntry[];
    try {
      // Sized before it is read, because readFile pulls the whole table into
      // the main process. See MAX_LDB_FILE_BYTES for why this cannot cost a
      // real table, and why it is logged rather than skipped silently.
      const sizeBytes = (await stat(filePath)).size;
      if (sizeBytes > MAX_LDB_FILE_BYTES) {
        console.warn(
          `[spotifyFolders] skipping ${name}: ${(sizeBytes / 1048576).toFixed(1)} MB is past any table LevelDB writes`,
        );
        continue;
      }
      entries = tableEntries(await readFile(filePath));
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

  const fromLog = await findRootlistInLogs(dirPath);
  return fromLog ?? (best === null ? null : best.text);
}

/**
 * The newest rootlist written to a log, or null.
 *
 * Last write wins here rather than richest match: within the log the order IS
 * the answer, so a copy with fewer playlists than an earlier one means
 * playlists were removed. Logs are read oldest first (LevelDB's names are
 * zero-padded and increment), so the last match across all of them is the
 * newest write on this machine.
 */
async function findRootlistInLogs(dirPath: string): Promise<string | null> {
  const names = (await readdir(dirPath)).filter((n) => n.endsWith('.log')).sort();

  let latest: string | null = null;
  for (const name of names) {
    const filePath = path.join(dirPath, name);
    let entries: BlockEntry[];
    try {
      const sizeBytes = (await stat(filePath)).size;
      if (sizeBytes > MAX_LDB_FILE_BYTES) {
        console.warn(
          `[spotifyFolders] skipping ${name}: ${(sizeBytes / 1048576).toFixed(1)} MB is past any log LevelDB writes`,
        );
        continue;
      }
      entries = logEntries(await readFile(filePath));
    } catch {
      // Rotated out from under us mid-read, like a table being compacted.
      continue;
    }
    for (const { key, value } of entries) {
      if (!key.includes('rootlist')) continue;
      // latin1 for the same reason as the table path above: utf8 would
      // collapse invalid byte sequences and shift the markers after them.
      const text = value.toString('latin1');
      // `match`, not `test`: MARKER_PATTERN is global, so `test` would carry
      // its lastIndex into the next value and start reading it part-way in.
      if (text.match(MARKER_PATTERN) !== null) latest = text;
    }
  }
  return latest;
}

// ── Entry point ──────────────────────────────────────────────────────

/**
 * A read already in progress, shared by anyone who asks while it runs.
 *
 * One read of a real 235 MB cache stalls the main process event loop for
 * about 1.7 s of its ~1.9 s, at ~200 MB RSS — the parse is synchronous, so
 * the whole app waits on it. Two overlapping calls used to do all of that
 * twice for the same answer, which is the one way to make it worse. The
 * renderer's busy flag mostly prevents that, but the guarantee belongs here
 * with the cost, as deviceVolume.ts keeps its own serialisation.
 */
let readInFlight: Promise<RootlistResult> | null = null;

export function readSpotifyRootlist(): Promise<RootlistResult> {
  readInFlight ??= readSpotifyRootlistOnce().finally(() => {
    readInFlight = null;
  });
  return readInFlight;
}

async function readSpotifyRootlistOnce(): Promise<RootlistResult> {
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

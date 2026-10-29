#!/usr/bin/env node
/**
 * Regression check for the Spotify playlist-folder decoder in
 * `electron/spotifyFolders.ts`.
 *
 * There is no test suite in this repo, and `npm run typecheck` cannot tell you
 * that a decoder returned a plausible-looking tree that is wrong. Every
 * failure this guards is silent by construction — nothing throws, the user
 * just gets somebody's folders in the wrong order, or not at all:
 *
 *   - snappy copies overlap their own output on purpose. A copy of length 10
 *     at offset 2 is how a run is encoded, and it re-reads the bytes it is
 *     writing. Do it with a bulk copy and you still get the right number of
 *     bytes back, all of them garbage, and the block parses into nonsense
 *     rather than erroring. That case is the reason this file exists.
 *   - an `end-group` with nothing open pops an empty stack. Get that wrong and
 *     every playlist after the corruption silently moves to the root.
 *   - folder names are form-encoded, so one stray `%` throws a URIError out of
 *     decodeURIComponent. Unhandled, one bad name costs the whole tree.
 *
 * Two of the cases below FAIL against the decoder as it stands. They are not
 * broken checks and they are not describing a regression somebody just caused
 * — they were written to pin down bugs already in the file, and they go green
 * when those are fixed, not before:
 *
 *   - a block cut off mid-copy-tag promises offset bytes that aren't there.
 *     Indexing a Buffer past its end yields `undefined`, and `x | undefined`
 *     is `x | 0`, so the 1-byte form INVENTS an offset out of the tag's high
 *     bits alone, satisfies every guard downstream of it, and hands back a
 *     full-length block of bytes nobody wrote. Nothing errors; the tree is
 *     just somebody else's. The 2- and 4-byte forms reach Buffer.readUInt*LE
 *     and throw a Node RangeError, which is at least loud, but it is still
 *     the read discovering the problem rather than a check.
 *   - three zero bytes are three valid varints, so a run of zeros parses as
 *     one block entry per three bytes, each a live object with two Buffer
 *     views on it. Block *size* is capped (MAX_UNCOMPRESSED_BLOCK_BYTES, 64
 *     MB); the entry count that cap permits is not, so the ceiling put there
 *     to stop a multi-gigabyte allocation in the main process allows one.
 *
 * This decoder bounds-checks nine times over, and in both cases above the
 * check exists — it just runs after the read it was supposed to protect.
 *
 * The decoder only imports node builtins, so like check-enhancer.mjs it
 * compiles standalone and runs under plain node — no Electron, no bundler.
 *
 *   npm run check:folders
 */

import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

let failures = 0;

function check(label, ok, detail) {
  if (ok) {
    console.log(`  ok    ${label}${detail ? `  (${detail})` : ''}`);
  } else {
    failures++;
    console.log(`  FAIL  ${label}${detail ? `  (${detail})` : ''}`);
  }
}

/**
 * Internals this file asserts on that the decoder does not export. Nothing
 * outside it has any reason to call these, and widening the source's contract
 * so a check can reach in is the test reshaping the thing it tests — so the
 * re-export is appended to the COMPILED output instead and
 * `electron/spotifyFolders.ts` is left alone. Already-exported names are
 * skipped, so promoting one of these for real later doesn't break the check.
 */
const INTERNALS = ['blockEntries'];

/** Compile the decoder and import it. */
async function loadModule() {
  const out = mkdtempSync(join(tmpdir(), 'folders-check-'));
  execFileSync(
    'npx',
    [
      'tsc',
      'electron/spotifyFolders.ts',
      '--outDir', out,
      '--module', 'esnext',
      '--target', 'es2022',
      '--moduleResolution', 'bundler',
    ],
    { stdio: 'pipe' },
  );

  const compiled = join(out, 'spotifyFolders.js');
  const source = readFileSync(compiled, 'utf8');
  const missing = INTERNALS.filter(
    (name) => !new RegExp(`export\\s+(?:function\\s+${name}\\b|\\{[^}]*\\b${name}\\b)`).test(source),
  );
  if (missing.length > 0) appendFileSync(compiled, `\nexport { ${missing.join(', ')} };\n`);

  const mod = await import(pathToFileURL(compiled).href);
  const unreachable = INTERNALS.filter((name) => typeof mod[name] !== 'function');
  if (unreachable.length > 0) {
    throw new Error(`could not reach ${unreachable.join(', ')} in the compiled decoder`);
  }
  return { mod, cleanup: () => rmSync(out, { recursive: true, force: true }) };
}

const { mod, cleanup } = await loadModule();
const { snappyDecompress, blockEntries, buildTree, decodeFolderName, readSpotifyRootlist } = mod;

// ── Snappy vectors, hand-encoded ─────────────────────────────────────

function varint(n) {
  const bytes = [];
  while (n >= 0x80) {
    bytes.push((n & 0x7f) | 0x80);
    n = Math.floor(n / 128);
  }
  bytes.push(n);
  return Buffer.from(bytes);
}

/** Literal with its length in the tag (1..60 bytes). */
function literal(text) {
  const body = Buffer.from(text, 'latin1');
  return Buffer.concat([Buffer.from([(body.length - 1) << 2]), body]);
}

/** Literal whose length lives in `extraBytes` trailing bytes (tag 60..63). */
function literalExtended(text, extraBytes) {
  const body = Buffer.from(text, 'latin1');
  const len = Buffer.alloc(extraBytes);
  len.writeUIntLE(body.length - 1, 0, extraBytes);
  return Buffer.concat([Buffer.from([(59 + extraBytes) << 2]), len, body]);
}

/** Copy tag 1: length 4..11, offset < 2048, offset's high bits in the tag. */
function copy1(length, offset) {
  return Buffer.from([0x01 | ((length - 4) << 2) | ((offset >> 8) << 5), offset & 0xff]);
}

/** Copy tag 2: 2-byte little-endian offset. */
function copy2(length, offset) {
  const b = Buffer.alloc(3);
  b[0] = 0x02 | ((length - 1) << 2);
  b.writeUInt16LE(offset, 1);
  return b;
}

/** Copy tag 3: 4-byte little-endian offset. */
function copy4(length, offset) {
  const b = Buffer.alloc(5);
  b[0] = 0x03 | ((length - 1) << 2);
  b.writeUInt32LE(offset, 1);
  return b;
}

/*
 * The three encoders above always emit the offset bytes their tag promises,
 * which is the whole reason the truncation bug survived this file: a correct
 * encoder cannot produce the input that breaks the decoder, so no amount of
 * round-tripping finds it. These stop at the tag byte, which is what a block
 * truncated mid-tag looks like.
 */

/** Copy tag 1 with its one offset byte missing; the tag's high bits survive. */
function copy1Truncated(length, offsetHighBits) {
  return Buffer.from([0x01 | ((length - 4) << 2) | (offsetHighBits << 5)]);
}

/** Copy tag 2 with both offset bytes missing. */
function copy2Truncated(length) {
  return Buffer.from([0x02 | ((length - 1) << 2)]);
}

/** Copy tag 3 with all four offset bytes missing. */
function copy4Truncated(length) {
  return Buffer.from([0x03 | ((length - 1) << 2)]);
}

function frame(expectedText, ...parts) {
  return Buffer.concat([varint(Buffer.byteLength(expectedText, 'latin1')), ...parts]);
}

function roundTrip(label, expected, ...parts) {
  let got;
  try {
    got = snappyDecompress(frame(expected, ...parts)).toString('latin1');
  } catch (err) {
    check(label, false, `threw: ${err.message}`);
    return;
  }
  check(label, got === expected, got === expected ? '' : `got ${JSON.stringify(got.slice(0, 48))}`);
}

console.log('\nSnappy');

roundTrip('a short literal', 'hello world', literal('hello world'));

const long = 'x'.repeat(200);
roundTrip('a literal with a 1-byte extended length', long, literalExtended(long, 1));

const huge = 'y'.repeat(1000);
roundTrip('a literal with a 2-byte extended length', huge, literalExtended(huge, 2));

roundTrip('copy tag 1 (offset in the tag)', 'abcdefghabcdefgh', literal('abcdefgh'), copy1(8, 8));

roundTrip(
  'copy tag 2 (16-bit offset)',
  '0123456789' + '0123456789',
  literal('0123456789'),
  copy2(10, 10),
);

roundTrip(
  'copy tag 3 (32-bit offset)',
  '0123456789' + '0123456789',
  literal('0123456789'),
  copy4(10, 10),
);

/*
 * The one that matters. offset (2) is smaller than length (10), so the copy
 * reads bytes this same copy is still writing. Anything that resolves the
 * source range up front — copyWithin, a subarray captured before the loop —
 * returns 12 bytes of the wrong thing without erroring.
 */
roundTrip('an overlapping run-length copy', 'ab'.repeat(6), literal('ab'), copy1(10, 2));

roundTrip('a single-byte run', 'z'.repeat(21), literal('z'), copy2(20, 1));

roundTrip(
  'a run fed by an earlier run',
  'ab'.repeat(6) + 'ab'.repeat(6),
  literal('ab'),
  copy1(10, 2),
  copy2(12, 12),
);

// A header that disagrees with the body means we mis-parsed the block, and
// returning the short buffer anyway is how a truncated tree looks correct.
let threwOnMismatch = false;
try {
  snappyDecompress(Buffer.concat([varint(99), literal('hello world')]));
} catch {
  threwOnMismatch = true;
}
check('a length that disagrees with the header throws', threwOnMismatch);

// ── Truncated copy tags ──────────────────────────────────────────────

/*
 * A block that stops in the middle of a copy tag is not hypothetical. The
 * decoder reads tables another process is compacting underneath it, and
 * `readBlock` hands over whatever span the index claimed was there — so the
 * offset bytes a tag promises can simply be absent.
 *
 * There are exactly two honest answers to that input: one of this decoder's
 * own 'snappy: ...' errors, or the right bytes. It cannot produce the right
 * bytes, because the bytes that would say what to copy are gone, so an error
 * is the only answer left. A Node RangeError out of Buffer is not it — that
 * is the read finding out, not a guard — and a full-length buffer is worse
 * still, because every layer above this one is built to trust its length.
 */

console.log('\nTruncated copy tags');

/** What the decoder did with an input it had no honest way to decode. */
function outcome(input) {
  try {
    return { kind: 'returned', buffer: snappyDecompress(input) };
  } catch (err) {
    // Every guard in the decoder throws a plain Error tagged 'snappy: '.
    // Anything else fell out of Buffer, which means nobody checked first.
    return err instanceof Error && !(err instanceof RangeError) && err.message.startsWith('snappy:')
      ? { kind: 'rejected', detail: err.message }
      : { kind: 'crashed', detail: `${err.constructor.name}: ${err.message}` };
  }
}

/*
 * The expensive one, and the reason the other two are only half a bug. Tag 1
 * keeps the offset's high bits in the tag and the low byte after it; read that
 * byte past the end of the input and you get `undefined`, which ors into 0
 * rather than erroring. So the offset is not corrupt, it is INVENTED — 512
 * here, purely from the high bits — and 512 is a perfectly ordinary offset
 * that clears the out-of-range guard, the overrun guard and the final
 * length check. The decoder returns 604 bytes and no error, and the last four
 * of them are a copy of bytes it was never told to copy.
 *
 * So this asserts the CONTENT. "It threw" would also be satisfied by a
 * RangeError, and "it returned 604 bytes" is exactly the symptom.
 */
const INVENTED_OFFSET_BYTES = 2 << 8; // the tag's high bits, absent low byte read as 0
const COPY_LENGTH_BYTES = 4;

const literalBody = Buffer.alloc(600);
for (let k = 0; k < literalBody.length; k++) literalBody[k] = k % 251;

const truncatedCopy1 = Buffer.concat([
  varint(literalBody.length + COPY_LENGTH_BYTES),
  literalExtended(literalBody.toString('latin1'), 2),
  copy1Truncated(COPY_LENGTH_BYTES, 2),
]);

{
  const got = outcome(truncatedCopy1);
  let detail = got.detail;
  if (got.kind === 'returned') {
    const from = literalBody.length - INVENTED_OFFSET_BYTES;
    const tail = got.buffer.subarray(-COPY_LENGTH_BYTES);
    const sourced = tail.equals(literalBody.subarray(from, from + COPY_LENGTH_BYTES));
    detail =
      `returned ${got.buffer.length} bytes and no error; last ${COPY_LENGTH_BYTES} are ` +
      `[${[...tail]}]${sourced ? `, i.e. input[${from}..${from + COPY_LENGTH_BYTES - 1}] — ` +
      `copied from an offset of ${INVENTED_OFFSET_BYTES} that was never in the input` : ''}`;
  }
  check('copy tag 1 with no offset byte is not completed from an invented offset', got.kind === 'rejected', detail);
}

/*
 * Tags 2 and 3 read their offset through Buffer.readUInt16LE/readUInt32LE,
 * which do bounds-check — so these fail loudly rather than silently. But the
 * error is a Node RangeError describing a buffer offset, thrown from inside
 * Buffer, and `readSpotifyRootlist` catches everything and reports
 * 'unreadable'. The cost is the same as the fabricated case: the folder list
 * is gone. It is only cheaper to diagnose.
 */
{
  const got = outcome(Buffer.concat([varint(16), literal('abcdefgh'), copy2Truncated(8)]));
  check('copy tag 2 with no offset bytes is rejected by the decoder, not by Buffer', got.kind === 'rejected', got.detail);
}

{
  const got = outcome(Buffer.concat([varint(16), literal('abcdefgh'), copy4Truncated(8)]));
  check('copy tag 3 with no offset bytes is rejected by the decoder, not by Buffer', got.kind === 'rejected', got.detail);
}

// ── Truncated literals ───────────────────────────────────────────────

/*
 * The literal path has the same gap as the copy tags, and its silent half is
 * worse. A literal's body goes through Buffer.copy, which clamps the source
 * range to what is actually there and says nothing — so a literal that claims
 * 40 bytes with only 10 left copies 10, and `written` still advances by 40.
 * The output buffer comes from Buffer.allocUnsafe, so the other 30 are
 * whatever that memory last held: measured, they decoded as fragments of the
 * process's own strings ("adUInt8nFunctiHA"). The decoder returned them as
 * cache contents, and the rootlist scan then searched them for spotify: uris.
 *
 * Asserted on content for the same reason as copy tag 1 above: "it threw" is
 * the fixed behaviour, and anything else must not be mistaken for it.
 */
console.log('\nTruncated literals');

{
  const SUPPLIED_BYTES = 10;
  const CLAIMED_BYTES = 40;
  const input = Buffer.concat([
    varint(CLAIMED_BYTES),
    Buffer.from([(CLAIMED_BYTES - 1) << 2]),
    Buffer.alloc(SUPPLIED_BYTES, 0x41),
  ]);
  const got = outcome(input);
  let detail = got.detail;
  if (got.kind === 'returned') {
    const neverSupplied = got.buffer.subarray(SUPPLIED_BYTES);
    const foreign = [...neverSupplied].filter((b) => b !== 0x41).length;
    detail =
      `returned ${got.buffer.length} bytes and no error from ${SUPPLIED_BYTES} supplied; ` +
      `${foreign} of the other ${neverSupplied.length} are not input bytes at all`;
  }
  check('a literal longer than the input left is rejected, not padded from uninitialised memory', got.kind === 'rejected', detail);
}

/* Lengths 60..63 put the real length in the next 1..4 bytes, read through
 * Buffer.readUIntLE — which bounds-checks, so this one is loud. It is the
 * copy tag 2/3 case again: right to fail, wrong thing doing the failing. */
{
  const EXTRA_LENGTH_BYTES = 2;
  const got = outcome(Buffer.concat([varint(300), Buffer.from([(59 + EXTRA_LENGTH_BYTES) << 2, 0x2b])]));
  check('a literal whose length bytes are cut off is rejected by the decoder, not by Buffer', got.kind === 'rejected', got.detail);
}

/*
 * readVarint accumulates with `*` so offsets past 2 GB survive, and keeps
 * multiplying for as long as continuation bits keep coming. Enough of them
 * and `scale` overflows to Infinity, a zero payload byte makes 0 * Infinity,
 * and the result is NaN — which compares false against everything, so it
 * walks straight past the MAX_UNCOMPRESSED_BLOCK_BYTES ceiling and reaches
 * Buffer.allocUnsafe(NaN). A LevelDB varint is at most 10 bytes; anything
 * longer is not one.
 */
{
  const input = Buffer.concat([Buffer.alloc(160, 0x80), Buffer.from([0x00])]);
  let kind;
  let detail;
  try {
    snappyDecompress(input);
    kind = 'returned';
    detail = 'returned without error';
  } catch (err) {
    kind = err instanceof RangeError ? 'crashed' : 'rejected';
    detail = `${err.constructor.name}: ${err.message}`;
  }
  check('a varint longer than 10 bytes is rejected before it becomes NaN', kind === 'rejected', detail);
}

// ── Block entries ────────────────────────────────────────────────────

/*
 * A block entry is three varints and then its key and value bytes, and three
 * zero bytes are three valid varints reading zero — so a run of zeros parses
 * as one entry every three bytes, each one a live object carrying two Buffer
 * views. Nothing is corrupt and nothing throws; the array just grows.
 *
 * `MAX_UNCOMPRESSED_BLOCK_BYTES` (64 MB) exists to stop a mis-parsed block
 * offset turning into a huge allocation, and it bounds the right thing by the
 * wrong measure: the input is capped, the entries built from it are not, and
 * at 3 bytes each the capped input still buys tens of millions of them. The
 * decoder's own comment calls out "a multi-gigabyte allocation in the main
 * process" as the thing being prevented. This is that, through the ceiling.
 *
 * 64 KB, not 64 MB, on purpose — a check that reproduces the exhaustion is a
 * check that takes the machine down with it. The ratio is what's wrong, and
 * the ratio is visible at any size.
 *
 * The bound asserted is deliberately generous. Across the 85,844 real data
 * blocks in this machine's Spotify cache, the densest held one entry per 22.8
 * bytes; demanding 8 leaves a real table nearly three times the room it uses
 * and still rejects the degenerate 3.
 */

console.log('\nBlock entries');

const MIN_BYTES_PER_ENTRY = 8;
const MAX_UNCOMPRESSED_BLOCK_BYTES = 64 * 1024 * 1024; // mirrors the decoder's own ceiling

const zeroBlock = Buffer.alloc(64 * 1024);
const zeroBlockEntries = blockEntries(zeroBlock).length;
const bytesPerEntry = zeroBlock.length / zeroBlockEntries;
check(
  'a zero-filled block does not amplify into unbounded entries',
  zeroBlockEntries <= zeroBlock.length / MIN_BYTES_PER_ENTRY,
  zeroBlockEntries === 0
    ? `0 entries from ${zeroBlock.length} bytes — a zero restart count reads as an empty block, as in LevelDB`
    : `${zeroBlockEntries} entries from ${zeroBlock.length} bytes, one per ${bytesPerEntry.toFixed(2)} — ` +
      `the ${MAX_UNCOMPRESSED_BLOCK_BYTES / (1024 * 1024)} MB ceiling admits ` +
      `${(MAX_UNCOMPRESSED_BLOCK_BYTES / bytesPerEntry / 1e6).toFixed(1)}M of them`,
);

/*
 * The case above is now stopped by its restart count, which only catches the
 * one shape a zero-filled region happens to have. This is the same degenerate
 * run of zero entries behind a well-formed trailer — one restart point at
 * offset 0 — so nothing structural is wrong with it and only the density
 * backstop stands between it and the allocation. It must be refused, and
 * refused early: the point of checking as it goes is that the memory is never
 * spent.
 */
{
  // An exact multiple of an entry's 3 bytes, so every entry is whole and no
  // structural check has anything to object to. At 64 KiB the last entry
  // straddled the trailer and the bounds check refused the block — but only
  // after building the other 21,845 entries, so this passed with the density
  // backstop removed entirely. Proven by deleting it.
  const ENTRY_REGION_BYTES = 3 * 21_845;
  const trailer = Buffer.alloc(8);
  trailer.writeUInt32LE(0, 0); // the one restart point, at offset 0
  trailer.writeUInt32LE(1, 4); // restart count
  const block = Buffer.concat([Buffer.alloc(ENTRY_REGION_BYTES), trailer]);
  let detail;
  let refused = false;
  try {
    detail = `returned ${blockEntries(block).length} entries`;
  } catch (err) {
    refused = !(err instanceof RangeError);
    detail = `${err.constructor.name}: ${err.message}`;
  }
  check('a dense block with a well-formed trailer is refused, not built', refused, detail);
}

// ── Tree building ────────────────────────────────────────────────────

console.log('\nTree building');

const P = (n) => `spotify:playlist:p${n}`;
const START = (id, name) => `spotify:start-group:${id}:${name}`;
const END = (id) => `spotify:end-group:${id}`;

/** Compact shape string, so a wrong tree prints as something readable. */
function shape(nodes) {
  return nodes
    .map((n) => (n.kind === 'playlist' ? n.uri.split(':').pop() : `${n.name}[${shape(n.children)}]`))
    .join(' ');
}

function tree(label, markers, wantShape, wantFolders, wantPlaylists) {
  const got = buildTree(markers);
  const gotShape = shape(got.nodes);
  check(
    label,
    gotShape === wantShape &&
      got.folderCount === wantFolders &&
      got.playlistCount === wantPlaylists,
    `${gotShape} | ${got.folderCount}f ${got.playlistCount}p`,
  );
}

tree('a flat list stays flat', [P(1), P(2), P(3)], 'p1 p2 p3', 0, 3);

tree(
  'one folder nests its playlists',
  [P(1), START('a1', 'Stuff'), P(2), P(3), END('a1'), P(4)],
  'p1 Stuff[p2 p3] p4',
  1,
  4,
);

tree(
  'folders nest arbitrarily deep',
  [START('a1', 'Outer'), P(1), START('b2', 'Inner'), P(2), END('b2'), P(3), END('a1')],
  'Outer[p1 Inner[p2] p3]',
  2,
  3,
);

tree('an empty folder survives', [START('a1', 'Empty'), END('a1')], 'Empty[]', 1, 0);

// Unbalanced input: the decoder reads a cache it doesn't own, so both of these
// are reachable from a truncated or half-compacted file.
tree(
  'an end-group with nothing open is ignored',
  [END('a1'), P(1), P(2)],
  'p1 p2',
  0,
  2,
);

tree(
  'a surplus end-group does not reparent what follows',
  [START('a1', 'Stuff'), P(1), END('a1'), END('a1'), P(2)],
  'Stuff[p1] p2',
  1,
  2,
);

tree(
  'a folder left open at EOF is closed implicitly',
  [P(1), START('a1', 'Stuff'), P(2), P(3)],
  'p1 Stuff[p2 p3]',
  1,
  3,
);

tree(
  'several folders left open at EOF all keep their children',
  [START('a1', 'Outer'), START('b2', 'Inner'), P(1)],
  'Outer[Inner[p1]]',
  2,
  1,
);

const idCheck = buildTree([START('14116c7c6be024b6', 'Stuff'), END('14116c7c6be024b6')]);
check(
  'a folder keeps its id',
  idCheck.nodes[0].id === '14116c7c6be024b6',
  idCheck.nodes[0].id,
);

// ── Folder names ─────────────────────────────────────────────────────

console.log('\nFolder names');

check("'+' decodes to a space", decodeFolderName('My+Folder') === 'My Folder', decodeFolderName('My+Folder'));
check('percent escapes decode', decodeFolderName('A%20B') === 'A B', decodeFolderName('A%20B'));
check(
  'a non-ASCII name decodes',
  decodeFolderName('Caf%C3%A9+Music') === 'Café Music',
  decodeFolderName('Caf%C3%A9+Music'),
);
check(
  'a malformed escape falls back to the raw name',
  decodeFolderName('%ZZ') === '%ZZ',
  decodeFolderName('%ZZ'),
);
check(
  'a lone % does not take the tree down with it',
  decodeFolderName('100%+Bangers') === '100%+Bangers',
  decodeFolderName('100%+Bangers'),
);

// ── The real cache, if this machine has one ──────────────────────────

console.log('\nLocal Spotify cache');

const result = await readSpotifyRootlist();

if (result.kind === 'unavailable' && result.reason !== 'unreadable') {
  // Must still pass: this runs in CI and on machines with no Spotify, or with
  // Spotify installed but never signed in. 'unreadable' is NOT skipped — that
  // one means the decoder itself gave up on a cache that is sitting right
  // there, which is the failure this check exists to catch.
  console.log(
    `  skip  no Spotify folder cache on this machine (${result.reason}) — decoder assertions above still ran`,
  );
} else {
  check('the cache decodes', result.kind === 'ok', result.kind === 'ok' ? '' : result.reason);
  if (result.kind === 'ok') {
    // Recount by walking the tree. A mismatch means nodes were counted but
    // never attached — the exact symptom of a stack that went out of step.
    let folders = 0;
    let playlists = 0;
    let deepest = 0;
    const walk = (nodes, depth) => {
      deepest = Math.max(deepest, depth);
      for (const n of nodes) {
        if (n.kind === 'playlist') playlists++;
        else {
          folders++;
          walk(n.children, depth + 1);
        }
      }
    };
    walk(result.nodes, 0);

    check('something was actually found', result.folderCount > 0 && result.playlistCount > 0,
      `${result.folderCount} folders, ${result.playlistCount} playlists`);
    check('every counted node is in the tree', folders === result.folderCount && playlists === result.playlistCount,
      `walked ${folders}f ${playlists}p`);
    check('no folder lost its id or name', (function ids(nodes) {
      return nodes.every((n) => n.kind === 'playlist' || (n.id.length > 0 && n.name.length > 0 && ids(n.children)));
    })(result.nodes));
    check('playlist uris are well formed',
      (function uris(nodes) {
        return nodes.every((n) =>
          n.kind === 'folder' ? uris(n.children) : /^spotify:playlist:[0-9A-Za-z]+$/.test(n.uri));
      })(result.nodes));

    const print = (nodes, indent) => {
      for (const n of nodes) {
        if (n.kind !== 'folder') continue;
        const loose = n.children.filter((c) => c.kind === 'playlist').length;
        console.log(`        ${indent}${n.name} (${loose} playlist${loose === 1 ? '' : 's'})`);
        print(n.children, indent + '  ');
      }
    };
    const rootLoose = result.nodes.filter((n) => n.kind === 'playlist').length;
    console.log(`\n        <root> (${rootLoose} playlists)`);
    print(result.nodes, '  ');
    console.log(`        depth ${deepest}\n`);
  }
}

cleanup();

console.log(
  failures === 0
    ? '\nAll playlist-folder checks passed.\n'
    : `\n${failures} playlist-folder check(s) FAILED.\n`,
);
process.exit(failures === 0 ? 0 : 1);

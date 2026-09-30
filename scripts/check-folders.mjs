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
 * The decoder only imports node builtins, so like check-enhancer.mjs it
 * compiles standalone and runs under plain node — no Electron, no bundler.
 *
 *   npm run check:folders
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
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
  const mod = await import(pathToFileURL(join(out, 'spotifyFolders.js')).href);
  return { mod, cleanup: () => rmSync(out, { recursive: true, force: true }) };
}

const { mod, cleanup } = await loadModule();
const { snappyDecompress, buildTree, decodeFolderName, readSpotifyRootlist } = mod;

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

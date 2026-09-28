#!/usr/bin/env node
/*
 * Pull one version's section out of CHANGELOG.md.
 *
 * The result is used twice per release: as the GitHub release body, and as an
 * asset the app fetches so it can tell the user what an update contains
 * before they take it. Both come from the same text so they cannot disagree.
 *
 *   node scripts/release-notes.mjs 1.4.1          print to stdout
 *   node scripts/release-notes.mjs v1.4.1 --check exit 1 if the section is missing
 *
 * Exits 1 when there is no section, so the release workflow can fail in
 * seconds rather than building for three minutes and publishing an update
 * whose prompt has nothing to say.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const raw = process.argv[2];
if (!raw) {
  console.error('usage: release-notes.mjs <version> [--check]');
  process.exit(2);
}

const version = raw.replace(/^v/, '');
const md = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');

// Heading for this version, up to the next h2 or the end of file.
const lines = md.split('\n');
const start = lines.findIndex((l) => l.trim() === `## ${version}`);
if (start === -1) {
  console.error(
    `::error::CHANGELOG.md has no "## ${version}" section. Add one before tagging — ` +
      `the in-app update prompt shows it, so a release without it tells users nothing.`,
  );
  process.exit(1);
}

const rest = lines.slice(start + 1);
const end = rest.findIndex((l) => l.startsWith('## '));
const body = (end === -1 ? rest : rest.slice(0, end)).join('\n').trim();

if (!body) {
  console.error(`::error::CHANGELOG.md section "## ${version}" is empty.`);
  process.exit(1);
}

if (!process.argv.includes('--check')) process.stdout.write(body + '\n');

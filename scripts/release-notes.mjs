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
 *   node scripts/release-notes.mjs v1.4.1 --class print "silent" or "prompt"
 *
 * Exits 1 when there is no section, so the release workflow can fail in
 * seconds rather than building for three minutes and publishing an update
 * whose prompt has nothing to say.
 *
 * The heading also carries how the update should be DELIVERED:
 *
 *   ## 1.4.4 (silent)   installs itself, no prompt
 *   ## 1.4.4 (prompt)   asks first, three-way dialog
 *
 * `--check` requires one of the two, so whoever cuts a release has to decide
 * rather than inherit a default. See "Update classification" in CLAUDE.md for
 * which to pick; the short version is that `silent` means a user would have
 * nothing to decide and nothing to learn.
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

// Heading for this version, up to the next h2 or the end of file. The
// optional trailing "(silent)" / "(prompt)" is the delivery class.
const lines = md.split('\n');
// Captures whatever is in the parentheses rather than only the two valid
// words, so a typo ("(SILENT)", "(silly)") is reported as a bad class instead
// of as a missing section — which is what it looked like, and sent you
// hunting for the wrong problem.
const headingRe = new RegExp(
  `^##\\s+${version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*(?:\\(([^)]*)\\))?\\s*$`,
);
const isHeading = (line) => headingRe.test(line.trim());

// Two sessions each adding a section for the same version is not
// hypothetical — it has happened. Without this the extractor silently takes
// the first one and the release ships somebody else's notes.
const duplicates = lines.filter(isHeading).length;
if (duplicates > 1) {
  console.error(
    `::error::CHANGELOG.md has ${duplicates} "## ${version}" sections. ` +
      `Merge them — only the first would be published.`,
  );
  process.exit(1);
}

const start = lines.findIndex(isHeading);
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

const declared = lines[start].trim().match(headingRe)?.[1]?.trim() ?? null;
const installClass = declared === 'silent' || declared === 'prompt' ? declared : null;

if (process.argv.includes('--class')) {
  // Absent is only tolerated here, for older releases whose headings predate
  // the classification. The --check gate below refuses it for a new one.
  process.stdout.write(`${installClass ?? 'prompt'}\n`);
  process.exit(0);
}

if (process.argv.includes('--check')) {
  if (declared !== null && installClass === null) {
    console.error(
      `::error::CHANGELOG.md heading "## ${version} (${declared})" has an ` +
        `unrecognised delivery class. It must be exactly "(silent)" or ` +
        `"(prompt)", lowercase.`,
    );
    process.exit(1);
  }
  if (installClass === null) {
    console.error(
      `::error::CHANGELOG.md heading "## ${version}" has no delivery class. ` +
        `Write "## ${version} (silent)" for a fix a user has nothing to decide ` +
        `about, or "## ${version} (prompt)" for anything they should see first. ` +
        `A silent release installs itself, so this cannot be left to a default. ` +
        `See "Update classification" in CLAUDE.md.`,
    );
    process.exit(1);
  }
  process.exit(0);
}

process.stdout.write(body + '\n');

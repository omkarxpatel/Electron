#!/usr/bin/env node
// Verifies that a release is actually consumable by the in-app updater.
//
// Exists because v1.1.0 shipped broken: the asset upload stalled partway
// through, `latest-mac.yml` never landed, and every installed app got a 404
// on its update check instead of being offered the new version. The build
// itself succeeded and the artifacts were all fine, so nothing in the build
// output hinted at it.
//
// Usage:
//   node scripts/verify-release.mjs v1.1.0                # local output vs. published assets
//   node scripts/verify-release.mjs v1.1.0 --remote-only  # no local build/ present
//   node scripts/verify-release.mjs v1.1.0 --deep         # also re-hash the published zips

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';

const CHANNEL_FILE = 'latest-mac.yml';
const OUT_DIR = 'release';

const args = process.argv.slice(2);
const tag = args.find((a) => !a.startsWith('--'));
const deep = args.includes('--deep');
const remoteOnly = args.includes('--remote-only');

if (!tag) {
  console.error('usage: node scripts/verify-release.mjs <tag> [--remote-only] [--deep]');
  process.exit(2);
}

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const { owner, repo } = pkg.build.publish;
const expectedVersion = tag.replace(/^v/, '');
const downloadUrl = (name) =>
  `https://github.com/${owner}/${repo}/releases/download/${tag}/${name}`;

const problems = [];
const fail = (msg) => {
  problems.push(msg);
  console.log(`  FAIL  ${msg}`);
};
const pass = (msg) => console.log(`  ok    ${msg}`);

function sha512OfFile(path) {
  return createHash('sha512').update(readFileSync(path)).digest('base64');
}

async function sha512OfUrl(url) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const hash = createHash('sha512');
  for await (const chunk of res.body) hash.update(chunk);
  return hash.digest('base64');
}

// MacUpdater picks its download by looking for "arm64" in the filename and
// otherwise takes the first non-arm64 zip. Both have to be listed or one of
// the two Mac architectures silently has no update path at all.
function checkArchCoverage(info, label) {
  const zips = (info.files ?? []).filter((f) => f.url.endsWith('.zip'));
  const arm = zips.find((f) => f.url.includes('arm64'));
  const intel = zips.find((f) => !f.url.includes('arm64'));
  if (arm) pass(`${label} lists an arm64 zip (${arm.url})`);
  else fail(`${label} lists no arm64 zip — Apple Silicon cannot auto-update`);
  if (intel) pass(`${label} lists an x64 zip (${intel.url})`);
  else fail(`${label} lists no x64 zip — Intel cannot auto-update`);
}

if (!remoteOnly) {
  // A tag that disagrees with package.json is the quietest way to ship a
  // no-op release: electron-builder names every artifact after package.json,
  // so the updater would never see the version the tag promised. Only
  // meaningful against the tree the artifacts were built from, which is why
  // --remote-only skips it.
  console.log('\nversion');
  if (pkg.version === expectedVersion) pass(`package.json ${pkg.version} matches ${tag}`);
  else fail(`package.json is ${pkg.version} but ${tag} promises ${expectedVersion}`);

  console.log(`\nlocal build output (${OUT_DIR}/)`);
  const ymlPath = join(OUT_DIR, CHANNEL_FILE);
  if (!existsSync(ymlPath)) {
    fail(`${ymlPath} was not generated — the updater would have nothing to read`);
  } else {
    const localYml = yaml.load(readFileSync(ymlPath, 'utf8'));
    if (localYml.version === expectedVersion) pass(`${CHANNEL_FILE} declares ${localYml.version}`);
    else fail(`${CHANNEL_FILE} declares ${localYml.version}, expected ${expectedVersion}`);

    checkArchCoverage(localYml, `local ${CHANNEL_FILE}`);

    for (const f of localYml.files ?? []) {
      const p = join(OUT_DIR, f.url);
      if (!existsSync(p)) {
        fail(`${f.url} is listed in ${CHANNEL_FILE} but was not built`);
      } else if (statSync(p).size !== f.size) {
        fail(`${f.url} is ${statSync(p).size} B on disk, ${CHANNEL_FILE} says ${f.size} B`);
      } else if (sha512OfFile(p) !== f.sha512) {
        fail(`${f.url} sha512 disagrees with ${CHANNEL_FILE}`);
      } else {
        pass(`${f.url} matches its ${CHANNEL_FILE} entry`);
      }
    }
  }
}

console.log(`\npublished release ${tag}`);
let view = null;
try {
  view = JSON.parse(
    execFileSync(
      'gh',
      ['release', 'view', tag, '--repo', `${owner}/${repo}`, '--json', 'assets,isDraft,isPrerelease'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    ),
  );
} catch {
  fail(`no release found for ${tag} in ${owner}/${repo}`);
}

if (view) {
  if (view.isDraft) fail('release is a draft — GitHub\'s "latest" pointer skips drafts');
  else pass('release is published, not a draft');
  if (view.isPrerelease) fail('release is a pre-release — GitHub\'s "latest" pointer skips pre-releases');
  else pass('release is not a pre-release');

  const assets = new Map(view.assets.map((a) => [a.name, a]));

  if (!assets.has(CHANNEL_FILE)) {
    fail(`${CHANNEL_FILE} is not attached to the release — every update check will 404`);
  } else {
    pass(`${CHANNEL_FILE} is attached`);

    // Fetch it the way a shipped app does, rather than trusting the asset
    // list: this is the exact request that 404'd for v1.1.0.
    const res = await fetch(downloadUrl(CHANNEL_FILE), { redirect: 'follow' });
    if (!res.ok) {
      fail(`${CHANNEL_FILE} returns HTTP ${res.status} from the URL clients request`);
    } else {
      pass(`${CHANNEL_FILE} is served over the client download URL`);
      const served = yaml.load(await res.text());

      if (served.version === expectedVersion) pass(`served ${CHANNEL_FILE} declares ${served.version}`);
      else fail(`served ${CHANNEL_FILE} declares ${served.version}, expected ${expectedVersion}`);

      checkArchCoverage(served, `served ${CHANNEL_FILE}`);

      for (const f of served.files ?? []) {
        const asset = assets.get(f.url);
        if (!asset) {
          fail(`${f.url} is listed in ${CHANNEL_FILE} but is not attached to the release`);
        } else if (asset.size !== f.size) {
          fail(`${f.url} is ${asset.size} B on the release, ${CHANNEL_FILE} says ${f.size} B`);
        } else {
          pass(`${f.url} is attached at the declared size`);
        }
      }

      if (deep) {
        console.log('\nre-hashing published zips (--deep)');
        for (const f of (served.files ?? []).filter((x) => x.url.endsWith('.zip'))) {
          try {
            const actual = await sha512OfUrl(downloadUrl(f.url));
            if (actual === f.sha512) pass(`${f.url} sha512 matches what clients verify`);
            else fail(`${f.url} sha512 mismatch — clients will reject the download`);
          } catch (err) {
            fail(`${f.url} could not be re-hashed: ${err.message}`);
          }
        }
      }
    }
  }
}

console.log('');
if (problems.length > 0) {
  console.error(`${problems.length} problem(s) — ${tag} is not safely auto-updatable:`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`${tag} is consumable by the in-app updater.`);

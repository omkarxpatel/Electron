import { net } from 'electron';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, mkdtemp, open, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import yaml from 'js-yaml';

/**
 * macOS update mechanics, without Squirrel.
 *
 * electron-updater delegates the actual install to Electron's native
 * autoUpdater — Squirrel.Mac — which refuses to swap a bundle whose code
 * signature it can't validate against the running app's. This app ships
 * unsigned (no Apple Developer ID), so that path always fails *after* a
 * successful download: check ✓, download ✓, install ✗.
 *
 * So we do the swap ourselves:
 *   1. Read `latest-mac.yml` off the newest GitHub release. That URL resolves
 *      through GitHub's "latest release" pointer, which already excludes
 *      drafts and pre-releases, so there's no feed logic to get wrong.
 *   2. Download the zip for this Mac's architecture and check it against the
 *      sha512 the feed declares. A bundle that fails the hash is never
 *      unpacked.
 *   3. Unpack with `ditto`. A .app is full of symlinks (Contents/Frameworks)
 *      that a naive unzip flattens or breaks.
 *   4. Hand the swap to a detached `/bin/sh` that outlives us: it waits for
 *      our PID to exit, moves the old bundle aside, dittos the new one into
 *      place, and relaunches. The old bundle is only deleted once the new one
 *      has landed, so a failed copy rolls back rather than leaving the user
 *      with no app at all.
 *
 * None of this needs a code signature. It's safe for an unsigned app because
 * macOS only Gatekeeper-checks bundles carrying `com.apple.quarantine`, and
 * that flag is applied by browsers and other downloaders — not by our own
 * fetch. We strip it from the new bundle anyway, belt and braces, which is
 * also what spares users the `xattr -cr` dance they need for a manual install.
 */

const execFileAsync = promisify(execFile);

const CHANNEL_FILE = 'latest-mac.yml';
const PROGRESS_INTERVAL_MS = 250;

export interface RemoteUpdate {
  version: string;
  zipUrl: string;
  sha512: string;
  size: number;
}

export interface DownloadProgress {
  percent: number;
  bytesPerSecond: number;
  transferred: number;
  total: number;
}

export interface StagedUpdate {
  /** The unpacked .app waiting to be swapped in. */
  appPath: string;
  /** The temp directory holding it; removed once the swap completes. */
  stageRoot: string;
  /** The bundle it will replace. */
  bundlePath: string;
}

interface ChannelEntry {
  url?: unknown;
  sha512?: unknown;
  size?: unknown;
}

/** …/Electron.app/Contents/MacOS/Electron → …/Electron.app */
function currentBundlePath(): string | null {
  const bundle = resolve(process.execPath, '..', '..', '..');
  return bundle.endsWith('.app') ? bundle : null;
}

/**
 * Whether we can actually perform the swap, checked *before* offering the
 * update. An app running from a read-only volume or owned by another user
 * can download all day and never install, and finding that out at the end is
 * the worst time to find it out.
 */
export async function findReplaceableBundle(): Promise<
  { ok: true; bundlePath: string } | { ok: false; reason: string }
> {
  const bundlePath = currentBundlePath();
  if (bundlePath === null) {
    return { ok: false, reason: 'This build is not running from a .app bundle.' };
  }
  try {
    await access(bundlePath, constants.W_OK);
    await access(dirname(bundlePath), constants.W_OK);
  } catch {
    return {
      ok: false,
      reason: `No write access to ${bundlePath}. Move the app into /Applications under your own account, or install this update by hand.`,
    };
  }
  return { ok: true, bundlePath };
}

/**
 * The newest published release, or null when it isn't newer than `version`.
 * Throws on network/parse failures so the caller can categorize and retry.
 */
export async function fetchLatestUpdate(repoUrl: string): Promise<RemoteUpdate> {
  const res = await net.fetch(`${repoUrl}/releases/latest/download/${CHANNEL_FILE}`);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} fetching ${CHANNEL_FILE}`);
  }

  const parsed = yaml.load(await res.text()) as { version?: unknown; files?: unknown } | null;
  const version = typeof parsed?.version === 'string' ? parsed.version : null;
  if (version === null) {
    throw new Error(`${CHANNEL_FILE} has no version field`);
  }

  const files = Array.isArray(parsed?.files) ? (parsed.files as ChannelEntry[]) : [];
  const zips = files.filter(
    (f): f is { url: string; sha512: unknown; size: unknown } =>
      typeof f?.url === 'string' && f.url.endsWith('.zip'),
  );

  // The naming convention our artifactName produces, and the one
  // electron-updater assumed: the arm64 build carries "arm64" in its
  // filename and the Intel build doesn't. Under Rosetta process.arch is
  // "x64", which is the right answer — we replace like for like.
  const wantArm64 = process.arch === 'arm64';
  const match = zips.find((f) => f.url.includes('arm64') === wantArm64);
  if (match === undefined) {
    throw new Error(`${CHANNEL_FILE} lists no ${wantArm64 ? 'arm64' : 'x64'} zip`);
  }
  if (typeof match.sha512 !== 'string' || typeof match.size !== 'number') {
    throw new Error(`${CHANNEL_FILE} entry for ${match.url} is missing its sha512 or size`);
  }

  return {
    version,
    // Same "latest" pointer as the feed, so we never have to assume how the
    // release tag is spelled.
    zipUrl: `${repoUrl}/releases/latest/download/${match.url}`,
    sha512: match.sha512,
    size: match.size,
  };
}

/** Downloads to a temp dir and verifies the hash. Returns the zip's path. */
export async function downloadUpdate(
  update: RemoteUpdate,
  onProgress: (p: DownloadProgress) => void,
): Promise<{ zipPath: string; stageRoot: string }> {
  const stageRoot = await mkdtemp(join(tmpdir(), 'audio-visualizer-update-'));
  const zipPath = join(stageRoot, basename(update.zipUrl));

  const res = await net.fetch(update.zipUrl);
  if (!res.ok || res.body === null) {
    await rm(stageRoot, { recursive: true, force: true });
    throw new Error(`HTTP ${res.status} downloading ${basename(update.zipUrl)}`);
  }

  const hash = createHash('sha512');
  const handle = await open(zipPath, 'w');
  const reader = res.body.getReader();
  const startedAt = Date.now();
  let transferred = 0;
  let lastEmit = 0;

  const emit = (): void => {
    const elapsed = (Date.now() - startedAt) / 1000;
    onProgress({
      percent: update.size > 0 ? (transferred / update.size) * 100 : 0,
      bytesPerSecond: elapsed > 0 ? transferred / elapsed : 0,
      transferred,
      total: update.size,
    });
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      hash.update(chunk);
      await handle.write(chunk);
      transferred += chunk.length;
      // Throttled: a 100 MB download is thousands of chunks, and the renderer
      // only needs enough to animate a progress bar.
      if (Date.now() - lastEmit >= PROGRESS_INTERVAL_MS) {
        lastEmit = Date.now();
        emit();
      }
    }
  } catch (err) {
    await handle.close();
    await rm(stageRoot, { recursive: true, force: true });
    throw err;
  }
  await handle.close();
  emit();

  if (hash.digest('base64') !== update.sha512) {
    await rm(stageRoot, { recursive: true, force: true });
    throw new Error(
      'The downloaded update did not match the checksum published with the release, so it was discarded.',
    );
  }

  return { zipPath, stageRoot };
}

/** Unpacks the verified zip and locates the .app inside it. */
export async function stageUpdate(
  zipPath: string,
  stageRoot: string,
  bundlePath: string,
): Promise<StagedUpdate> {
  const unpacked = join(stageRoot, 'unpacked');
  await execFileAsync('ditto', ['-x', '-k', zipPath, unpacked]);
  const appName = (await readdir(unpacked)).find((entry) => entry.endsWith('.app'));
  if (appName === undefined) {
    throw new Error('The update archive did not contain an .app bundle');
  }
  return { appPath: join(unpacked, appName), stageRoot, bundlePath };
}

export async function discardStagedUpdate(staged: StagedUpdate): Promise<void> {
  await rm(staged.stageRoot, { recursive: true, force: true });
}

// Positional args rather than interpolation: these paths contain spaces in
// any normal install ("/Applications/Audio Visualizer.app"), and a quoting
// slip here would delete the wrong directory.
const SWAP_SCRIPT = `
set -u
pid=$1
staged=$2
target=$3
stage_root=$4

# Don't touch the bundle until the process running from it is gone.
i=0
while kill -0 "$pid" 2>/dev/null && [ "$i" -lt 300 ]; do
  sleep 0.1
  i=$((i + 1))
done

backup="$target.replaced-$$"
if ! /bin/mv "$target" "$backup"; then
  # Couldn't even move it; leave everything alone and put the app back up.
  /usr/bin/open "$target"
  exit 1
fi

if /usr/bin/ditto "$staged" "$target"; then
  /usr/bin/xattr -dr com.apple.quarantine "$target" 2>/dev/null
  /bin/rm -rf "$backup"
else
  # Roll back rather than leave the user with no app.
  /bin/rm -rf "$target"
  /bin/mv "$backup" "$target"
fi

/bin/rm -rf "$stage_root"
/usr/bin/open "$target"
`;

/**
 * Spawns the detached swapper and returns immediately. The caller is expected
 * to quit right after: the script blocks until this process exits.
 */
export function applyStagedUpdate(staged: StagedUpdate): void {
  const child = spawn(
    '/bin/sh',
    ['-c', SWAP_SCRIPT, 'update-swap', String(process.pid), staged.appPath, staged.bundlePath, staged.stageRoot],
    { detached: true, stdio: 'ignore' },
  );
  child.unref();
}

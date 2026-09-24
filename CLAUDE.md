# CLAUDE.md

Project-specific context for agentic sessions. Merge with the global guidelines in `~/CLAUDE.md`.

This file exists to stop you rediscovering the same traps. Most of what's here was learned the
expensive way — by shipping something broken and finding out weeks later.

---

## What this is

A macOS Electron app: local audio visualizer + system-wide EQ + a Spotify control surface.
React 19 + Vite renderer, TypeScript main process, packaged with electron-builder.

- `electron/` — main process (`main.ts`), preload bridge, auto-updater.
- `src/` — renderer. `state/` holds hook-based stores, `audio/` the Web Audio graph,
  `spotify/` the API client, `visualizers/` the render modes, `components/` the UI.
- `src/types/api.d.ts` — the single source of truth for the preload API contract.

Audio capture needs **BlackHole** (a virtual audio device). It is not optional; without it
Live mode feeds back on itself. Don't "simplify" it away.

---

## Verifying your work

**There is no test suite.** No Jest, no Vitest, no test script. Don't claim tests pass.

Verification here means:

1. `npm run typecheck` — must be clean.
2. `npm run check:enhancer` — if you touched `useAiEnhancer`, `enhanceProfiles`
   or `biquadResponse`. Asserts the AI Enhancer's target curves and its
   curve→filter-gain solver against measured thresholds. Typecheck can't tell
   you a filter delivers the wrong curve; every case it guards shipped silently
   once already.
3. Run the app and look at it. See below, because launching it has traps.

If you change the updater or the release pipeline, also run
`node scripts/verify-release.mjs <tag> --remote-only` against a real tag.

---

## Running the app locally

```bash
npm run dev                      # vite + electron, hot reload
npm run build:unpack             # packaged .app in release/mac-arm64/, no dmg
```

Three traps, all of which will waste your time:

**`ELECTRON_RUN_AS_NODE=1` leaks into VSCode terminals.** If it's set, Electron runs as plain
Node, your app never starts, and you get either silence or `bad option:`. `vite.config.ts`
strips it for `npm run dev`, but if you launch a built binary yourself you must do it:

```bash
env -u ELECTRON_RUN_AS_NODE ./release/mac-arm64/Electron.app/Contents/MacOS/Electron
```

**A single-instance lock is held app-wide.** If a dev instance is already running, your second
launch quits immediately and silently. Pass `--user-data-dir=/tmp/whatever` to run a second
copy in isolation.

**`npm run dev` kills other Electron instances from this repo.** `killStaleInstances()` in
`main.ts` pgreps for `node_modules/electron/.../MacOS/Electron` and SIGTERMs them. This is
deliberate (HMR pile-up), but it means starting a dev run will kill the user's existing one.
Ask before you do that.

---

## Landmine: `app.isPackaged` is always false

`build.productName` is `"Electron"`, so the packaged binary is `Electron.app/Contents/MacOS/Electron`.
Electron computes `app.isPackaged` as `basename(execPath).toLowerCase() !== 'electron'` — which
is **permanently false in every shipped build**.

Nothing errors. The code just silently takes the dev branch forever. This disabled auto-update
in every release up to 1.1.0 and nobody noticed for months.

**Never use `app.isPackaged` in this repo.** Use:

```ts
process.defaultApp !== true   // true in a shipped build, false under `electron <path>`
```

`electron/updater.ts` has this as `isPackagedBuild()`. Other call sites in `main.ts` (tray icon
path, about-panel icon, dev-only menu items) were still on the broken check as of 2026-09-18 —
check before assuming they're fixed.

A real fix for all of it is `build.mac.executableName`, which renames the binary while keeping
`productName`. Note it also renames the `.app` bundle, and that `userData` lives at
`~/Library/Application Support/Electron` — derived from `productName`, so don't change that
without a migration or every user loses their settings and Spotify sign-in.

---

## Auto-update: how it works

The app is **unsigned** (no Apple Developer ID). That is a deliberate, reaffirmed decision.

This matters because `electron-updater` delegates installs on macOS to Squirrel.Mac, which
validates code signatures and will refuse to swap an unsigned bundle. It was removed. Do not
add it back to "simplify" the updater — you will silently reintroduce an install path that
always fails after a successful download.

`electron/updateInstaller.ts` does the whole job instead:

1. Read `latest-mac.yml` from `<repo>/releases/latest/download/`. GitHub's "latest" pointer
   already excludes drafts and pre-releases, so there is no feed logic to get wrong.
2. Pick the zip whose filename matches `process.arch` (`arm64` in the name, or not).
3. Download, verify sha512. A mismatch is discarded, never unpacked.
4. Unpack with `ditto` — a `.app` is full of symlinks that plain unzip breaks.
5. Spawn a **detached** `/bin/sh` that waits for our PID to exit, moves the old bundle aside,
   dittos the new one in, strips `com.apple.quarantine`, and relaunches. If the copy fails it
   rolls back, so the user is never left without an app.

This is safe unsigned because macOS only Gatekeeper-checks bundles carrying
`com.apple.quarantine`, and that flag comes from browsers — not from our own download.

`electron/updater.ts` owns the state machine, the three-way prompt, skip persistence and the
IPC surface. Its `UpdateState` union is mirrored in `src/types/api.d.ts` and rendered by
`src/components/UpdateBanner.tsx`. **If you change the union, change all three.**

---

## Shipping a release

```bash
# 1. bump "version" in package.json
# 2. commit + push to main
git tag v1.2.0 && git push origin v1.2.0
```

The tag push triggers `.github/workflows/release.yml`, which:

1. Checks out the tag (a manual `workflow_dispatch` run uses its `tag` input — it used to
   accept the input and silently build `main` instead).
2. Fails in ~30s if the tag doesn't match `package.json`. electron-builder names artifacts
   after `package.json`, so a mismatch publishes a release no client will ever see.
3. Typechecks, then `npm run build:release` (`electron-builder --publish=never`).
4. `scripts/publish-release.sh` uploads via `gh` with per-file retry, `latest-mac.yml` **last**,
   so a partial upload never advertises files that aren't there.
5. `scripts/verify-release.mjs` re-fetches the release the way a shipped app does and fails the
   job if it isn't installable.

Things worth knowing:

- **`--publish=never` still generates `latest-mac.yml`.** The update-info task sits outside the
  `isPublish` branch in electron-builder's `PublishManager`. Build and upload are decoupled on
  purpose: electron-builder's own publisher timed out mid-upload on v1.1.0 and left the release
  without its metadata, which 404'd every client's update check.
- **CI-built zips are not byte-identical to local builds.** Never hand-upload a locally
  generated `latest-mac.yml` onto a CI-built release; the sha512 won't match and every client
  will reject the download.
- **`macos-14` is pinned deliberately.** `macos-latest` rolled to Sequoia and dmg-builder hits
  an intermittent `FileNotFoundError` on the DMG background there.
- `build.publish` in `package.json` must stay, even though electron-builder no longer uploads —
  it's what makes `latest-mac.yml` get generated at all.

Check any release with:

```bash
node scripts/verify-release.mjs v1.2.0 --remote-only --deep
```

---

## Conventions

**Comments explain why, and name the failure.** This codebase's dominant style is a comment
that says what went wrong and why the code is shaped this way — see `electron/updater.ts`,
`vite.config.ts`, the `macos-14` pin. Match it. A comment restating what the line does is noise;
a comment naming the bug it prevents is the point.

**Visualizers are additive.** Add new visual modes. Don't rework existing ones.

**User-facing controls are honest.** A knob labelled as a multiplier is a literal multiplier.
Don't add protective limiters downstream that make the label a lie.

Also:

- Section dividers: `// ── Name ─────────`.
- Constants carry units in the name: `INITIAL_CHECK_DELAY_MS`, not `INITIAL_DELAY`.
- State is modelled as discriminated unions (`kind: '...'`), not booleans.
- The preload bridge returns `unknown`; types are declared once in `src/types/api.d.ts` so main
  and renderer can't drift.
- State lives in hook modules under `src/state/`, not a global store.

---

## Don't commit

`release/`, `dist/`, `dist-electron/` are build output. The internal planning docs at the repo
root (`HANDOFF.md`, `MASTER_OPTIMIZATION_ROADMAP.md`, `IMPLEMENTATION_PHASES.md`,
`RISKY_CHANGES.md`, `DEEP_REFACTOR_CANDIDATES.md`, `QUICK_WINS_CHECKLIST.md`,
`PERFORMANCE_PROFILING_PLAN.md`, `CLAUDE_CHANGES/`, `CODEX_CHANGES/`) are gitignored on purpose —
they are working notes, not public docs. Don't un-ignore them.

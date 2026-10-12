#!/usr/bin/env node
/**
 * Regression check for the lyrics contrast floor in `src/shared/contrast.ts`.
 *
 * There is no test suite here, and `npm run typecheck` cannot tell you that a
 * colour came back the wrong shade. Every failure this guards is silent — the
 * app renders, nothing throws, the lyrics are just the wrong colour:
 *
 *   - an accent that already reads well comes back ALTERED. This is the
 *     expensive one. The whole point of a floor is that it does nothing to
 *     the colours that are fine; a solver that nudges every input re-themes
 *     every palette in the app and the complaint it was built to fix becomes
 *     "why is my palette the wrong green now".
 *   - a lifted accent that still misses the target. Nothing errors — the line
 *     is simply still too dark, which is the bug this file exists to prevent.
 *   - a lift that overshoots to near-white, or that drifts hue. Both destroy
 *     the thing the feature is for: it should still be the album's colour.
 *   - the luminance maths being wrong in a way that is self-consistent. The
 *     WCAG vectors below are the guard: they come from the specification's
 *     own worked values, not from this implementation.
 *
 * What it CANNOT prove is that LYRIC_SURFACE still matches what the app
 * actually renders behind the lyrics. That is a pixel measurement off a real
 * window — `npm run capture -- --only lyrics`, then sample the pane. The
 * constant's comment says so too.
 *
 * `contrast.ts` imports nothing and `palettes.ts` only `import type`s, which
 * TypeScript erases, so both compile standalone and run under plain node — no
 * Electron, no bundler. Keep them that way or this check drops out.
 *
 *   npm run check:contrast
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

async function loadModules() {
  const out = mkdtempSync(join(tmpdir(), 'contrast-check-'));
  execFileSync(
    'npx',
    [
      'tsc',
      'src/shared/contrast.ts', 'src/visualizers/palettes.ts',
      '--outDir', out,
      '--module', 'esnext',
      '--target', 'es2022',
      '--moduleResolution', 'bundler',
      '--lib', 'es2022,dom',
    ],
    { stdio: 'pipe' },
  );
  const contrast = await import(pathToFileURL(join(out, 'shared/contrast.js')).href);
  const palettes = await import(pathToFileURL(join(out, 'visualizers/palettes.js')).href);
  return { contrast, palettes, cleanup: () => rmSync(out, { recursive: true, force: true }) };
}

const { contrast, palettes, cleanup } = await loadModules();
const {
  contrastRatio, relativeLuminance, liftToContrast, readableLyricAccent,
  LYRIC_SURFACE, LYRIC_MIN_CONTRAST, LYRIC_TARGET_CONTRAST,
} = contrast;
const { PALETTES } = palettes;

// ── WCAG vectors ─────────────────────────────────────────────────────
// Values from WCAG 2.1's own definitions, not from this implementation.
// Luminance is defined as exactly 0 for black and exactly 1 for white, and
// #767676 is the canonical darkest grey that still clears 4.5:1 on white —
// one step lighter (#777777) does not.

console.log('\nWCAG luminance and ratio');
check('black luminance is 0', relativeLuminance('#000000') === 0);
check('white luminance is 1', Math.abs(relativeLuminance('#ffffff') - 1) < 1e-12);
check('mid grey luminance', Math.abs(relativeLuminance('#808080') - 0.2158) < 5e-4,
  relativeLuminance('#808080').toFixed(4));
check('white on black is 21:1', Math.abs(contrastRatio('#ffffff', '#000000') - 21) < 1e-9);
check('a colour against itself is 1:1', contrastRatio('#3a7d5c', '#3a7d5c') === 1);
check('ratio is symmetric',
  contrastRatio('#ffffff', '#123456') === contrastRatio('#123456', '#ffffff'));
check('#767676 on white clears AA', contrastRatio('#767676', '#ffffff') >= 4.5,
  contrastRatio('#767676', '#ffffff').toFixed(3));
check('#777777 on white does not', contrastRatio('#777777', '#ffffff') < 4.5,
  contrastRatio('#777777', '#ffffff').toFixed(3));

// ── The promise: legible palettes are untouched ──────────────────────
// stops[0] is what App.tsx feeds in as --accent-bright. If any built-in
// palette starts coming back altered, the user's chosen theme has quietly
// changed colour and this is the only place that would say so.

console.log('\nBuilt-in palettes pass through unaltered');
for (const [id, p] of Object.entries(PALETTES)) {
  // `custom` is a placeholder — the live custom palette is synthesized from
  // the user's own three stops — and the defaults behind it are themselves
  // one of the two casualties this feature exists for. It is asserted
  // separately below, as a colour that SHOULD change.
  if (id === 'custom') continue;
  const accent = p.stops[0].color;
  const out = readableLyricAccent(accent);
  const r = contrastRatio(accent, LYRIC_SURFACE);
  check(`${id} ${accent}`, out === accent, `${r.toFixed(2)}:1`);
}

// ── The fix: unreadable accents are lifted, and properly ─────────────
// The sweep covers everything extractPalette can emit: MIN_SATURATION 0.22
// to 1, MIN_LIGHTNESS 0.18 to MAX_LIGHTNESS 0.88, every hue.

console.log('\nLift behaviour across extractPalette\'s whole output space');
let swept = 0, lifted = 0;
let worstAfter = Infinity, hueDrift = 0, satDrift = 0, maxLightness = 0, maxOvershoot = 0, overshoot = 0;
// Control. Rounding a colour to `#rrggbb` at all moves its hue and saturation
// a little, so "the lift preserves hue" can only mean "by no more than
// writing the colour down does". Measured over the same sweep so the bar
// cannot drift away from the thing it is measuring.
let qHueDrift = 0, qSatDrift = 0;
for (let hDeg = 0; hDeg < 360; hDeg += 5) {
  for (let s = 0.22; s <= 1.0001; s += 0.06) {
    for (let l = 0.18; l <= 0.8801; l += 0.02) {
      const input = hslToHex(hDeg / 360, s, l);
      const [qh, qs] = rgbToHsl(input);
      qHueDrift = Math.max(qHueDrift, circleDelta(qh, hDeg / 360));
      qSatDrift = Math.max(qSatDrift, Math.abs(qs - s));
      const out = readableLyricAccent(input);
      swept++;
      if (out === input) {
        // Untouched means it must already have cleared the trigger.
        if (contrastRatio(input, LYRIC_SURFACE) < LYRIC_MIN_CONTRAST) overshoot++;
        continue;
      }
      lifted++;
      const after = contrastRatio(out, LYRIC_SURFACE);
      worstAfter = Math.min(worstAfter, after);
      const [h0, s0, l0] = rgbToHsl(out);
      // Hue is compared on the circle; a near-grey has no meaningful hue, but
      // nothing in this sweep is near-grey (saturation starts at 0.22).
      hueDrift = Math.max(hueDrift, circleDelta(h0, hDeg / 360));
      satDrift = Math.max(satDrift, Math.abs(s0 - s));
      maxLightness = Math.max(maxLightness, l0);
      // Minimal: landing ON the target, not past it. Measured as the overshoot
      // itself rather than by stepping lightness back down and re-quantising —
      // near the boundary that round trip lands on the same hex and reads as a
      // failure when nothing is wrong. A solver that washed colours out toward
      // white would overshoot by whole ratio points, not hundredths.
      maxOvershoot = Math.max(maxOvershoot, after - LYRIC_TARGET_CONTRAST);
    }
  }
}
check('every input was classified', overshoot === 0, `${swept} swept, ${lifted} lifted`);
check('every lift clears the target', worstAfter >= LYRIC_TARGET_CONTRAST,
  `worst ${worstAfter.toFixed(3)} vs ${LYRIC_TARGET_CONTRAST}`);
check('hue drifts no more than writing the colour to hex does',
  hueDrift <= qHueDrift, `lift ${(hueDrift * 360).toFixed(2)}° vs quantisation ${(qHueDrift * 360).toFixed(2)}°`);
check('saturation drift stays at quantisation scale',
  satDrift < qSatDrift * 2, `lift ${satDrift.toFixed(4)} vs quantisation ${qSatDrift.toFixed(4)}`);
check('no lift reaches white', maxLightness < 0.95, `max lightness ${maxLightness.toFixed(3)}`);
// One 8-bit step of lightness is worth roughly 0.1 of contrast ratio here, so
// this bound is "within a step or two", not a tolerance picked to pass.
check('every lift is minimal', maxOvershoot < 0.25,
  `max overshoot ${maxOvershoot.toFixed(3)} past ${LYRIC_TARGET_CONTRAST}`);

// ── The case that was reported ───────────────────────────────────────
// #376d54 is not synthetic: it is the accent the app derived from a real
// sleeve, read back out of the lyrics pane in `npm run capture --only lyrics`
// with a colour picker. It rendered at 3.10:1 against that pane while the
// INACTIVE lines either side sat at 8.6:1 — the highlight was the faintest
// line on screen, which is what started this.

console.log('\nThe reported case');
const reported = '#376d54';
check('reported accent fails the floor', contrastRatio(reported, LYRIC_SURFACE) < LYRIC_MIN_CONTRAST,
  `${contrastRatio(reported, LYRIC_SURFACE).toFixed(2)}:1`);
const fixed = readableLyricAccent(reported);
check('and is lifted past the target', contrastRatio(fixed, LYRIC_SURFACE) >= LYRIC_TARGET_CONTRAST,
  `${reported} -> ${fixed}, ${contrastRatio(fixed, LYRIC_SURFACE).toFixed(2)}:1`);
check('still clearly the same green', circleDelta(rgbToHsl(fixed)[0], rgbToHsl(reported)[0]) * 360 < 1.0);

// The other real-world casualty: the DEFAULT custom palette, which anyone who
// opens the custom colour pickers starts from.
const customLow = PALETTES.custom.stops[0].color;
check('default custom accent is handled',
  contrastRatio(readableLyricAccent(customLow), LYRIC_SURFACE) >= LYRIC_MIN_CONTRAST,
  `${customLow} ${contrastRatio(customLow, LYRIC_SURFACE).toFixed(2)}:1 -> ${contrastRatio(readableLyricAccent(customLow), LYRIC_SURFACE).toFixed(2)}:1`);

// ── Inputs that are not colours ──────────────────────────────────────
// customColors comes out of a persisted settings blob, so a hand-edited or
// migrated profile can put anything here. Crashing the renderer over it would
// be far worse than the colour being wrong.

console.log('\nMalformed input');
for (const bad of ['', 'red', '#fff', '#12345g', 'rgb(1,2,3)', '#1234567']) {
  let out, threw = false;
  try { out = readableLyricAccent(bad); } catch { threw = true; }
  check(`${JSON.stringify(bad)} does not throw`, !threw, threw ? '' : `-> ${JSON.stringify(out)}`);
}
check('a malformed accent is passed through, not mangled',
  readableLyricAccent('red') === 'red');

// ── Helpers (independent of the module under test) ───────────────────

function hslToHex(h, s, l) {
  if (s === 0) { const v = Math.round(l * 255); return `#${h2(v)}${h2(v)}${h2(v)}`; }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const ch = (t) => {
    let x = t; if (x < 0) x += 1; if (x > 1) x -= 1;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  return `#${h2(Math.round(ch(h + 1 / 3) * 255))}${h2(Math.round(ch(h) * 255))}${h2(Math.round(ch(h - 1 / 3) * 255))}`;
}
function h2(n) { return Math.max(0, Math.min(255, n)).toString(16).padStart(2, '0'); }
function rgbToHsl(hex) {
  const rn = parseInt(hex.slice(1, 3), 16) / 255;
  const gn = parseInt(hex.slice(3, 5), 16) / 255;
  const bn = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn), l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === rn) h = (gn - bn) / d + (gn < bn ? 6 : 0);
  else if (max === gn) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;
  return [h / 6, s, l];
}
function circleDelta(a, b) { const d = Math.abs(a - b); return d > 0.5 ? 1 - d : d; }

cleanup();
console.log(
  failures === 0
    ? `\nAll checks passed. Surface ${LYRIC_SURFACE}, floor ${LYRIC_MIN_CONTRAST}:1, target ${LYRIC_TARGET_CONTRAST}:1.`
    : `\n${failures} check(s) FAILED.`,
);
process.exit(failures === 0 ? 0 : 1);

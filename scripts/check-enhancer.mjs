#!/usr/bin/env node
/**
 * Regression check for the AI Enhancer's DSP math.
 *
 * There is no test suite in this repo and `npm run typecheck` can't tell you
 * that a filter delivers the wrong curve. Every bug this file guards against
 * shipped silently once already:
 *
 *   - the target curve was pink noise, which asks for ~13 dB more 16 kHz than
 *     any real master has;
 *   - the solved band gains could exceed the enhancer's own ±12 dB clamp, so
 *     the curve delivered wasn't the curve requested;
 *   - a centres-only fit drove the shelf bands to twice the gain they needed,
 *     which the headroom trim then took straight back off the whole signal.
 *
 * `src/audio/biquadResponse.ts` and `src/audio/enhanceProfiles.ts` have no
 * imports, so they compile standalone and run under plain node — no bundler,
 * no browser, no AudioContext.
 *
 *   npm run check:enhancer
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const SAMPLE_RATE = 48000;

/** Must stay in step with TOTAL_CEILING in useAiEnhancer.ts. A solved gain
 *  past this gets clamped, and a clamped band is a curve we didn't intend. */
const DELTA_CLAMP_DB = 12;

/** The three shipped band layouts, mirroring state/eq.ts. */
const LAYOUTS = [
  {
    name: '10-band',
    freqs: [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000],
    q: 1.41,
  },
  {
    name: '15-band',
    freqs: [25, 40, 63, 100, 160, 250, 400, 630, 1000, 1600, 2500, 4000, 6300, 10000, 16000],
    q: 2.87,
  },
  {
    name: '31-band',
    freqs: [
      20, 25, 31.5, 40, 50, 63, 80, 100, 125, 160, 200, 250, 315, 400, 500,
      630, 800, 1000, 1250, 1600, 2000, 2500, 3150, 4000, 5000, 6300, 8000,
      10000, 12500, 16000, 20000,
    ],
    q: 4.32,
  },
];

/** Quiet-listening curve from useAiEnhancer.ts — the largest shape the
 *  enhancer can stack on top of a match correction. */
const LOUDNESS = [4, 2.5, 1, -0.5, -1.5, -2, -2.5, -2, -0.5, 1.5];

/** Target curves spanning what the enhancer actually asks for, including the
 *  worst case (a full match correction plus quiet-listening comp). */
const CURVES = {
  'flat offset':        [3.5, 3.5, 3.5, 3.5, 3.5, 3.5, 3.5, 3.5, 3.5, 3.5],
  'smooth correction':  [3, 2, 1, -1, -2, -1, 1, 2, 1, -2],
  'bass-heavy match':   [3.5, 3, 1.5, -0.5, -1.5, -1, -0.5, 0.5, 1.5, -3],
  'bright correction':  [-2, -1.5, 0, 1, 1.5, 1, 0.5, -0.5, -2, -3.5],
  'quiet listening':    LOUDNESS,
  'match + quiet':      [3, 2, 1, -1, -2, -1, 1, 2, 1, -2].map((v, i) => v + LOUDNESS[i]),
};

let failures = 0;

function check(label, ok, detail) {
  if (ok) {
    console.log(`  ok    ${label}${detail ? `  (${detail})` : ''}`);
  } else {
    failures++;
    console.log(`  FAIL  ${label}${detail ? `  (${detail})` : ''}`);
  }
}

/** Compile the two dependency-free modules and import them. */
async function loadModules() {
  const out = mkdtempSync(join(tmpdir(), 'enhancer-check-'));
  execFileSync(
    'npx',
    [
      'tsc',
      'src/audio/biquadResponse.ts',
      'src/audio/enhanceProfiles.ts',
      '--outDir', out,
      '--module', 'esnext',
      '--target', 'es2022',
      '--moduleResolution', 'bundler',
    ],
    { stdio: 'pipe' },
  );
  const biquad = await import(pathToFileURL(join(out, 'biquadResponse.js')).href);
  const profiles = await import(pathToFileURL(join(out, 'enhanceProfiles.js')).href);
  return { biquad, profiles, cleanup: () => rmSync(out, { recursive: true, force: true }) };
}

const { biquad, profiles, cleanup } = await loadModules();
const { buildBandCoefs, responseCurveDb, buildCurveSolver, solveBandGains, logSpacedFrequencies } =
  biquad;
const { ENHANCE_PROFILES, ISO_10 } = profiles;

const PROBES = logSpacedFrequencies(96);

/** Sample a 10-band curve onto the probe grid, held flat past either end —
 *  the same interpretation buildCurveSolver fits against. */
function denseTarget(curve10) {
  const logIso = ISO_10.map(Math.log);
  return PROBES.map((f) => {
    const lf = Math.log(f);
    if (lf <= logIso[0]) return curve10[0];
    if (lf >= logIso[9]) return curve10[9];
    let k = 0;
    while (k < 8 && logIso[k + 1] < lf) k++;
    const t = (lf - logIso[k]) / (logIso[k + 1] - logIso[k]);
    return curve10[k] + t * (curve10[k + 1] - curve10[k]);
  });
}

function maxCurveError(gains, freqs, q, curve10) {
  const set = buildBandCoefs(gains, freqs, q, 0, 0, 0, 0, SAMPLE_RATE);
  const want = denseTarget(curve10);
  let err = 0;
  for (let i = 0; i < PROBES.length; i++) {
    err = Math.max(err, Math.abs(responseCurveDb(PROBES[i], set, SAMPLE_RATE) - want[i]));
  }
  return err;
}

console.log('\nProfile targets');
for (const [id, p] of Object.entries(ENHANCE_PROFILES)) {
  const mean = p.target10.reduce((a, b) => a + b, 0) / p.target10.length;
  // A target with a non-zero mean is a hidden level change: the enhancer
  // compares it against a mean-normalized measurement, so any offset becomes
  // a broadband gain that the headroom trim then has to undo.
  check(`${id}: target is mean-zero`, Math.abs(mean) < 1e-6, `mean ${mean.toFixed(9)} dB`);
  // Guards against anyone reintroducing a pink-ish curve. Mean-normalized
  // pink sits at -13.4 dB at 16 kHz; real masters are near -27.
  check(
    `${id}: top octave is master-like, not pink`,
    p.target10[9] < -20,
    `16 kHz ${p.target10[9].toFixed(1)} dB`,
  );
  check(
    `${id}: strength leaves the record recognisable`,
    p.strength > 0 && p.strength <= 0.7,
    `strength ${p.strength}`,
  );
}

for (const { name, freqs, q } of LAYOUTS) {
  console.log(`\n${name}`);
  const solver = buildCurveSolver(freqs, q, ISO_10, SAMPLE_RATE);
  check(`${name}: solver is non-singular`, solver !== null);
  if (!solver) continue;

  const gains = new Float64Array(freqs.length);
  let worstErr = 0;
  let worstErrCase = '';
  let worstGain = 0;
  let worstGainCase = '';
  let improvedEverywhere = true;

  for (const [caseName, curve10] of Object.entries(CURVES)) {
    solveBandGains(solver, curve10, gains, freqs.length, 10);
    const solved = Array.from(gains);

    if (solved.some((g) => !Number.isFinite(g))) {
      check(`${name} / ${caseName}: gains are finite`, false);
      continue;
    }

    const err = maxCurveError(solved, freqs, q, curve10);
    if (err > worstErr) {
      worstErr = err;
      worstErrCase = caseName;
    }
    const peak = Math.max(...solved.map(Math.abs));
    if (peak > worstGain) {
      worstGain = peak;
      worstGainCase = caseName;
    }

    // The old behaviour: write the requested curve straight to the filters.
    const naive = freqs.map((hz) => {
      const logIso = ISO_10.map(Math.log);
      const lf = Math.log(hz);
      if (lf <= logIso[0]) return curve10[0];
      if (lf >= logIso[9]) return curve10[9];
      let k = 0;
      while (k < 8 && logIso[k + 1] < lf) k++;
      const t = (lf - logIso[k]) / (logIso[k + 1] - logIso[k]);
      return curve10[k] + t * (curve10[k + 1] - curve10[k]);
    });
    if (err > maxCurveError(naive, freqs, q, curve10)) improvedEverywhere = false;
  }

  check(
    `${name}: delivered curve tracks the request`,
    worstErr < 2.0,
    `worst ${worstErr.toFixed(2)} dB on "${worstErrCase}"`,
  );
  check(
    `${name}: solved gains stay inside the ±${DELTA_CLAMP_DB} dB clamp`,
    worstGain < DELTA_CLAMP_DB,
    `worst ${worstGain.toFixed(1)} dB on "${worstGainCase}"`,
  );
  check(`${name}: compensation beats writing the curve raw`, improvedEverywhere);
}

console.log('\nEffects rack targets');
{
  const { effectTargetsFor } = profiles;
  // Correlation: 1 = mono, 0 = wide. Widening only ever opens, never narrows.
  const wideMix = effectTargetsFor(0.05, 15, 3.5, 1);
  const narrowMix = effectTargetsFor(0.9, 15, 3.5, 1);
  check(
    'never narrows below unity',
    wideMix.width >= 100 && narrowMix.width >= 100,
    `wide ${wideMix.width.toFixed(0)}, narrow ${narrowMix.width.toFixed(0)}`,
  );
  check(
    'a narrow image gets opened more than a wide one',
    narrowMix.width > wideMix.width,
    `${wideMix.width.toFixed(0)} → ${narrowMix.width.toFixed(0)}`,
  );
  // Width sits after the EQ's headroom trim, so its side boost reaches the
  // limiter uncompensated. Keep the worst case small enough to absorb.
  const worstSideBoostDb = 20 * Math.log10(narrowMix.width / 100);
  check(
    'worst-case width boost stays modest',
    worstSideBoostDb <= 2.5,
    `+${worstSideBoostDb.toFixed(1)} dB of side at width ${narrowMix.width.toFixed(0)}`,
  );

  // Exciter: only where there is real sub to work with.
  const noSub = effectTargetsFor(0.5, 2, 3.5, 1);
  const bassRecord = effectTargetsFor(0.5, 20, 3.5, 1);
  const subButSilent = effectTargetsFor(0.5, 20, 3.5, 0);
  check('no sub content → no exciter', noSub.exciter === 0, `${noSub.exciter.toFixed(1)}%`);
  check(
    'bass record → exciter engages but stays capped',
    bassRecord.exciter > 10 && bassRecord.exciter <= 35,
    `${bassRecord.exciter.toFixed(1)}%`,
  );
  check(
    'gated band → no exciter even with sub reading high',
    subButSilent.exciter === 0,
    'guards against exciting the noise floor',
  );

  // Crossover has to stay inside the rack's own 40-160 Hz range or the
  // effects graph would clamp it somewhere the UI never shows.
  let freqInRange = true;
  for (const tilt of [-40, -10, 0, 3.5, 10, 40]) {
    const { exciterFreq } = effectTargetsFor(0.5, 15, tilt, 1);
    if (exciterFreq < 40 || exciterFreq > 160) freqInRange = false;
  }
  check('crossover stays within the rack range', freqInRange, '40-160 Hz');
}

cleanup();

console.log(
  failures === 0
    ? '\nAll enhancer DSP checks passed.\n'
    : `\n${failures} enhancer DSP check(s) FAILED.\n`,
);
process.exit(failures === 0 ? 0 : 1);

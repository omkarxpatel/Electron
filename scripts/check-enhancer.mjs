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
 * It also checks `src/audio/loudness.ts` against the ITU-R BS.1770-4
 * coefficient tables and the EBU Tech 3341 compliance tones. Loudness is what
 * level-matches an A/B comparison, and an A/B that isn't level-matched only
 * ever learns "louder wins" — a silent failure that would poison every
 * preference judgement collected under it.
 *
 * `biquadResponse.ts`, `enhanceProfiles.ts`, `loudness.ts` and
 * `trackProfile.ts` have no
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
      'src/audio/loudness.ts',
      'src/audio/trackProfile.ts',
      '--outDir', out,
      '--module', 'esnext',
      '--target', 'es2022',
      '--moduleResolution', 'bundler',
    ],
    { stdio: 'pipe' },
  );
  const biquad = await import(pathToFileURL(join(out, 'biquadResponse.js')).href);
  const profiles = await import(pathToFileURL(join(out, 'enhanceProfiles.js')).href);
  const track = await import(pathToFileURL(join(out, 'trackProfile.js')).href);
  const loudness = await import(pathToFileURL(join(out, 'loudness.js')).href);
  return { biquad, profiles, loudness, track, cleanup: () => rmSync(out, { recursive: true, force: true }) };
}

const { biquad, profiles, loudness, track, cleanup } = await loadModules();
const { buildBandCoefs, responseCurveDb, buildCurveSolver, solveBandGains, logSpacedFrequencies } =
  biquad;
const { ENHANCE_PROFILES, ISO_10 } = profiles;
const { kWeightingStages, measureIntegratedLufs, matchGainDb } = loudness;

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

// ── BS.1770 loudness ─────────────────────────────────────────────────────

console.log('\nBS.1770 loudness');
{
  // BS.1770-4 tabulates K-weighting only at 48 kHz. We rebuild it per rate,
  // so the table is the one thing proving the rebuild is the same filter.
  const [shelf, hp] = kWeightingStages(48000);
  const near = (a, b) => Math.abs(a - b) < 1e-12;
  check(
    'K-weighting shelf matches the published 48 kHz table',
    near(shelf.b0, 1.53512485958697) &&
      near(shelf.b1, -2.69169618940638) &&
      near(shelf.b2, 1.19839281085285) &&
      near(shelf.a1, -1.69065929318241) &&
      near(shelf.a2, 0.73248077421585),
    'to 1e-12',
  );
  check(
    'K-weighting high-pass matches the published 48 kHz table',
    near(hp.b0, 1) &&
      near(hp.b1, -2) &&
      near(hp.b2, 1) &&
      near(hp.a1, -1.99004745483398) &&
      near(hp.a2, 0.99007225036621),
    'numerator stays unnormalised, as the standard tabulates it',
  );

  /** EBU Tech 3341 states its test tones by peak amplitude, not RMS. Reading
   *  them as RMS puts every case exactly 3.01 dB — 10log10(2) — off. */
  function sine(seconds, dbfsPeak, rate, hz = 1000) {
    const amp = Math.pow(10, dbfsPeak / 20);
    const n = Math.round(seconds * rate);
    const ch = new Float32Array(n);
    for (let i = 0; i < n; i++) ch[i] = amp * Math.sin((2 * Math.PI * hz * i) / rate);
    return ch;
  }
  const stereo = (seconds, db, rate) => {
    const c = sine(seconds, db, rate);
    return [c, Float32Array.from(c)];
  };
  const concat = (parts) => [0, 1].map((ch) => {
    const total = parts.reduce((n, p) => n + p[ch].length, 0);
    const out = new Float32Array(total);
    let at = 0;
    for (const p of parts) { out.set(p[ch], at); at += p[ch].length; }
    return out;
  });

  // Tolerance is EBU's own: ±0.1 LU.
  const within = (got, want) => Math.abs(got - want) <= 0.1;
  const cases = [
    ['tone at -23 dBFS reads -23 LUFS', stereo(20, -23, 48000), -23],
    ['tone at -33 dBFS reads -33 LUFS', stereo(20, -33, 48000), -33],
    [
      'quiet head and tail are gated out',
      concat([stereo(10, -36, 48000), stereo(60, -23, 48000), stereo(10, -36, 48000)]),
      -23,
    ],
    [
      'near-silence is gated out too',
      concat([
        stereo(10, -72, 48000), stereo(10, -36, 48000), stereo(60, -23, 48000),
        stereo(10, -36, 48000), stereo(10, -72, 48000),
      ]),
      -23,
    ],
    [
      'relative gate holds with a loud centre section',
      concat([stereo(20, -26, 48000), stereo(20.1, -20, 48000), stereo(20, -26, 48000)]),
      -23,
    ],
  ];
  for (const [label, signal, want] of cases) {
    const got = measureIntegratedLufs(signal, 48000);
    check(label, within(got, want), `${got.toFixed(2)} LUFS`);
  }

  // A hardcoded 48 kHz table would sail through everything above and then be
  // wrong on every 44.1 kHz device.
  const at441 = measureIntegratedLufs(stereo(20, -23, 44100), 44100);
  check('same tone reads the same at 44.1 kHz', within(at441, -23), `${at441.toFixed(2)} LUFS`);

  // Level matching is the only reason any of this is here.
  const quiet = measureIntegratedLufs(stereo(20, -30, 48000), 48000);
  const gain = matchGainDb(quiet, -23);
  check(
    'match gain lines two takes up',
    Math.abs(quiet + gain - -23) < 1e-9,
    `${gain.toFixed(2)} dB to reach -23 LUFS`,
  );
  check('silence cannot produce a match gain', matchGainDb(-Infinity, -23) === 0);
}

console.log('\nTrack memory');
{
  const { foldMeasurement, meanZero, decodeProfile, encodeProfile, encodeStore, decodeStore, evictOldest, MAX_PRIOR_SECONDS } = track;

  // Only shape is stored. A curve and the same curve 12 dB louder describe
  // the same track, and absolute dBFS at the pre-EQ tap moves with the input
  // gain and the EQ's headroom trim between sessions.
  const curve = [6, 4, 2, 0, -1, -2, -3, -2, -1, 1];
  const louder = curve.map((v) => v + 12);
  const a = foldMeasurement(null, curve, 60, 1);
  const b = foldMeasurement(null, louder, 60, 1);
  check(
    'level is discarded, shape is kept',
    a.shape10.every((v, i) => Math.abs(v - b.shape10[i]) < 1e-9),
    'same track at two input gains stores identically',
  );
  check(
    'stored shape is mean-zero',
    Math.abs(a.shape10.reduce((x, y) => x + y, 0)) < 0.05,
    `mean ${(a.shape10.reduce((x, y) => x + y, 0) / 10).toFixed(4)} dB`,
  );

  // Repeated folds must not walk the mean away from zero: the value is
  // persisted and re-folded every play, so any drift compounds forever
  // rather than washing out.
  // Through encode/decode, because that is the real cycle: every play reads
  // the rounded value back off disk and folds into it.
  let drifting = foldMeasurement(null, curve, 60, 1);
  for (let i = 0; i < 500; i++) {
    drifting = decodeProfile(encodeProfile(drifting));
    drifting = foldMeasurement(drifting, curve, 60, (i + 2) * 60_000);
  }
  const drift = Math.abs(drifting.shape10.reduce((x, y) => x + y, 0) / 10);
  check('500 persist+fold cycles do not accumulate drift', drift < 0.05, `mean ${drift.toFixed(6)} dB`);
  check(
    'a repeated identical play leaves the shape alone',
    drifting.shape10.every((v, i) => Math.abs(v - meanZero(curve)[i]) < 0.02),
  );

  // The prior is capped so a re-mastered or re-encoded track can be relearned
  // at all. What matters is that it CONVERGES: without the cap, `seconds`
  // grows without bound and a track played enough times could never be
  // relearned, because each new play would weigh essentially nothing.
  const changed = [-4, -3, -1, 0, 1, 2, 3, 2, 1, -1];
  const target = meanZero(changed);
  const gapAfter = (plays) => {
    // A huge prior, i.e. a track played many times already.
    let p = { shape10: meanZero(curve), seconds: 100000, updated: 1, lufs: null };
    for (let i = 0; i < plays; i++) p = foldMeasurement(p, changed, 180, i + 2);
    return p.shape10.reduce((m, v, i) => Math.max(m, Math.abs(v - target[i])), 0);
  };
  const gap0 = curve.reduce((m, _, i) => Math.max(m, Math.abs(meanZero(curve)[i] - target[i])), 0);
  const gap1 = gapAfter(1);
  check(
    'each play closes a real share of the gap',
    gap1 < gap0 * 0.85,
    `${gap0.toFixed(1)} → ${gap1.toFixed(1)} dB in one play`,
  );
  check(
    'a changed track is fully relearned',
    gapAfter(10) < 1.5,
    `within ${gapAfter(10).toFixed(2)} dB after 10 plays (prior capped at ${MAX_PRIOR_SECONDS}s)`,
  );
  check(
    'stability is preferred over chasing one play',
    gap1 > gap0 * 0.5,
    'one odd play cannot redefine a known track',
  );

  // localStorage survives downgrades and hand-editing; a malformed shape
  // would be seeded straight into the EQ.
  check('rejects a short shape', decodeProfile({ s: [1, 2], n: 5, u: 1 }) === null);
  check('rejects NaN in a shape', decodeProfile({ s: Array(10).fill(NaN), n: 5, u: 1 }) === null);
  check('rejects a zero-second profile', decodeProfile({ s: Array(10).fill(0), n: 0, u: 1 }) === null);
  check('rejects the readable form as stored data', decodeProfile(a) === null);
  const round = decodeProfile(encodeProfile(a));
  check(
    'a profile survives the round trip',
    round !== null && round.shape10.every((v, i) => Math.abs(v - a.shape10[i]) <= 0.05),
    'shape preserved to 0.1 dB',
  );

  // The store is written on every track change and read whole at startup, so
  // its size is a real cost the user is shown in Settings. Assert the budget
  // rather than trusting the encoding to stay terse.
  const MAX_TRACKS = 1000;
  const big = {};
  for (let i = 0; i < MAX_TRACKS; i++) {
    // Realistic ids: Spotify's are 22 base62 characters.
    const id = `t${String(i).padStart(21, '0')}`;
    big[id] = foldMeasurement(null, curve.map((v) => v + (i % 7) * 0.3), 180 + i, i * 60_000);
  }
  const serialized = encodeStore(big);
  const perTrack = serialized.length / MAX_TRACKS;
  check(
    'the full store stays small',
    serialized.length < 150 * 1024,
    `${MAX_TRACKS} tracks = ${(serialized.length / 1024).toFixed(0)} KB (${perTrack.toFixed(0)} B each)`,
  );
  const reread = decodeStore(serialized);
  check(
    'a full store reloads intact',
    Object.keys(reread).length === MAX_TRACKS,
    `${Object.keys(reread).length} of ${MAX_TRACKS}`,
  );
  check(
    'one corrupt entry does not lose the rest',
    Object.keys(decodeStore(JSON.stringify({ ...JSON.parse(serialized), bad: { s: [1] } }))).length
      === MAX_TRACKS,
  );

  // Eviction keeps what is actually being listened to, not what arrived first.
  const store = {};
  for (let i = 0; i < 10; i++) store[`t${i}`] = { shape10: meanZero(curve), seconds: 60, updated: i, lufs: null };
  const kept = evictOldest(store, 3);
  // Loudness is the one stored value that IS a level. It is measured
  // upstream of everything the app does, so it describes the track rather
  // than our processing — that is what makes it comparable between sessions
  // and usable for levelling one track against another.
  const withL = foldMeasurement(null, curve, 180, 1000, -14.2);
  check('loudness is kept when measured', withL.lufs === -14.2, `${withL.lufs} LUFS`);
  check(
    'loudness survives the round trip',
    Math.abs(decodeProfile(encodeProfile(withL)).lufs - -14.2) < 0.05,
  );
  check(
    'an unmeasured track stores no loudness',
    foldMeasurement(null, curve, 180, 1000).lufs === null &&
      encodeProfile(foldMeasurement(null, curve, 180, 1000)).l === undefined,
    'omitted rather than null — most of the store predates the meter',
  );
  check(
    'a silent play cannot erase a known loudness',
    foldMeasurement(withL, curve, 180, 2000, -Infinity).lufs === -14.2,
    'gated-out play leaves the figure alone',
  );
  // A partial play measures a real but unrepresentative slice, so it should
  // move the figure without redefining it.
  const nudged = foldMeasurement(withL, curve, 30, 3000, -20);
  check(
    'a partial play nudges loudness rather than replacing it',
    nudged.lufs < -14.2 && nudged.lufs > -16,
    `${nudged.lufs.toFixed(2)} LUFS after a 30 s play at -20`,
  );

  check(
    'eviction keeps the most recently heard',
    Object.keys(kept).sort().join(',') === 't7,t8,t9',
    Object.keys(kept).sort().join(','),
  );
}

cleanup();

console.log(
  failures === 0
    ? '\nAll enhancer DSP checks passed.\n'
    : `\n${failures} enhancer DSP check(s) FAILED.\n`,
);
process.exit(failures === 0 ? 0 : 1);

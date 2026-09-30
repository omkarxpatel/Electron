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
      'src/audio/musicalKey.ts',
      'src/audio/tempo.ts',
      'src/audio/mixCompatibility.ts',
      'src/dj/commentary.ts',
      'src/dj/intent.ts',
      '--outDir', out,
      // Pinned so the output tree is predictable. Without it tsc derives a
      // root from the common prefix of the inputs, so adding the first file
      // outside src/audio silently moved every other module down a level.
      '--rootDir', 'src',
      '--module', 'esnext',
      '--target', 'es2022',
      '--moduleResolution', 'bundler',
    ],
    { stdio: 'pipe' },
  );
  const biquad = await import(pathToFileURL(join(out, 'audio/biquadResponse.js')).href);
  const profiles = await import(pathToFileURL(join(out, 'audio/enhanceProfiles.js')).href);
  const track = await import(pathToFileURL(join(out, 'audio/trackProfile.js')).href);
  const key = await import(pathToFileURL(join(out, 'audio/musicalKey.js')).href);
  const tempo = await import(pathToFileURL(join(out, 'audio/tempo.js')).href);
  const mix = await import(pathToFileURL(join(out, 'audio/mixCompatibility.js')).href);
  // These live under src/dj, so tsc mirrors the tree rather than flattening.
  const commentary = await import(pathToFileURL(join(out, 'dj/commentary.js')).href);
  const intent = await import(pathToFileURL(join(out, 'dj/intent.js')).href);
  const loudness = await import(pathToFileURL(join(out, 'audio/loudness.js')).href);
  return { biquad, profiles, loudness, track, key, tempo, mix, commentary, intent, cleanup: () => rmSync(out, { recursive: true, force: true }) };
}

const { biquad, profiles, loudness, track, key, tempo, mix, commentary, intent, cleanup } = await loadModules();
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
    let p = { shape10: meanZero(curve), seconds: 100000, updated: 1, lufs: null, keyConfidence: 0, key: null, bpm: null, bpmConfidence: 0 };
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
    // Fully populated: a real entry carries loudness and a key, and a
    // budget measured on bare shapes would understate it by a tenth.
    big[id] = foldMeasurement(
      null,
      curve.map((v) => v + (i % 7) * 0.3),
      180 + i,
      i * 60_000,
      -14 - (i % 60) / 10,
      i % 24,
      0.5 + (i % 40) / 100,
      90 + (i % 50),
      0.4 + (i % 50) / 100,
    );
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
  for (let i = 0; i < 10; i++) store[`t${i}`] = { shape10: meanZero(curve), seconds: 60, updated: i, lufs: null, key: null, keyConfidence: 0, bpm: null, bpmConfidence: 0 };
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

  // Key is the one field that must NOT be averaged — there is no meaningful
  // midpoint between two keys, and a track has one.
  const keyed = foldMeasurement(null, curve, 180, 1000, -14, 7, 0.8);
  check('a key is kept when detected', keyed.key === 7 && keyed.keyConfidence === 0.8);
  const vague = foldMeasurement(keyed, curve, 180, 2000, -14, 2, 0.3);
  check(
    'a vaguer later reading cannot overwrite a clear one',
    vague.key === 7 && vague.keyConfidence === 0.8,
    `kept ${vague.key} at ${vague.keyConfidence}`,
  );
  const clearer = foldMeasurement(keyed, curve, 180, 3000, 2, 2, 0.95);
  check('a clearer reading does replace it', clearer.key === 2 && clearer.keyConfidence === 0.95);
  check(
    'an untonal play leaves a known key alone',
    foldMeasurement(keyed, curve, 180, 4000, -14, null, 0).key === 7,
  );
  const keyRound = decodeProfile(encodeProfile(keyed));
  check(
    'key survives the round trip',
    keyRound.key === 7 && Math.abs(keyRound.keyConfidence - 0.8) < 0.01,
  );
  check('an out-of-range key code is rejected', decodeProfile({ s: Array(10).fill(0), n: 5, u: 1, k: 99 }).key === null);

  // Tempo behaves like the key: one value per track, clearest reading wins.
  const tempoed = foldMeasurement(null, curve, 180, 1000, -14, 7, 0.8, 128.4, 0.7);
  check('a tempo is kept when detected', tempoed.bpm === 128.4 && tempoed.bpmConfidence === 0.7);
  check(
    'a vaguer tempo cannot overwrite a clear one',
    foldMeasurement(tempoed, curve, 180, 2000, -14, 7, 0.8, 96, 0.2).bpm === 128.4,
  );
  const tRound = decodeProfile(encodeProfile(tempoed));
  check(
    'tempo survives the round trip',
    Math.abs(tRound.bpm - 128.4) < 0.05 && Math.abs(tRound.bpmConfidence - 0.7) < 0.01,
  );
  check(
    'an absurd stored tempo is rejected',
    decodeProfile({ s: Array(10).fill(0), n: 5, u: 1, b: 9000 }).bpm === null,
  );

  check(
    'eviction keeps the most recently heard',
    Object.keys(kept).sort().join(',') === 't7,t8,t9',
    Object.keys(kept).sort().join(','),
  );
}

console.log('\nMusical key');
{
  const { accumulateChroma, estimateKey, camelotFor, PITCH_CLASSES } = key;
  const SR = 48000;
  const FFT = 8192;
  const BINS = FFT / 2;
  const NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

  /** A spectrum holding the given pitches, with harmonics — real
   *  instruments are not sine waves and the folding has to survive their
   *  overtones landing in other pitch classes.
   *
   *  `harmonics` and `rolloff` are parameters because the DEFAULTS here were
   *  hiding the bug this file is supposed to catch. Three harmonics at 1/h^2
   *  is a very gentle source: its third harmonic, the one that lands a fifth
   *  up, carries a ninth of the fundamental. A sawtooth — which is what a
   *  bowed, plucked or reeded instrument actually looks like — carries a
   *  third of it, and that is enough to pull the whole answer one step round
   *  the Camelot wheel. Measured against 189 passages of real recorded audio
   *  with published key metadata, the version of this file that only ever
   *  tested the gentle case was getting 45% of them right. */
  function spectrumOf(midiNotes, harmonics = 3, rolloff = 2) {
    const mags = new Float32Array(BINS);
    const binHz = SR / FFT;
    for (const m of midiNotes) {
      const f0 = 440 * Math.pow(2, (m - 69) / 12);
      for (let h = 1; h <= harmonics; h++) {
        const bin = Math.round((f0 * h) / binHz);
        if (bin > 0 && bin < BINS) mags[bin] += Math.pow(h, -rolloff);
      }
    }
    return mags;
  }

  /** A diatonic scale plus its tonic triad, weighted toward the tonic the
   *  way real music is — which is exactly what the profiles encode. */
  function chromaForKey(tonicPc, mode, triadReps = 4, harmonics = 3, rolloff = 2) {
    const steps = mode === 'major' ? [0, 2, 4, 5, 7, 9, 11] : [0, 2, 3, 5, 7, 8, 10];
    const triad = mode === 'major' ? [0, 4, 7] : [0, 3, 7];
    const chroma = new Float64Array(PITCH_CLASSES);
    const note = (pc) => spectrumOf([60 + pc], harmonics, rolloff);
    for (const st of steps) accumulateChroma(note(tonicPc + st), SR, FFT, chroma);
    // Tonal music dwells on the tonic triad rather than giving every scale
    // degree equal time. triadReps = 0 is the ambiguous case: a bare scale,
    // which genuinely cannot tell you major from its relative minor.
    for (let rep = 0; rep < triadReps; rep++) {
      for (const st of triad) accumulateChroma(note(tonicPc + st), SR, FFT, chroma);
    }
    return chroma;
  }

  let majorHits = 0;
  let minorHits = 0;
  const misses = [];
  for (let pc = 0; pc < PITCH_CLASSES; pc++) {
    const maj = estimateKey(chromaForKey(pc, 'major'));
    if (maj && maj.tonic === pc && maj.mode === 'major') majorHits++;
    else misses.push(`${NOTES[pc]} major -> ${maj ? maj.label : 'null'}`);
    const min = estimateKey(chromaForKey(pc, 'minor'));
    if (min && min.tonic === pc && min.mode === 'minor') minorHits++;
    else misses.push(`${NOTES[pc]}m -> ${min ? min.label : 'null'}`);
  }
  check('all 12 major keys identified from their own scale', majorHits === 12, `${majorHits}/12`);
  check('all 12 minor keys identified from their own scale', minorHits === 12, `${minorHits}/12`);
  if (misses.length) console.log(`        misses: ${misses.slice(0, 6).join(', ')}`);

  /* The same 24 keys, played on something with a real harmonic series.
   *
   * This is the assertion that would have caught the bug. Every note's third
   * harmonic lands an octave and a FIFTH above it, and its sixth lands there
   * again, so a chroma measured from real instruments has the fifth inflated
   * — and a profile that knows nothing about overtones then prefers the key
   * whose tonic IS that fifth. One step clockwise on the wheel, every time,
   * which would have made every harmonic mix suggestion wrong in the same
   * direction.
   *
   * A sawtooth (1/h amplitude) is the textbook harmonic source and the
   * gentlest thing that exposes this. The profiles are convolved with the
   * same series before correlating, which is what makes this pass. */
  let richMajor = 0;
  let richMinor = 0;
  const richMisses = [];
  for (let pc = 0; pc < PITCH_CLASSES; pc++) {
    const maj = estimateKey(chromaForKey(pc, 'major', 4, 8, 1));
    if (maj && maj.tonic === pc && maj.mode === 'major') richMajor++;
    else richMisses.push(`${NOTES[pc]} major -> ${maj ? maj.label : 'null'}`);
    const min = estimateKey(chromaForKey(pc, 'minor', 4, 8, 1));
    if (min && min.tonic === pc && min.mode === 'minor') richMinor++;
    else richMisses.push(`${NOTES[pc]}m -> ${min ? min.label : 'null'}`);
  }
  check(
    'all 24 keys survive a harmonically rich source (sawtooth, 8 harmonics)',
    richMajor === 12 && richMinor === 12,
    `${richMajor}/12 major, ${richMinor}/12 minor${richMisses.length ? ' — ' + richMisses.slice(0, 4).join(', ') : ''}`,
  );

  /* And specifically: not a fifth up. Stated separately from the count above
   * because the DIRECTION is the diagnosis — a scattering of wrong answers is
   * a weak detector, but a consistent one step clockwise is this bug back. */
  let fifthUp = 0;
  for (let pc = 0; pc < PITCH_CLASSES; pc++) {
    const maj = estimateKey(chromaForKey(pc, 'major', 4, 8, 1));
    if (maj && maj.mode === 'major' && maj.tonic === (pc + 7) % PITCH_CLASSES) fifthUp++;
  }
  check('a harmonic series does not drag the answer a fifth up', fifthUp === 0, `${fifthUp}/12 read as their own dominant`);

  // Silence has a maximum correlation too. Reporting it as C major is the
  // failure this guards.
  check('an empty chroma yields no key', estimateKey(new Float64Array(PITCH_CLASSES)) === null);
  check(
    'a negative or NaN chroma yields no key',
    estimateKey(Float64Array.from({ length: 12 }, (_, i) => (i === 3 ? NaN : 1))) === null,
  );

  // Ambiguous material should say so rather than pick confidently.
  const flat = Float64Array.from({ length: 12 }, () => 1);
  const flatKey = estimateKey(flat);
  check(
    'a flat chroma reports low confidence',
    flatKey !== null && flatKey.confidence < 0.2,
    flatKey ? `${flatKey.label} at ${(flatKey.confidence * 100).toFixed(0)}%` : 'null',
  );
  /* Both confidences are asserted RELATIVELY, not against thresholds.
   *
   * How far apart the 24 candidates land depends on the material, and the
   * only material available here is synthetic — picking an absolute cutoff
   * from it would be fitting the test to its own input. What can be
   * asserted honestly is the ordering: more tonal input must read as more
   * confident than less. Absolute calibration needs real music, and until
   * that happens these numbers are comparative, not a probability. */
  const decisive = estimateKey(chromaForKey(0, 'major', 4));
  const bareScale = estimateKey(chromaForKey(0, 'major', 0));
  check(
    'tonal material is more confident of the wheel position than noise',
    decisive !== null && flatKey !== null && decisive.confidence > flatKey.confidence + 0.1,
    `${decisive.camelot} at ${(decisive.confidence * 100).toFixed(0)}% vs flat ${(flatKey.confidence * 100).toFixed(0)}%`,
  );
  check(
    'dwelling on the major triad settles major vs minor',
    decisive !== null && bareScale !== null && decisive.modeConfidence > bareScale.modeConfidence,
    `triad ${(decisive.modeConfidence * 100).toFixed(0)}% vs bare scale ${(bareScale.modeConfidence * 100).toFixed(0)}%`,
  );
  check(
    'a bare scale does not claim certainty about the mode',
    bareScale !== null && bareScale.modeConfidence < 0.9,
    `${(bareScale.modeConfidence * 100).toFixed(0)}%`,
  );
  check(
    'both confidences stay inside 0..1',
    [decisive, bareScale, flatKey].every(
      (k) => k !== null && k.confidence >= 0 && k.confidence <= 1 && k.modeConfidence >= 0 && k.modeConfidence <= 1,
    ),
  );

  // The Camelot wheel: relative keys share a number, and a fifth is one
  // step round. Getting this wrong makes every harmonic suggestion wrong.
  check('C major is 8B', camelotFor(0, 'major') === '8B', camelotFor(0, 'major'));
  check('A minor is 8A', camelotFor(9, 'minor') === '8A', camelotFor(9, 'minor'));
  let relativesAgree = true;
  let fifthsStep = true;
  for (let pc = 0; pc < PITCH_CLASSES; pc++) {
    const maj = camelotFor(pc, 'major');
    const rel = camelotFor((pc + 9) % PITCH_CLASSES, 'minor');
    if (maj.slice(0, -1) !== rel.slice(0, -1)) relativesAgree = false;
    const up = camelotFor((pc + 7) % PITCH_CLASSES, 'major');
    const expected = (parseInt(maj, 10) % 12) + 1;
    if (parseInt(up, 10) !== expected) fifthsStep = false;
  }
  check('every relative major/minor pair shares its number', relativesAgree);
  check('a fifth up is one step clockwise, all the way round', fifthsStep);
  check(
    'all 24 Camelot codes are distinct',
    new Set(
      [...Array(12).keys()].flatMap((pc) => [camelotFor(pc, 'major'), camelotFor(pc, 'minor')]),
    ).size === 24,
  );
}

console.log('\nTempo');
{
  const { estimateTempo, foldTempo, tempoPrior, PRIOR_CENTRE_BPM, MIN_BPM, MAX_BPM } = tempo;
  const HZ = 93.75; // 512-sample hop at 48 kHz, what the worklet emits.

  /** An envelope with a dotted-eighth figure over the beat — the pattern
   *  that was defeating the estimator on real music.
   *
   *  `dotted` is how strong the three-sixteenth pulse is relative to the
   *  beat. Hip hop is full of this, and a plain autocorrelation cannot tell
   *  it from a beat: both repeat perfectly. It locks onto 4/3 of the true
   *  tempo, which is precisely where the misses clustered over 189 passages
   *  of real audio — 51% of them were within 1 BPM before combing over the
   *  bar, 69% after. */
  function dottedEnvelope(bpm, seconds, dotted = 0.9, seed = 11) {
    const n = Math.round(seconds * HZ);
    const out = new Float64Array(n);
    let rnd = seed;
    const rand = () => ((rnd = (rnd * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let i = 0; i < n; i++) out[i] = 0.15 * rand();
    const beat = (60 / bpm) * HZ;
    const sixteenth = beat / 4;
    const hit = (at, amp) => {
      const k = Math.round(at);
      for (let d = 0; d < 4 && k + d < n; d++) if (k + d >= 0) out[k + d] += amp * Math.exp(-d * 0.9);
    };
    // Tresillo, twice a bar: sixteenths 0 3 6 | 8 11 14. Spacings of three
    // sixteenths — three quarters of a beat — with the figure resetting on
    // the bar, which is how the pattern is actually played. A dotted pulse
    // running unbroken through the whole track at higher amplitude than the
    // beat would not be a trap, it would just be the tempo.
    for (let bar = 0; bar * beat * 4 < n; bar++) {
      const barStart = bar * beat * 4;
      for (let b = 0; b < 4; b++) hit(barStart + b * beat, 1);
      for (const st of [0, 3, 6, 8, 11, 14]) hit(barStart + st * sixteenth, dotted);
    }
    return out;
  }

  /** An onset envelope: a spike per beat, decaying, over a noise floor.
   *  `swing` displaces alternate beats to check the estimator does not need
   *  a metronome, and `noise` is how much of it is not the beat at all. */
  function envelope(bpm, seconds, { noise = 0, jitter = 0, seed = 7, decay = 1 / 0.9 } = {}) {
    const n = Math.round(seconds * HZ);
    const out = new Float64Array(n);
    let rnd = seed;
    const rand = () => ((rnd = (rnd * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let i = 0; i < n; i++) out[i] = noise * rand();
    const period = (60 / bpm) * HZ;
    const width = Math.ceil(decay * 4);
    for (let b = 0; b * period < n; b++) {
      // Jitter is a human drummer, not a systematic groove: each beat is
      // independently early or late. Systematic displacement of alternate
      // beats is a different problem (it genuinely restructures the metre)
      // and this does not claim to solve it.
      const drift = jitter === 0 ? 0 : (rand() * 2 - 1) * jitter * period;
      const at = b * period + drift;
      for (let d = 0; d < width; d++) {
        // Split each sample across its two neighbours rather than snapping to
        // one. Snapping makes the envelope depend on where inside a hop the
        // beat fell, and at some tempos that sub-sample phase repeats every
        // few beats — which correlates those beats far more strongly than
        // adjacent ones, for reasons that have nothing to do with the music.
        const x = at + d;
        const amp = Math.exp(-d / decay);
        const i = Math.floor(x);
        const frac = x - i;
        if (i >= 0 && i < n) out[i] += amp * (1 - frac);
        if (i + 1 >= 0 && i + 1 < n) out[i + 1] += amp * frac;
      }
    }
    return out;
  }

  const within = (got, want, tol) => Math.abs(got - want) <= tol;

  let hits = 0;
  const tried = [72, 88, 100, 112, 120, 128, 134];
  const off = [];
  for (const bpm of tried) {
    const est = estimateTempo(envelope(bpm, 12), HZ);
    if (est && within(est.bpm, bpm, 1)) hits++;
    else off.push(`${bpm} -> ${est ? est.bpm.toFixed(1) : 'null'}`);
  }
  check('clean click trains are read to within 1 BPM', hits === tried.length, `${hits}/${tried.length}${off.length ? ' — ' + off.join(', ') : ''}`);

  // Sub-lag precision is the whole reason for the parabolic fit: adjacent
  // integer lags near 120 BPM are ~2.5 BPM apart, which would be useless
  // for deciding whether two tracks can be mixed.
  const odd = estimateTempo(envelope(123.7, 14), HZ);
  check(
    'a tempo between two lags is interpolated, not snapped',
    odd !== null && within(odd.bpm, 123.7, 1),
    odd ? `${odd.bpm.toFixed(2)} BPM for 123.7` : 'null',
  );

  const noisy = estimateTempo(envelope(126, 14, { noise: 0.6 }), HZ);
  check(
    'survives a noisy envelope',
    noisy !== null && within(noisy.bpm, 126, 1.5),
    noisy ? `${noisy.bpm.toFixed(1)} BPM under heavy noise` : 'null',
  );
  const human = estimateTempo(envelope(120, 14, { jitter: 0.04 }), HZ);
  check(
    'tolerates a human drummer rather than needing a metronome',
    human !== null && within(human.bpm, 120, 2),
    human ? `${human.bpm.toFixed(1)} BPM with +-4% timing jitter` : 'null',
  );

  // Nothing periodic must produce no answer rather than a confident guess.
  const noiseOnly = estimateTempo(envelope(0.0001, 14, { noise: 1 }), HZ);
  const flat = estimateTempo(new Float64Array(1400), HZ);
  check('silence yields no tempo', flat === null);
  check(
    'unstructured noise is not confident',
    noiseOnly === null || noiseOnly.confidence < 0.5,
    noiseOnly ? `${noiseOnly.confidence.toFixed(2)}` : 'null',
  );
  const clean = estimateTempo(envelope(128, 14), HZ);
  check(
    'a clear beat is more confident than noise',
    clean !== null && (noiseOnly === null || clean.confidence > noiseOnly.confidence),
    clean ? `clean ${clean.confidence.toFixed(2)} vs noise ${noiseOnly ? noiseOnly.confidence.toFixed(2) : 'n/a'}` : 'null',
  );
  check('too little audio yields no tempo', estimateTempo(envelope(120, 1), HZ) === null);

  /* ── The dotted-subdivision trap ───────────────────────────────────────
   *
   * The failure that dominated real music. A dotted-eighth figure repeats as
   * cleanly as a beat, so a single-lag autocorrelation has no way to prefer
   * the beat — it just takes whichever peak the prior happens to favour, and
   * on anything slow the prior favours the wrong one. What separates them is
   * that a beat divides the bar and a dotted eighth does not, which is what
   * combing over four beats measures. */
  /** Same tempo, allowing for register: 70 and 140 are one answer, and which
   *  one gets reported is the prior's business rather than the grid's. */
  const sameTempo = (got, want, tolBpm = 2) => {
    if (!Number.isFinite(got) || got <= 0) return false;
    const octaves = Math.abs(Math.log2(got / want) % 1);
    const distance = Math.min(octaves, 1 - octaves);
    return distance < Math.abs(Math.log2(1 + tolBpm / want));
  };

  let dottedHits = 0;
  const dottedOff = [];
  for (const bpm of [70, 82, 90, 96, 120]) {
    const est = estimateTempo(dottedEnvelope(bpm, 14), HZ);
    if (est && sameTempo(est.bpm, bpm)) dottedHits++;
    else dottedOff.push(`${bpm} -> ${est ? est.bpm.toFixed(1) : 'null'}`);
  }
  check(
    'a dotted-eighth figure does not capture the beat',
    dottedHits === 5,
    `${dottedHits}/5${dottedOff.length ? ' — ' + dottedOff.join(', ') : ''}`,
  );

  /* A beat well outside the reported range must still be FOUND, then folded.
   * The grid is searched over 55..220 BPM for this reason: the old estimator
   * searched only the range it reports in, which left the prior as the only
   * thing separating candidates inside it. */
  /* `decay` is loosened from the default because a drum hit that rises and
   * falls inside a single envelope sample is not a thing the worklet can
   * produce: one sample is 512 audio frames, about 11 ms, and no attack is
   * that short. A sharper-than-possible impulse makes this particular tempo
   * fail for a sampling reason rather than a musical one. */
  const fast = estimateTempo(envelope(174, 14, { decay: 1.6 }), HZ);
  check(
    'a tempo above the reported range is found and folded, not missed',
    fast !== null && Math.abs(fast.bpm - 87) <= 1.5,
    fast ? `174 BPM read as ${fast.bpm.toFixed(1)} (87 is 174 halved)` : 'null',
  );

  /* Confidence has to carry information, which peak-versus-mean did not: on
   * real audio right and wrong answers both averaged 0.44, so any threshold
   * built on it was decoration. The margin over the best METRICALLY
   * UNRELATED reading does separate them. */
  const clear = estimateTempo(envelope(128, 14), HZ);
  const ambiguous = estimateTempo(dottedEnvelope(70, 14, 1.6), HZ);
  check(
    'a clean beat is more confident than an ambiguous one',
    clear !== null && ambiguous !== null && clear.confidence > ambiguous.confidence,
    clear && ambiguous ? `clean ${clear.confidence.toFixed(2)} vs ambiguous ${ambiguous.confidence.toFixed(2)}` : 'null',
  );
  check(
    'half time is not counted as a rival to itself',
    clear !== null && clear.confidence > 0.3,
    clear ? `${clear.confidence.toFixed(2)} on a metronomic 128 BPM` : 'null',
  );

  // The prior is what decides the octave. Without it a strong four-to-the-
  // floor kick reads as the bar, not the beat.
  check(
    'the prior peaks in the middle of the range',
    tempoPrior(115) > tempoPrior(70) && tempoPrior(115) > tempoPrior(140),
  );
  check(
    'the prior is symmetric in octaves',
    [1.25, 1.5, 2].every(
      (f) => Math.abs(tempoPrior(PRIOR_CENTRE_BPM * f) - tempoPrior(PRIOR_CENTRE_BPM / f)) < 1e-9,
    ),
    'equal weight a given number of octaves either side of the centre',
  );

  // Folding: 75 and 150 are the same tempo for mixing.
  check('folding brings a half-time reading into range', within(foldTempo(65), 130, 1e-9));
  check('folding brings a double-time reading into range', within(foldTempo(260), 130, 1e-9));
  check(
    'everything folds inside the search range',
    [40, 65, 90, 128, 175, 300].every((b) => foldTempo(b) >= MIN_BPM - 1e-9 && foldTempo(b) <= MAX_BPM + 1e-9),
  );
}

console.log('\nMix compatibility');
{
  const { scoreTransition, rankTransitions, fifthsBetween, wheelStepsBetween, tempoDistancePercent, brightnessDb } = mix;

  /** A candidate built from named musical facts rather than magic numbers. */
  const candidate = ({ tonic = 0, minor = false, bpm = 120, lufs = -14, tilt = 0, keyConf = 1, bpmConf = 1 } = {}) => ({
    key: tonic === null ? null : tonic + (minor ? 12 : 0),
    keyConfidence: keyConf,
    bpm,
    bpmConfidence: bpmConf,
    lufs,
    // A straight ramp across the ten bands gives a tilt of `tilt` dB from
    // the low group to the high group, and is already mean-zero.
    shape10: Array.from({ length: 10 }, (_, i) => ((i - 4.5) / 9) * tilt * (9 / 6)),
  });

  // ── The wheel, from fifths alone ──
  check('a key is zero steps from itself', fifthsBetween(0, 0) === 0);
  check('a fifth up is one step clockwise', fifthsBetween(0, 7) === 1, `C -> G = ${fifthsBetween(0, 7)}`);
  check('a fifth down is one step anticlockwise', fifthsBetween(0, 5) === -1, `C -> F = ${fifthsBetween(0, 5)}`);
  check('a tritone is the far side of the wheel', Math.abs(fifthsBetween(0, 6)) === 6, `C -> F# = ${fifthsBetween(0, 6)}`);
  let wheelConsistent = true;
  for (let pc = 0; pc < 12; pc++) {
    // Twelve fifths returns to the start, and the step count must agree with
    // the labelling musicalKey does independently.
    if (fifthsBetween(pc, (pc + 7) % 12) !== 1) wheelConsistent = false;
    const here = parseInt(key.camelotFor(pc, 'major'), 10);
    const up = parseInt(key.camelotFor((pc + 7) % 12, 'major'), 10);
    if (((up - here + 12) % 12) !== 1) wheelConsistent = false;
  }
  check('stepping in fifths agrees with the Camelot numbers musicalKey assigns', wheelConsistent);

  /* A minor key sits at its RELATIVE MAJOR's place on the wheel, not its
   * own tonic's. A minor is three semitones under C major and shares its
   * number, but three semitones down is three steps round the circle of
   * fifths — so measuring between the raw tonics reports the single most
   * compatible move in harmonic mixing as a clash. It did, until
   * wheelStepsBetween existed. */
  check(
    'a relative minor sits at the same place on the wheel as its major',
    wheelStepsBetween(0, 9 + 12) === 0,
    `C major -> A minor = ${wheelStepsBetween(0, 9 + 12)} steps`,
  );
  let relativesAlign = true;
  let minorFifthsStep = true;
  for (let pc = 0; pc < 12; pc++) {
    if (wheelStepsBetween(pc, ((pc + 9) % 12) + 12) !== 0) relativesAlign = false;
    // Minor keys step in fifths among themselves the same way majors do.
    if (wheelStepsBetween(pc + 12, ((pc + 7) % 12) + 12) !== 1) minorFifthsStep = false;
  }
  check('every major and its relative minor share a wheel position', relativesAlign);
  check('minor keys step round the wheel in fifths too', minorFifthsStep);
  let agreesWithLabels = true;
  for (let code = 0; code < 24; code++) {
    const tonic = code % 12;
    const mode = code >= 12 ? 'minor' : 'major';
    // The number musicalKey prints must be the number the steps imply.
    const expected = ((parseInt(key.camelotFor(0, 'major'), 10) - 1 + wheelStepsBetween(0, code) + 12) % 12) + 1;
    if (parseInt(key.camelotFor(tonic, mode), 10) !== expected) agreesWithLabels = false;
  }
  check('wheel steps agree with every Camelot number musicalKey prints', agreesWithLabels);

  // ── Tempo distance across the fold ──
  check('the same tempo is zero percent apart', Math.abs(tempoDistancePercent(128, 128)) < 1e-9);
  check(
    'four BPM up from 120 is about three percent',
    Math.abs(tempoDistancePercent(120, 124) - 3.333) < 0.01,
    `${tempoDistancePercent(120, 124).toFixed(2)}%`,
  );
  check(
    'half time is not a hundred percent away',
    Math.abs(tempoDistancePercent(140, 70)) < 1e-9,
    `140 vs 70 = ${tempoDistancePercent(140, 70).toFixed(2)}%`,
  );
  /* The edge of the fold. Stored tempos live in 70..140, so two tracks a
   * hair either side of the boundary are a hair apart musically and sixty
   * eight apart numerically. Comparing in BPM would call the easiest
   * transition in the list the worst one. */
  check(
    'tempos either side of the fold boundary are close, not far',
    Math.abs(tempoDistancePercent(139, 71)) < 3,
    `139 vs 71 = ${tempoDistancePercent(139, 71).toFixed(2)}%`,
  );

  check('a flat shape has no tilt', Math.abs(brightnessDb(new Array(10).fill(0))) < 1e-9);
  check(
    'a rising shape reads as brighter',
    brightnessDb(candidate({ tilt: 6 }).shape10) > 5.5,
    `${brightnessDb(candidate({ tilt: 6 }).shape10).toFixed(2)} dB`,
  );

  // ── The scoring itself ──
  const self = candidate();
  const toSelf = scoreTransition(self, self);
  check('a track against itself scores perfectly', toSelf.score > 0.99, toSelf.score.toFixed(3));
  check('and reports the relation as the same key', toSelf.harmonic.relation === 'same', toSelf.harmonic.relation);

  const tritone = scoreTransition(self, candidate({ tonic: 6 }));
  check(
    'a tritone away is reported as a clash',
    tritone.harmonic.relation === 'clash' && tritone.harmonic.score < 0.1,
    `${tritone.harmonic.relation}, harmonic term ${tritone.harmonic.score.toFixed(3)}`,
  );
  check(
    'and scores far below the same key even with the tempo identical',
    toSelf.score - tritone.score > 0.3,
    `${toSelf.score.toFixed(3)} vs ${tritone.score.toFixed(3)}`,
  );

  const relative = scoreTransition(self, candidate({ tonic: 9, minor: true }));
  check(
    'the relative minor is a compatible move',
    relative.harmonic.relation === 'relative' && relative.score > 0.85,
    `C -> Am: ${relative.harmonic.relation}, ${relative.score.toFixed(3)}`,
  );
  const neighbour = scoreTransition(self, candidate({ tonic: 7 }));
  check(
    'a fifth up is a compatible move',
    neighbour.harmonic.relation === 'neighbour' && neighbour.score > 0.8,
    `C -> G: ${neighbour.harmonic.relation}, ${neighbour.score.toFixed(3)}`,
  );

  /* Ordering is the only thing the score is ever used for, so it is the
   * thing worth asserting. The absolute numbers above are a ranking, not a
   * probability, and nothing should ever compare one against a threshold. */
  const ladder = [0, 7, 2, 9, 4, 6].map((tonic) => scoreTransition(self, candidate({ tonic })).score);
  let descends = true;
  for (let i = 1; i < ladder.length; i++) if (ladder[i] > ladder[i - 1] + 1e-9) descends = false;
  check(
    'scores fall as the key walks round the wheel',
    descends,
    ladder.map((v) => v.toFixed(2)).join(' > '),
  );

  const nearTempo = scoreTransition(self, candidate({ bpm: 124 }));
  const farTempo = scoreTransition(self, candidate({ bpm: 140 }));
  check(
    'a small tempo step costs little and a large one costs a lot',
    nearTempo.score > 0.9 && farTempo.score < nearTempo.score - 0.15,
    `+4 BPM ${nearTempo.score.toFixed(3)} vs +20 BPM ${farTempo.score.toFixed(3)}`,
  );
  check(
    'the tempo difference is reported as a percentage and in BPM',
    Math.abs(nearTempo.tempo.percent - 3.333) < 0.01 && Math.abs(nearTempo.tempo.deltaBpm - 4) < 0.01,
    `${nearTempo.tempo.percent.toFixed(2)}%, ${nearTempo.tempo.deltaBpm.toFixed(2)} BPM`,
  );

  /* An unheard track is an unknown, not a clash. Scoring a missing key as
   * zero would bury exactly the tracks the app most needs to go and listen
   * to, and the list would never grow past what it already knew. */
  const noKey = scoreTransition(self, candidate({ tonic: null }));
  check(
    'an unknown key is not scored as a clash',
    noKey.harmonic.relation === 'unknown' && noKey.score > tritone.score,
    `unknown ${noKey.score.toFixed(3)} vs tritone ${tritone.score.toFixed(3)}`,
  );
  /* And the other way. Dropping the unknown term instead of neutralising it
   * let a track nobody has ever heard score a perfect 1.00 — above every
   * real match — because the terms that remained were the whole score. */
  check(
    'an unknown key does not outrank a known compatible one',
    noKey.score < neighbour.score && noKey.score < toSelf.score,
    `unknown ${noKey.score.toFixed(3)} vs fifth ${neighbour.score.toFixed(3)} vs same ${toSelf.score.toFixed(3)}`,
  );
  check(
    'and says which terms it actually had evidence for',
    noKey.known.harmonic === false && noKey.known.tempo === true,
    JSON.stringify(noKey.known),
  );

  /* A shaky reading should not outvote a solid one. Both confidences are
   * comparative rather than calibrated, so they temper a term toward neutral
   * rather than gating it. */
  const unsure = scoreTransition(self, candidate({ tonic: 6, keyConf: 0.1 }));
  check(
    'a barely-detected clash is treated as less certain than a confident one',
    unsure.score > tritone.score,
    `unsure ${unsure.score.toFixed(3)} vs confident ${tritone.score.toFixed(3)}`,
  );
  const unsureMatch = scoreTransition(self, candidate({ keyConf: 0.1 }));
  check(
    'and a barely-detected match claims less than a confident one',
    unsureMatch.score < toSelf.score,
    `unsure ${unsureMatch.score.toFixed(3)} vs confident ${toSelf.score.toFixed(3)}`,
  );

  // ── Ranking ──
  const pool = [
    { id: 'tritone', profile: candidate({ tonic: 6 }) },
    { id: 'same', profile: candidate() },
    { id: 'fifth', profile: candidate({ tonic: 7 }) },
    { id: 'relative', profile: candidate({ tonic: 9, minor: true }) },
  ];
  const ranked = rankTransitions(self, pool);
  check(
    'ranking puts the same key first and the tritone last',
    ranked[0].item.id === 'same' && ranked[ranked.length - 1].item.id === 'tritone',
    ranked.map((r) => r.item.id).join(' > '),
  );
  const again = rankTransitions(self, [...pool].reverse());
  check(
    'ranking is stable regardless of input order',
    ranked.map((r) => r.item.id).join() === again.map((r) => r.item.id).join(),
    again.map((r) => r.item.id).join(' > '),
  );
  const tied = rankTransitions(self, [
    { id: 'bravo', profile: candidate({ tonic: 7 }) },
    { id: 'alpha', profile: candidate({ tonic: 7 }) },
  ]);
  check(
    'exact ties break by id rather than by input order',
    tied[0].item.id === 'alpha',
    tied.map((r) => r.item.id).join(' > '),
  );
  check(
    'every score stays inside 0..1',
    [toSelf, tritone, relative, neighbour, nearTempo, farTempo, noKey, unsure].every(
      (r) => r.score >= 0 && r.score <= 1,
    ),
  );
}

console.log('\nCommentary');
{
  const { describeTransition, summariseTransition } = commentary;
  const { scoreTransition } = mix;
  const candidate = ({ tonic = 0, minor = false, bpm = 120, lufs = -14, tilt = 0 } = {}) => ({
    key: tonic === null ? null : tonic + (minor ? 12 : 0),
    keyConfidence: 1,
    bpm,
    bpmConfidence: 1,
    lufs,
    shape10: Array.from({ length: 10 }, (_, i) => ((i - 4.5) / 9) * tilt * (9 / 6)),
  });
  const playing = candidate();

  /* The sentence from the handoff, built from nothing but measurements:
   * one step round the wheel and four BPM up. */
  const lift = describeTransition(
    scoreTransition(playing, candidate({ tonic: 7, bpm: 124 })),
    { camelot: '9B', key: 7, bpm: 124 },
  );
  check(
    'a fifth up and four BPM faster reads as a sentence',
    lift.sentence.includes('9B') &&
      lift.sentence.includes('one step round the wheel') &&
      lift.sentence.includes('four BPM up') &&
      // "four BPMs up" is how you can tell a sentence was assembled.
      !lift.sentence.includes('BPMs'),
    lift.sentence,
  );
  check('the sentence is one sentence', (lift.sentence.match(/\./g) || []).length === 1, lift.sentence);

  const same = describeTransition(scoreTransition(playing, playing), { camelot: '8B', key: 0, bpm: 120 });
  check(
    'an identical track reads as the same key and the same tempo',
    same.sentence.includes('same key') && same.sentence.includes('the same tempo'),
    same.sentence,
  );

  /* Numbers are spelled out because this is read aloud. "4 BPM" becomes
   * "four b p m" only if the four is already a word. */
  check('small numbers are words, not digits', !/\b\d+ BPM/.test(lift.sentence), lift.sentence);

  const blind = describeTransition(
    scoreTransition(playing, candidate({ tonic: null, bpm: null })),
    { camelot: null, key: null, bpm: null },
  );
  check(
    'a track we have not measured says so rather than inventing a reason',
    blind.sentence.includes("haven't heard its key") && blind.sentence.includes('no tempo'),
    blind.sentence,
  );

  const clash = describeTransition(
    scoreTransition(playing, candidate({ tonic: 6 })),
    { camelot: '2B', key: 6, bpm: 120 },
  );
  check(
    'a bad pick is not oversold',
    clash.sentence.startsWith('Not a clean match') && clash.sentence.includes('fight'),
    clash.sentence,
  );
  check(
    'and a good pick is not undersold',
    same.sentence.startsWith('Next up'),
    same.sentence,
  );

  const relative = describeTransition(
    scoreTransition(playing, candidate({ tonic: 9, minor: true })),
    { camelot: '8A', key: 9 + 12, bpm: 120 },
  );
  check(
    'the relative minor is named as such',
    relative.sentence.includes('relative minor'),
    relative.sentence,
  );

  const row = summariseTransition(
    scoreTransition(playing, candidate({ tonic: 7, bpm: 124 })),
    { camelot: '9B', key: 7, bpm: 124 },
  );
  check(
    'the list row carries both deciding facts, not a truncated sentence',
    row.includes('9B') && row.includes('one step') && row.includes('124 BPM') && row.includes('+4'),
    row,
  );
  const blindRow = summariseTransition(
    scoreTransition(playing, candidate({ tonic: null, bpm: null })),
    { camelot: null, key: null, bpm: null },
  );
  check('and says unknown where it is unknown', blindRow.includes('key unknown') && blindRow.includes('tempo unknown'), blindRow);
}

console.log('\nChat intent');
{
  const { parseIntent, applyIntent, describeIntent } = intent;
  const { scoreTransition } = mix;
  const candidate = ({ tonic = 0, bpm = 120, lufs = -14, tilt = 0 } = {}) => ({
    key: tonic === null ? null : tonic,
    keyConfidence: 1,
    bpm,
    bpmConfidence: 1,
    lufs,
    shape10: Array.from({ length: 10 }, (_, i) => ((i - 4.5) / 9) * tilt * (9 / 6)),
  });
  const playing = candidate();

  check('empty text asks for nothing', parseIntent('').empty && parseIntent('   ').empty);
  check('unrecognised text asks for nothing rather than guessing', parseIntent('play the good one').empty);
  check('faster is understood', parseIntent('something faster').tempo === 'up');
  check('slower is understood', parseIntent('a bit slower please').tempo === 'down');
  check(
    'chill means both softer and slower',
    parseIntent('something chill').energy === 'down' && parseIntent('something chill').tempo === 'down',
  );
  check('pick up the energy is understood', parseIntent('pick up the energy').energy === 'up');
  check('keep it in this key is understood', parseIntent('keep it in this key').holdKey === true);
  check('punctuation and case do not matter', parseIntent('FASTER!!!').tempo === 'up');

  /* Longest match wins. "chill out" is only about energy; reading it as
   * "chill" would also drag the tempo down, which is not what was asked. */
  const chillOut = parseIntent('chill out for a bit');
  check(
    'a longer phrase beats a word inside it',
    chillOut.energy === 'down' && chillOut.tempo === null,
    JSON.stringify({ energy: chillOut.energy, tempo: chillOut.tempo, matched: chillOut.matched }),
  );

  // Biasing.
  const faster = parseIntent('faster');
  const up = scoreTransition(playing, candidate({ bpm: 130 }));
  const down = scoreTransition(playing, candidate({ bpm: 110 }));
  check(
    'asking for faster promotes the faster track over the slower one',
    applyIntent(up, faster).score > applyIntent(down, faster).score,
    `${applyIntent(up, faster).score.toFixed(3)} vs ${applyIntent(down, faster).score.toFixed(3)}`,
  );
  check(
    'and leaves the unbiased ranking alone when nothing was asked',
    applyIntent(up, parseIntent('')).score === up.score,
  );

  /* A request biases the ranking; it does not override it. Asking for
   * something faster must not promote a track whose key clashes over one
   * that works — that would be the app doing as it is told rather than
   * doing its job. */
  const clashButFaster = scoreTransition(playing, candidate({ tonic: 6, bpm: 130 }));
  const worksButSlower = scoreTransition(playing, candidate({ tonic: 7, bpm: 118 }));
  check(
    'a request cannot promote a clash over a compatible track',
    applyIntent(clashButFaster, faster).score < applyIntent(worksButSlower, faster).score,
    `clash+faster ${applyIntent(clashButFaster, faster).score.toFixed(3)} vs works+slower ${applyIntent(worksButSlower, faster).score.toFixed(3)}`,
  );

  /* A track with no stored tempo cannot answer "faster". It must not be
   * scored as though it had, and the caller has to be able to tell. */
  const unknownTempo = scoreTransition(playing, candidate({ bpm: null }));
  check(
    'a track with no tempo is not judged against a tempo request',
    applyIntent(unknownTempo, faster).satisfied === null,
    JSON.stringify(applyIntent(unknownTempo, faster)),
  );

  check(
    'what was understood can be read back to the user',
    describeIntent(parseIntent('something chill')).includes('slower') &&
      describeIntent(parseIntent('')).includes('compatibility alone'),
    `${describeIntent(parseIntent('something chill'))} / ${describeIntent(parseIntent(''))}`,
  );
  check(
    'every biased score stays inside 0..1',
    [up, down, clashButFaster, worksButSlower].every((r) => {
      const v = applyIntent(r, parseIntent('faster more energy brighter in key')).score;
      return v >= 0 && v <= 1;
    }),
  );
}

cleanup();

console.log(
  failures === 0
    ? '\nAll enhancer DSP checks passed.\n'
    : `\n${failures} enhancer DSP check(s) FAILED.\n`,
);
process.exit(failures === 0 ? 0 : 1);

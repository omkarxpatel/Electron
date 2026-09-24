/**
 * Target spectra for the AI Enhancer.
 *
 * This is the "what should this music look like" half of the enhancer, kept
 * separate from `useAiEnhancer`'s measurement + control loop so that adding a
 * music type is a data edit here rather than a code change there.
 *
 * Every profile is a long-term target spectrum sampled at ISO_10, plus how
 * hard to chase it. The enhancer measures the source spectrum, subtracts the
 * target, and corrects a fraction of the difference.
 *
 * ── Why the old target was wrong ──────────────────────────────────────────
 * The previous target was pink noise: a flat -3 dB/oct tilt across the whole
 * range. Real records are nothing like pink. Pestana/Ma/Reiss/Barbosa/Black,
 * "Spectral Characteristics of Popular Commercial Recordings 1950-2010"
 * (AES 135) measured a consistent ≈-5 dB/oct decay from 100 Hz to 4 kHz, a
 * shelf rather than a continued rise below ~80 Hz, and a considerably steeper
 * roll-off above 4 kHz.
 *
 * Pink therefore asks for roughly 15 dB more 16 kHz than music actually has,
 * and the enhancer dutifully delivered it on every track. That — stacked with
 * the old per-mode tilts, which were ALSO top-weighted on all five modes —
 * is what made AI Enhance sound bright, thin and worse than flat.
 */

/** ISO 1-octave centres the enhancer reasons in, regardless of the user's
 *  band layout. Curves here are resampled to 10/15/31 bands downstream. */
export const ISO_10 = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000] as const;

export type EnhanceProfileId =
  | 'auto'
  | 'reference'
  | 'electronic'
  | 'acoustic'
  | 'vocal'
  | 'rock';

export interface EnhanceProfile {
  label: string;
  /** Shown in the chip's tooltip. Says what it assumes about the music. */
  hint: string;
  /** Target spectrum at ISO_10, dB. Mean-normalized at module load — the
   *  enhancer compares it against a mean-normalized measurement, so only the
   *  SHAPE matters and any absolute offset would be a silent level change. */
  target10: number[];
  /** Fraction of the measured deviation from target to correct, 0..1.
   *  1.0 would force every record to the same spectrum; the point is to nudge
   *  toward the target, not to flatten everything into it. */
  strength: number;
  /** Per-band cap on the match correction, dB. */
  ceilingDb: number;
}

/**
 * Measured reference: the average commercial master, dB relative to 1 kHz.
 * ≈-5 dB/oct from 100 Hz to 4 kHz, shelving below ~80 Hz, steeper above 4 kHz.
 * This is the only curve here derived from published measurement — the rest
 * are voicings expressed as offsets from it.
 */
const REFERENCE_10 = [13.0, 16.5, 15.0, 10.0, 5.0, 0.0, -5.0, -10.0, -18.0, -27.0];

/** Apply a voicing offset to the measured reference. Keeps every profile
 *  anchored to something real instead of being a free-floating curve. */
function voiced(offset10: number[]): number[] {
  return REFERENCE_10.map((v, i) => v + offset10[i]);
}

/** Subtract the mean so a curve carries shape only, no level. */
function meanZero(curve: number[]): number[] {
  const mean = curve.reduce((a, b) => a + b, 0) / curve.length;
  return curve.map((v) => v - mean);
}

/*                     31    62   125   250   500    1k    2k    4k    8k   16k */
const VOICINGS: Record<Exclude<EnhanceProfileId, 'auto'>, number[]> = {
  // Straight to the measured average. The safe default.
  reference:  [  0,    0,    0,    0,    0,    0,    0,    0,    0,    0  ],
  // Sub weight and air, with the 2-4 kHz region held back — the region that
  // turns loud electronic music harsh rather than louder.
  electronic: [ +3,   +2,    0,   -1,   -1,    0,   -1,   -1,   +1,   +2  ],
  // Less sub (there's rarely anything real down there on acoustic material),
  // a little presence, and an honest top end rather than added air.
  acoustic:   [ -3,   -2,    0,    0,   +1,   +1,   +1,    0,    0,    0  ],
  // Intelligibility: lift the formant + presence region, pull the mud at
  // 250-500 Hz that sits on top of a voice.
  vocal:      [ -2,   -1,    0,   -2,    0,   +2,   +2,   +1,    0,   -1  ],
  // Body kept, the 2-4 kHz guitar-and-cymbal glare tamed.
  rock:       [ +1,   +1,   +1,    0,    0,    0,   -2,   -2,    0,   +1  ],
};

export const ENHANCE_PROFILES: Record<Exclude<EnhanceProfileId, 'auto'>, EnhanceProfile> = {
  reference: {
    label: 'Reference',
    hint: 'Matches the average commercial master. Neutral — use this if unsure.',
    target10: meanZero(voiced(VOICINGS.reference)),
    strength: 0.5,
    ceilingDb: 3,
  },
  electronic: {
    label: 'Electronic',
    hint: 'House, hip-hop, bass music. Sub weight and air; holds back 2-4 kHz glare.',
    target10: meanZero(voiced(VOICINGS.electronic)),
    strength: 0.5,
    ceilingDb: 3.5,
  },
  acoustic: {
    label: 'Acoustic',
    hint: 'Jazz, classical, folk. Less sub, gentle presence, no added air.',
    target10: meanZero(voiced(VOICINGS.acoustic)),
    strength: 0.45,
    ceilingDb: 3,
  },
  vocal: {
    label: 'Vocal',
    hint: 'Vocal-forward pop, podcasts. Lifts presence, cuts 250-500 Hz mud.',
    target10: meanZero(voiced(VOICINGS.vocal)),
    strength: 0.55,
    ceilingDb: 3.5,
  },
  rock: {
    label: 'Rock',
    hint: 'Rock, metal, punk. Keeps body, tames 2-4 kHz guitar and cymbal glare.',
    target10: meanZero(voiced(VOICINGS.rock)),
    strength: 0.5,
    ceilingDb: 3,
  },
};

/** Display order for the profile chips. `auto` first — it's the default. */
export const ENHANCE_PROFILE_ORDER: EnhanceProfileId[] = [
  'auto',
  'reference',
  'electronic',
  'acoustic',
  'vocal',
  'rock',
];

export function profileLabel(id: EnhanceProfileId): string {
  return id === 'auto' ? 'Auto' : ENHANCE_PROFILES[id].label;
}

export function profileHint(id: EnhanceProfileId): string {
  return id === 'auto'
    ? 'Picks a profile from what the music is doing — bass weight, onset density, vocal presence.'
    : ENHANCE_PROFILES[id].hint;
}

/* ── Effects rack targets ───────────────────────────────────────────────
 *
 * The enhancer already measures everything needed to drive two of the three
 * effects, so this is a use of existing measurements rather than new DSP.
 * Kept here rather than in the hook so the rules are pure functions of
 * measured quantities, and so `npm run check:enhancer` can exercise them.
 *
 * Width and exciter are driven because each has a rule you can point at:
 * widening only helps material that has side content to widen, and the
 * exciter only helps when there are fundamentals down where a speaker can't
 * physically reproduce them. Both are corrective.
 *
 * Reverb is deliberately NOT driven. Nothing measurable says a finished
 * master wants reverb — it's a taste effect, and applying it automatically
 * would smear mixes that were fine. That's the same "sounds worse than doing
 * nothing" failure the rest of this pass existed to fix. Its knobs stay manual.
 */

export interface EffectTargets {
  width: number;
  exciter: number;
  exciterFreq: number;
}

/** Only ever widen, never narrow. Narrowing a deliberately-wide mix throws
 *  away information; widening a narrow one is undone by switching this off.
 *  130 caps the side energy we can add — width sits AFTER the EQ's headroom
 *  trim, so whatever it adds reaches the limiter uncompensated. */
const WIDTH_MIN = 100;
const WIDTH_MAX = 130;
/** Correlation mapped across that span. Above 0.8 the image is narrow enough
 *  to be worth opening; below 0.2 it is already wide. (Near 1.0 the side
 *  signal is ~0, so widening is a no-op rather than a hazard.) */
const WIDTH_CORR_LO = 0.2;
const WIDTH_CORR_HI = 0.8;

/** The exciter adds harmonic distortion. Capped well short of the manual
 *  range: the user can still dial 100 % by hand, but nothing automatic should
 *  push a record that far without being asked for it. */
const EXCITER_MAX = 35;
/** Sub energy above the mix's own mean, in dB, mapped across that range. A
 *  typical master sits ~15 dB up across the bottom two bands (see
 *  REFERENCE_10), so 8 reads as "not much down there" and 18 as "bass record". */
const SUB_REL_LO = 8;
const SUB_REL_HI = 18;

const EXCITER_FREQ_MIN = 40;
const EXCITER_FREQ_MAX = 160;

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * Effect settings for one measurement.
 *
 * @param correlation  L/R correlation over 300 Hz-8 kHz. 1 = mono, 0 = wide.
 * @param subRelDb     Mean of the 31/62 Hz bands minus the mix mean, in dB.
 * @param subTiltDb    62 Hz band minus 31 Hz band, in dB. Positive means the
 *                     low energy sits nearer 62 than 31.
 * @param subGate      0..1 — whether those bands hold anything at all.
 */
export function effectTargetsFor(
  correlation: number,
  subRelDb: number,
  subTiltDb: number,
  subGate: number,
): EffectTargets {
  const width =
    WIDTH_MIN +
    (WIDTH_MAX - WIDTH_MIN) *
      clamp01((correlation - WIDTH_CORR_LO) / (WIDTH_CORR_HI - WIDTH_CORR_LO));

  const exciter =
    EXCITER_MAX *
    clamp01((subRelDb - SUB_REL_LO) / (SUB_REL_HI - SUB_REL_LO)) *
    clamp01(subGate);

  // Crossover tracks where the sub actually sits: a positive tilt means the
  // energy is nearer 62 Hz, so the shaper has to look a little higher to
  // catch fundamentals rather than re-shaping harmonics it just made.
  const exciterFreq = Math.min(
    EXCITER_FREQ_MAX,
    Math.max(EXCITER_FREQ_MIN, 70 + subTiltDb * 3),
  );

  return { width, exciter, exciterFreq };
}

/**
 * Material classes the live classifier can distinguish from the FFT. These are
 * measurable properties of the signal, not genres — the mapping to a genre-named
 * profile below is the guess, and it's why `auto` is overridable.
 */
export type MaterialClass = 'bass' | 'rhythmic' | 'vocal' | 'instrumental' | 'dense';

/**
 * Which profile `auto` reaches for per material class.
 *
 * Replaces the old MODE_PROFILES/VOCAL_PROFILE tables, which added a per-mode
 * tilt ON TOP of the pink target. Summing a target and two tilts meant three
 * independent top-end boosts with nothing pulling back. Selecting one complete
 * target instead makes the result bounded by construction.
 */
const MATERIAL_TO_PROFILE: Record<MaterialClass, Exclude<EnhanceProfileId, 'auto'>> = {
  bass: 'electronic',
  rhythmic: 'electronic',
  vocal: 'vocal',
  instrumental: 'acoustic',
  dense: 'rock',
};

/**
 * Resolve the profile actually in force. When the user pins one we use it at
 * full confidence; `auto` blends from `reference` toward the classified
 * profile by `confidence`, so a marginal classification moves the curve a
 * little rather than snapping between voicings.
 */
export function resolveTarget(
  selected: EnhanceProfileId,
  material: MaterialClass,
  confidence: number,
  out: Float64Array,
): { strength: number; ceilingDb: number; dominant: Exclude<EnhanceProfileId, 'auto'> } {
  if (selected !== 'auto') {
    const p = ENHANCE_PROFILES[selected];
    for (let i = 0; i < 10; i++) out[i] = p.target10[i];
    return { strength: p.strength, ceilingDb: p.ceilingDb, dominant: selected };
  }
  const base = ENHANCE_PROFILES.reference;
  const pickedId = MATERIAL_TO_PROFILE[material];
  const picked = ENHANCE_PROFILES[pickedId];
  const t = confidence < 0 ? 0 : confidence > 1 ? 1 : confidence;
  for (let i = 0; i < 10; i++) {
    out[i] = base.target10[i] + t * (picked.target10[i] - base.target10[i]);
  }
  return {
    strength: base.strength + t * (picked.strength - base.strength),
    ceilingDb: base.ceilingDb + t * (picked.ceilingDb - base.ceilingDb),
    // Which target the blend actually sits closest to. Below half confidence
    // the reference curve is still the larger share, and saying "Electronic"
    // then would overstate what the enhancer is doing.
    dominant: t >= 0.5 ? pickedId : 'reference',
  };
}

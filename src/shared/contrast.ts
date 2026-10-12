/**
 * Contrast floor for album-tinted text.
 *
 * `--accent-bright` is the palette's first stop, and for an album-derived
 * palette that is whatever colour extraction ranked second in the artwork —
 * anything down to HSL lightness 0.18, because that is where
 * `extractPalette.MIN_LIGHTNESS` sits. On a sleeve that is mostly dark browns
 * or deep blues the accent comes back dark, and the one line of lyrics that is
 * supposed to be the readable one ends up at about 2.5:1 against the pane,
 * while the INACTIVE lines either side of it — flat `rgba(255,255,255,0.65)` —
 * sit at 8.4:1. The highlight inverts: the line you are meant to be reading is
 * the hardest one on screen to read.
 *
 * Nothing errors when this happens, and it only happens on some albums, which
 * is why it survived so long: most sleeves give back a bright accent and the
 * colour is exactly right.
 *
 * So: measure, and only intervene when the measurement says to. A colour that
 * clears the floor is returned untouched — byte for byte, so the 90% of albums
 * that already look right are not re-themed by a rounding error.
 */

/**
 * The surface the lyrics sit on, as a neutral grey of the same luminance.
 *
 * Measured, not guessed: the `lyrics` capture scene renders the pane for real
 * and the darkest decile of its pixels comes back at #06150f — the app's own
 * #0a0a0a base, lifted a little by the blurred album backdrop behind it and
 * then darkened again by the pane's own black gradient. The green in that
 * sample is the album's, and would be red on the next track, so only the
 * luminance of it is kept here.
 *
 * Re-measure with `npm run capture -- --only lyrics` if the pane's background
 * or the backdrop's brightness ever changes; a stale value here silently
 * mis-scores every accent.
 */
export const LYRIC_SURFACE = '#121212';

/**
 * Below this, the accent is treated as a casualty. 4.5:1 is WCAG 2.1 AA for
 * normal-size text, which 14px at weight 500 is, and it is deliberately the
 * published threshold rather than a number chosen by eye: every built-in
 * palette's own accent clears it, so choosing a palette still gets you the
 * colour you chose, untouched.
 */
export const LYRIC_MIN_CONTRAST = 4.5;

/**
 * What a lifted accent is lifted TO. Higher than the trigger on purpose —
 * landing a colour we have already judged unreadable exactly on the pass mark
 * leaves it at the bottom of the readable range, and these lines move, scale
 * and sit over a live visualiser, which is harder than the static body text
 * AA was written for. Still below every built-in palette's accent, so the
 * lift never overshoots into territory the untouched ones do not occupy.
 */
export const LYRIC_TARGET_CONTRAST = 5.5;

/**
 * The lyrics pane's current-line colour: the album accent where it is
 * readable, a lifted version of it where it is not.
 */
export function readableLyricAccent(accent: string): string {
  if (contrastRatio(accent, LYRIC_SURFACE) >= LYRIC_MIN_CONTRAST) return accent;
  return liftToContrast(accent, LYRIC_SURFACE, LYRIC_TARGET_CONTRAST);
}

// ── WCAG ──────────────────────────────────────────────────────────────────

/** sRGB -> linear, the WCAG 2.1 transfer function. */
function toLinear(channel: number): number {
  const s = channel / 255;
  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

/** WCAG 2.1 relative luminance of an `#rrggbb` colour. */
export function relativeLuminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex);
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

/** WCAG 2.1 contrast ratio between two `#rrggbb` colours, 1 to 21. */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return la > lb ? (la + 0.05) / (lb + 0.05) : (lb + 0.05) / (la + 0.05);
}

/**
 * Return `hex` if it already clears `minRatio` against `bg`, otherwise the
 * same hue and saturation at the lowest lightness that does.
 *
 * Lightness, not a mix toward white: mixing desaturates, and at the lift
 * sizes this needs a deep indigo comes back lilac-grey with the album's
 * character washed out of it. Raising HSL lightness keeps hue and saturation
 * exactly, so the line stays recognisably the colour the sleeve asked for —
 * just light enough to read.
 *
 * Every channel of HSL->RGB is non-decreasing in L at fixed H and S, so
 * luminance is monotone in L and the search below cannot step over the
 * answer. `bg` is assumed darker than the result; in this app it is always
 * the near-black lyrics pane. If even white misses the floor, white is what
 * comes back — there is nothing lighter to offer.
 */
export function liftToContrast(hex: string, bg: string, minRatio: number): string {
  if (!isHex(hex)) return hex;
  if (contrastRatio(hex, bg) >= minRatio) return hex;

  const [h, s, l0] = rgbToHsl(hexToRgb(hex));
  // 12 halvings of [l0, 1] resolve lightness to under 1/4000 — far finer than
  // the 1/255 the output is quantised to, so the loop always lands on the
  // same hex as an exhaustive scan would.
  let lo = l0;
  let hi = 1;
  for (let i = 0; i < 12; i++) {
    const mid = (lo + hi) / 2;
    if (contrastRatio(hslToHex(h, s, mid), bg) >= minRatio) hi = mid;
    else lo = mid;
  }
  return hslToHex(h, s, hi);
}

// ── Colour space ──────────────────────────────────────────────────────────

function isHex(hex: string): boolean {
  return /^#[0-9a-f]{6}$/i.test(hex);
}

/** `#rrggbb` -> 0-255 triplet. Callers gate on isHex() first, so the black
 *  fallback is only ever reached by relativeLuminance/contrastRatio being
 *  handed something malformed directly — returning a number there beats
 *  throwing out of a render. */
function hexToRgb(hex: string): [number, number, number] {
  if (!isHex(hex)) return [0, 0, 0];
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}

function rgbToHsl([r, g, b]: [number, number, number]): [number, number, number] {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === rn) h = (gn - bn) / d + (gn < bn ? 6 : 0);
  else if (max === gn) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;
  return [h / 6, s, l];
}

function hslToHex(h: number, s: number, l: number): string {
  if (s === 0) {
    const v = Math.round(l * 255);
    return `#${hex2(v)}${hex2(v)}${hex2(v)}`;
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const r = hueToChannel(p, q, h + 1 / 3);
  const g = hueToChannel(p, q, h);
  const b = hueToChannel(p, q, h - 1 / 3);
  return `#${hex2(Math.round(r * 255))}${hex2(Math.round(g * 255))}${hex2(Math.round(b * 255))}`;
}

function hueToChannel(p: number, q: number, t: number): number {
  let x = t;
  if (x < 0) x += 1;
  if (x > 1) x -= 1;
  if (x < 1 / 6) return p + (q - p) * 6 * x;
  if (x < 1 / 2) return q;
  if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
  return p;
}

function hex2(n: number): string {
  const clamped = n < 0 ? 0 : n > 255 ? 255 : n;
  return clamped.toString(16).padStart(2, '0');
}

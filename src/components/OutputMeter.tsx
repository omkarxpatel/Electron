import { memo, useEffect, useRef } from 'react';

/**
 * Stereo output level meter for the Enhancer strip.
 *
 * The rest of the strip tells you what the chain is *doing* (AUTO trim, GR,
 * CLIP). This one tells you how loud the result actually is, per channel,
 * which is the number the OS receives.
 *
 * Two things worth knowing about what's being measured:
 *
 *   • The stereo analysers tap post-limiter but PRE master gain, so the
 *     volume knob is applied here in software — same as the clip detector.
 *     A 250% volume genuinely reads +8 dB over a 100% one; the meter does
 *     not quietly normalize that away.
 *   • The scale runs past 0 dBFS on purpose. Volume is a literal multiplier,
 *     so overshoot is reachable, and a meter that stopped at 0 would hide
 *     exactly the condition CLIP is there to report.
 *
 * Ballistics are peak-with-decay (instant attack, 24 dB/s fall) plus a
 * ~0.9 s peak hold marker, so transients stay readable instead of flashing
 * for one frame. Everything is written to DOM refs from a single rAF loop —
 * routing 60 Hz meter updates through React state would re-render the whole
 * Enhancer every frame.
 */

interface Props {
  analyserL: AnalyserNode | null;
  analyserR: AnalyserNode | null;
  /** Enhancer master volume, 0..250 (% of unity). Applied downstream of the
   *  analyser tap, so the meter has to fold it in itself. */
  volume: number;
  /** Paused when the window is hidden — no point metering an unseen UI. */
  active: boolean;
}

const MIN_DB = -54;
const MAX_DB = 6;
const DECAY_DB_PER_SEC = 24;
const HOLD_MS = 900;

/** dB → 0..1 across the drawn scale. */
function norm(db: number): number {
  return Math.max(0, Math.min(1, (db - MIN_DB) / (MAX_DB - MIN_DB)));
}

export const OutputMeter = memo(OutputMeterImpl);

function OutputMeterImpl({ analyserL, analyserR, volume, active }: Props) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const valRef = useRef<HTMLSpanElement | null>(null);
  // Read in the rAF loop without re-subscribing the effect on every knob turn.
  const volumeRef = useRef(volume);
  volumeRef.current = volume;

  useEffect(() => {
    if (!active || !analyserL || !analyserR) return;
    const root = rootRef.current;
    if (!root) return;

    const fills = Array.from(root.querySelectorAll<HTMLElement>('.output-meter-fill'));
    const holds = Array.from(root.querySelectorAll<HTMLElement>('.output-meter-hold'));
    if (fills.length !== 2 || holds.length !== 2) return;

    const analysers = [analyserL, analyserR];
    const buf = new Float32Array(analyserL.fftSize);
    const level = [MIN_DB, MIN_DB];
    const hold = [MIN_DB, MIN_DB];
    const holdUntil = [0, 0];
    let last = performance.now();
    // -Infinity is the "below the scale" sentinel; unlike NaN it compares
    // equal to itself, so the no-change check below works for silence too.
    let lastValBucket = Number.NEGATIVE_INFINITY;
    let overOn = false;
    let raf = 0;

    const tick = () => {
      raf = requestAnimationFrame(tick);
      const now = performance.now();
      // Clamped so a stalled tab doesn't drop every bar to the floor at once.
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const gain = volumeRef.current / 100;
      let loudest = -Infinity;

      for (let ch = 0; ch < 2; ch++) {
        analysers[ch].getFloatTimeDomainData(buf);
        let peak = 0;
        for (let i = 0; i < buf.length; i++) {
          const a = Math.abs(buf[i]);
          if (a > peak) peak = a;
        }
        const scaled = peak * gain;
        const db = scaled > 0 ? 20 * Math.log10(scaled) : -Infinity;
        if (db > loudest) loudest = db;

        // Instant attack, linear-dB release.
        level[ch] = db > level[ch] ? db : Math.max(MIN_DB, level[ch] - DECAY_DB_PER_SEC * dt);
        if (db >= hold[ch]) {
          hold[ch] = db;
          holdUntil[ch] = now + HOLD_MS;
        } else if (now > holdUntil[ch]) {
          hold[ch] = Math.max(MIN_DB, hold[ch] - DECAY_DB_PER_SEC * dt);
        }

        // clip-path rather than scaleX: the LED ladder's green/amber/red
        // zones have to stay pinned to their dB positions, and a transform
        // would squash the gradient along with the bar. Paint-only on an
        // 8px strip, so still no layout work.
        fills[ch].style.clipPath = `inset(0 ${(1 - norm(level[ch])) * 100}% 0 0)`;
        holds[ch].style.left = `${norm(hold[ch]) * 100}%`;
      }

      // Numeric readout, only touched when the displayed digits change.
      // Anything under the scale floor (including digital silence and a
      // volume of 0) reads as -∞ rather than freezing on the last value.
      const bucket = loudest > MIN_DB ? Math.round(loudest * 10) : Number.NEGATIVE_INFINITY;
      if (bucket !== lastValBucket) {
        lastValBucket = bucket;
        if (valRef.current) {
          valRef.current.textContent = Number.isFinite(bucket)
            ? `${loudest > 0 ? '+' : ''}${loudest.toFixed(1)}`
            : '-∞';
        }
      }

      const over = loudest > 0;
      if (over !== overOn) {
        overOn = over;
        root.classList.toggle('is-over', over);
      }
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [analyserL, analyserR, active]);

  return (
    <div
      className="output-meter"
      ref={rootRef}
      title="Output level per channel, after the volume knob. Tick marks 0 dBFS; bars turn red past it."
    >
      <div className="output-meter-head">
        <span className="output-meter-key">OUT</span>
        <span className="output-meter-val" ref={valRef}>
          -∞
        </span>
        <span className="output-meter-unit">dBFS</span>
      </div>

      {(['L', 'R'] as const).map((ch) => (
        <div className="output-meter-row" key={ch}>
          <span className="output-meter-ch">{ch}</span>
          <span className="output-meter-track">
            <span className="output-meter-fill" />
            <span className="output-meter-grille" />
            <span className="output-meter-zero" />
            <span className="output-meter-hold" />
          </span>
        </div>
      ))}
    </div>
  );
}

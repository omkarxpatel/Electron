import { memo, useEffect, useRef } from 'react';

/**
 * Live gain-staging readout for the Enhancer strip.
 *
 * Three things the chain does silently, made visible:
 *
 *   AUTO   headroom the EQ auto-trim is giving back. A boost that reads
 *          "+12" on a slider costs 12 dB here — that is the trim doing its
 *          job (tone changed, level didn't) rather than the boost failing.
 *   GR     live limiter gain reduction. Should sit near zero now; sustained
 *          movement means something upstream is still driving the ceiling.
 *   CLIP   output past 0 dBFS. Volume is a literal multiplier by design, so
 *          the chain does not stop you here — it just stops being silent
 *          about it.
 *
 * Values are written straight to DOM refs from a rAF loop. Routing 60 Hz
 * meter updates through React state would re-render the whole Enhancer
 * (five knobs) every frame for a few changed characters.
 */

interface Props {
  limiter: DynamicsCompressorNode | null;
  analyser: AnalyserNode | null;
  /** Enhancer master volume, 0..250 (% of unity). */
  volume: number;
  /** Headroom currently given back by the EQ auto-trim, dB (>= 0). */
  autoTrimDb: number;
  /** Paused when the window is hidden — no point metering an unseen UI. */
  active: boolean;
}

/** Hold a clip indication this long so a single-frame overshoot is visible. */
const CLIP_HOLD_MS = 1200;

export const HeadroomMeter = memo(HeadroomMeterImpl);

function HeadroomMeterImpl({ limiter, analyser, volume, autoTrimDb, active }: Props) {
  const grTextRef = useRef<HTMLSpanElement | null>(null);
  const grFillRef = useRef<HTMLSpanElement | null>(null);
  const clipRef = useRef<HTMLDivElement | null>(null);
  // Read in the rAF loop without re-subscribing the effect on every knob turn.
  const volumeRef = useRef(volume);
  volumeRef.current = volume;

  useEffect(() => {
    if (!active || (!limiter && !analyser)) return;
    const buf = analyser ? new Float32Array(analyser.fftSize) : null;
    let raf = 0;
    let clipUntil = 0;
    let lastGrBucket = -1;
    let clipOn = false;

    const tick = () => {
      raf = requestAnimationFrame(tick);
      const now = performance.now();

      // ── Limiter gain reduction ──
      // `.reduction` is negative dB (0 = idle). Bar is scaled to 12 dB.
      const gr = limiter ? -limiter.reduction : 0;
      const bucket = Math.round(gr * 10);
      if (bucket !== lastGrBucket) {
        lastGrBucket = bucket;
        if (grTextRef.current) {
          grTextRef.current.textContent = gr < 0.05 ? '0.0' : `-${gr.toFixed(1)}`;
        }
        if (grFillRef.current) {
          grFillRef.current.style.width = `${Math.min(100, (gr / 12) * 100)}%`;
        }
      }

      // ── Clip detection ──
      // The analyser taps pre-master, so scale its peak by the volume knob to
      // get what actually reaches the destination. Anything over 1.0 is past
      // full scale and the OS will hard-clip it.
      if (analyser && buf) {
        analyser.getFloatTimeDomainData(buf);
        let peak = 0;
        for (let i = 0; i < buf.length; i++) {
          const a = Math.abs(buf[i]);
          if (a > peak) peak = a;
        }
        if (peak * (volumeRef.current / 100) > 1) clipUntil = now + CLIP_HOLD_MS;
      }
      const shouldClip = now < clipUntil;
      if (shouldClip !== clipOn) {
        clipOn = shouldClip;
        clipRef.current?.classList.toggle('is-clipping', shouldClip);
      }
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [limiter, analyser, active]);

  const trimLabel = autoTrimDb >= 0.05 ? `-${autoTrimDb.toFixed(1)}` : '0.0';

  return (
    <div className="headroom-meter" ref={clipRef}>
      <div className="headroom-row">
        <span className="headroom-key" title="Headroom the EQ auto-trim is giving back so boosts change tone, not level">
          AUTO
        </span>
        <span className="headroom-val">{trimLabel}</span>
        <span className="headroom-unit">dB</span>
      </div>

      <div className="headroom-row">
        <span className="headroom-key" title="Live limiter gain reduction">
          GR
        </span>
        <span className="headroom-val" ref={grTextRef}>
          0.0
        </span>
        <span className="headroom-unit">dB</span>
      </div>

      <div className="headroom-bar" aria-hidden>
        <span className="headroom-bar-fill" ref={grFillRef} />
      </div>

      <div className="headroom-clip" title="Output is past 0 dBFS and the OS is hard-clipping it. Lower the volume knob.">
        CLIP
      </div>
    </div>
  );
}

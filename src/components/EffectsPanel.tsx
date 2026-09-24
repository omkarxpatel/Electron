import {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import type { UseEffectsRackReturn } from '../state/effects';
import type { AiEffectTargets } from '../audio/useAiEnhancer';
import { Knob } from './Knob';

/**
 * The effects rack — stereo width, bass exciter and reverb.
 *
 * Collapsed to a single bar that expands on hover. The EQ column is a
 * fixed-height mixer layout with no spare room, so the expanded rack is an
 * absolutely-positioned popover anchored to the bar: it floats over the
 * enhancer card instead of competing for height. An earlier always-open
 * version squeezed the preset column until it disappeared.
 *
 * Controls are Knobs, not range inputs. Everything around this — the
 * enhancer's tone trio, the EQ faders — is a custom instrument, and a row of
 * default browser sliders read as a settings form dropped into a mixer.
 *
 * Open/close mirrors the Spotify library overlay: hover opens, leaving
 * schedules a close after a grace period so crossing the gap between bar and
 * popover doesn't dismiss it, click toggles, Esc closes.
 */

interface Props {
  effects: UseEffectsRackReturn;
  /** Width / exciter values the AI Enhancer is currently driving, or null
   *  when it isn't. Non-null makes those two modules read-only: the AI
   *  rewrites them 10x/sec, so leaving the knobs live would just let it
   *  overwrite a drag half a second later. */
  aiEffects?: AiEffectTargets | null;
  /** Post-EQ stereo pair — drives the phase-correlation meter. */
  analyserL: AnalyserNode | null;
  analyserR: AnalyserNode | null;
  /** Peak catcher — drives the gain-reduction meter. */
  limiter: DynamicsCompressorNode | null;
  /** Window-visibility gate. The meter RAF stops entirely when false. */
  active: boolean;
}

/** ~18 Hz. Fast enough to read as live, far cheaper than every frame — and
 *  these meters are a glanceable strip, not an instrument. */
const METER_TICK_MS = 55;
/** Correlation jitters hard on real music; smooth it or it's unreadable. */
const CORR_SMOOTHING = 0.82;
/** Gain reduction should snap down and ease back, like any GR meter. */
const GR_ATTACK = 0.5;
const GR_RELEASE = 0.88;
/** Full-scale for the GR meter. Past this the limiter is being abused. */
const GR_FULL_SCALE_DB = 12;
/** Below this summed energy we call it silence — correlation is undefined
 *  on a dead signal and would otherwise flail between ±1 on dither. */
const SILENCE_FLOOR = 1e-3;

/** Matches the Spotify overlay's close delay — long enough to cross the gap
 *  between the bar and the popover without losing it. */
const CLOSE_GRACE_MS = 260;
/* Larger than the enhancer's 58: this popover has the whole EQ column's
   width and only six controls in it, so undersized knobs just left air. */
const KNOB_SIZE = 68;

export const EffectsPanel = memo(EffectsPanelImpl);

function EffectsPanelImpl({ effects, aiEffects, analyserL, analyserR, limiter, active }: Props) {
  // The AI owns width + exciter while it's driving them, so show ITS values
  // on those knobs. The user's stored state is untouched underneath and comes
  // straight back when Auto effects is switched off.
  const autoFx = aiEffects ?? null;
  const state = autoFx
    ? {
        ...effects.state,
        width: autoFx.width,
        exciter: autoFx.exciter,
        exciterFreq: autoFx.exciterFreq,
      }
    : effects.state;
  const [open, setOpen] = useState(false);
  const closeTimerRef = useRef<number | null>(null);

  const cancelClose = useCallback((): void => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }, []);
  const openNow = useCallback((): void => {
    cancelClose();
    setOpen(true);
  }, [cancelClose]);
  const closeNow = useCallback((): void => {
    cancelClose();
    setOpen(false);
  }, [cancelClose]);
  const requestClose = useCallback((): void => {
    cancelClose();
    closeTimerRef.current = window.setTimeout(() => {
      setOpen(false);
      closeTimerRef.current = null;
    }, CLOSE_GRACE_MS);
  }, [cancelClose]);

  useEffect(() => () => cancelClose(), [cancelClose]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') closeNow();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, closeNow]);

  /*
   * Live meters.
   *
   * These write straight to the DOM through refs instead of React state:
   * at ~18 Hz, setState would re-render the whole rack (and its six knobs)
   * eighteen times a second for two numbers. Same approach the other live
   * readouts in this app take.
   */
  const corrFillRef = useRef<HTMLSpanElement>(null);
  const corrValueRef = useRef<HTMLSpanElement>(null);
  const grFillRef = useRef<HTMLSpanElement>(null);
  const grValueRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!active) return;
    if (!analyserL && !analyserR && !limiter) return;

    const bufL = analyserL ? new Uint8Array(analyserL.fftSize) : null;
    const bufR = analyserR ? new Uint8Array(analyserR.fftSize) : null;
    let corrSmoothed = 0;
    let grSmoothed = 0;
    let last = 0;
    let raf = 0;

    const loop = (now: number): void => {
      raf = requestAnimationFrame(loop);
      if (now - last < METER_TICK_MS) return;
      last = now;

      /* ── Phase correlation: normalized dot product of L and R ──
         +1 = identical channels (mono), 0 = uncorrelated (wide),
         negative = out of phase and it will partially cancel if anything
         downstream sums to mono. Every 4th sample is plenty for a strip
         this size and quarters the work. */
      if (bufL && bufR && analyserL && analyserR) {
        analyserL.getByteTimeDomainData(bufL);
        analyserR.getByteTimeDomainData(bufR);
        let sumLR = 0;
        let sumLL = 0;
        let sumRR = 0;
        for (let i = 0; i < bufL.length; i += 4) {
          const a = (bufL[i] - 128) / 128;
          const b = (bufR[i] - 128) / 128;
          sumLR += a * b;
          sumLL += a * a;
          sumRR += b * b;
        }
        const silent = sumLL + sumRR < SILENCE_FLOOR;
        const denom = Math.sqrt(sumLL * sumRR);
        if (silent || denom < 1e-9) {
          // Decay toward centre rather than freezing on the last value.
          corrSmoothed *= CORR_SMOOTHING;
          writeCorrelation(corrFillRef.current, corrValueRef.current, corrSmoothed, true);
        } else {
          const corr = Math.max(-1, Math.min(1, sumLR / denom));
          corrSmoothed = corrSmoothed * CORR_SMOOTHING + corr * (1 - CORR_SMOOTHING);
          writeCorrelation(corrFillRef.current, corrValueRef.current, corrSmoothed, false);
        }
      }

      /* ── Limiter gain reduction ── `reduction` is dB and always <= 0. */
      if (limiter) {
        const gr = Math.max(0, -limiter.reduction);
        // Asymmetric smoothing: catch the grab, ease the recovery.
        const coeff = gr > grSmoothed ? GR_ATTACK : GR_RELEASE;
        grSmoothed = grSmoothed * coeff + gr * (1 - coeff);
        writeGainReduction(grFillRef.current, grValueRef.current, grSmoothed);
      }
    };

    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [active, analyserL, analyserR, limiter]);

  const widthOn = state.width !== 100;
  const exciterOn = state.exciter > 0;
  const reverbOn = state.reverbMix > 0;
  const anyActive = widthOn || exciterOn || reverbOn;

  return (
    <div
      className="effects-dock"
      onMouseEnter={openNow}
      onMouseLeave={requestClose}
      data-open={open ? 'true' : 'false'}
    >
      <div className="effects-bar">
        <button
          type="button"
          className="effects-bar-toggle"
          onClick={() => (open ? closeNow() : openNow())}
          aria-expanded={open}
          title="Stereo width, bass exciter and reverb"
        >
          <span className="effects-title" data-active={anyActive}>
            Effects
          </span>

          {/*
            Three equal meters spanning the bar rather than text bunched at
            one end. The bar is as wide as the EQ column, so a short label
            list left a void down the middle; a proportional fill uses that
            width and shows relative amounts at a glance. Slots are always
            present — a row that reflows as you toggle things never sits
            still long enough to read.

            The thirds line up with the three knob groups in the popover
            above, so expanding feels like the same object growing.
          */}
          <span className="fx-readout">
            {/* Phase and Limit are measurements, not settings — they answer
                "what is the chain doing to the audio right now", which the
                numbers in the popover can't. Reverb has no meaningful live
                measurement, so it stays a parameter bar. */}
            <MeterSlot
              label="Phase"
              bipolar
              live={!!analyserL && !!analyserR}
              fillRef={corrFillRef}
              valueRef={corrValueRef}
              title="Stereo correlation. +1 is mono, 0 is wide, below zero means the channels partially cancel if anything downstream sums to mono."
            />
            <MeterSlot
              label="Limit"
              live={!!limiter}
              fillRef={grFillRef}
              valueRef={grValueRef}
              title="How hard the peak limiter is working. The exciter and reverb both add energy — this is where that shows up."
            />
            <ReadoutSlot
              label="Reverb"
              active={reverbOn}
              value={reverbOn ? `${Math.round(state.reverbMix)}%` : 'off'}
              fill={state.reverbMix / 100}
            />
          </span>

          <span className="effects-chevron" aria-hidden>
            ▾
          </span>
        </button>

        <button
          type="button"
          className={`effects-ab ${state.abBypass ? 'is-bypassed' : 'is-on'}`}
          onClick={effects.toggleAbBypass}
          aria-pressed={state.abBypass}
          title="Compare processed against the raw input. Not level matched — that's the point."
        >
          {state.abBypass ? 'A · RAW' : 'B · PROCESSED'}
        </button>
      </div>

      <div className="effects-pop" data-open={open ? 'true' : 'false'} aria-hidden={!open}>
        <header className="effects-pop-header">
          <h3 className="effects-pop-title">Effects</h3>
          <button
            type="button"
            className="effects-reset"
            onClick={effects.reset}
            title="Reset width, exciter and reverb. Leaves the A/B switch alone."
          >
            Reset
          </button>
        </header>

        {state.abBypass && (
          <div className="effects-ab-notice">
            Hearing the raw input — EQ, enhancer and effects are all out of circuit.
          </div>
        )}

        {/* Grouped per effect rather than one flat list of six controls, so a
            sub-parameter reads as belonging to its parent — and dimming a
            whole module when its amount is zero becomes self-explanatory. */}
        <div className="fx-modules">
          <FxModule name="Width" active={widthOn} knobs={1} solo auto={!!autoFx}>
            <Knob
              label="Amount"
              value={state.width}
              min={0}
              max={200}
              defaultValue={100}
              bipolar
              size={KNOB_SIZE}
              format={formatWidth}
              onChange={effects.setWidth}
            />
          </FxModule>

          <FxModule name="Exciter" active={exciterOn} knobs={2} auto={!!autoFx}>
            <Knob
              label="Amount"
              value={state.exciter}
              min={0}
              max={100}
              defaultValue={0}
              size={KNOB_SIZE}
              format={(v) => `${Math.round(v)}%`}
              onChange={effects.setExciter}
            />
            <FxSubKnob dim={!exciterOn}>
              <Knob
                label="Cross"
                value={state.exciterFreq}
                min={40}
                max={160}
                defaultValue={90}
                size={KNOB_SIZE}
                format={(v) => `${Math.round(v)}Hz`}
                onChange={effects.setExciterFreq}
              />
            </FxSubKnob>
          </FxModule>

          <FxModule name="Reverb" active={reverbOn} knobs={3}>
            <Knob
              label="Mix"
              value={state.reverbMix}
              min={0}
              max={100}
              defaultValue={0}
              size={KNOB_SIZE}
              format={(v) => `${Math.round(v)}%`}
              onChange={effects.setReverbMix}
            />
            <FxSubKnob dim={!reverbOn}>
              <Knob
                label="Decay"
                value={state.reverbDecay}
                min={0.2}
                max={5}
                defaultValue={1.6}
                size={KNOB_SIZE}
                format={(v) => `${v.toFixed(1)}s`}
                onChange={effects.setReverbDecay}
              />
            </FxSubKnob>
            <FxSubKnob dim={!reverbOn}>
              <Knob
                label="Tone"
                value={state.reverbTone}
                min={500}
                max={16000}
                defaultValue={6000}
                size={KNOB_SIZE}
                format={formatTone}
                onChange={effects.setReverbTone}
              />
            </FxSubKnob>
          </FxModule>
        </div>
      </div>
    </div>
  );
}

function formatWidth(v: number): string {
  if (v === 100) return 'off';
  if (v === 0) return 'mono';
  return `${Math.round(v)}%`;
}

function formatTone(v: number): string {
  return v >= 1000 ? `${(v / 1000).toFixed(1)}k` : `${Math.round(v)}`;
}

/**
 * Paint the correlation meter. Fills outward from centre: right toward mono,
 * left into out-of-phase, which is the one direction worth flagging — it's
 * the state that makes a track collapse when summed to mono.
 */
function writeCorrelation(
  fill: HTMLSpanElement | null,
  value: HTMLSpanElement | null,
  corr: number,
  silent: boolean,
): void {
  if (fill) {
    const half = Math.abs(corr) * 50;
    fill.style.left = corr >= 0 ? '50%' : `${50 - half}%`;
    fill.style.width = `${half}%`;
    fill.dataset.warn = corr < -0.1 ? 'true' : 'false';
  }
  if (value) value.textContent = silent ? '—' : formatSigned(corr);
}

/** Paint the gain-reduction meter. Fills left-to-right like every GR meter,
 *  and flags amber once the limiter is doing real work. */
function writeGainReduction(
  fill: HTMLSpanElement | null,
  value: HTMLSpanElement | null,
  db: number,
): void {
  if (fill) {
    fill.style.left = '0%';
    fill.style.width = `${Math.min(100, (db / GR_FULL_SCALE_DB) * 100)}%`;
    fill.dataset.warn = db > 6 ? 'true' : 'false';
  }
  if (value) value.textContent = db < 0.1 ? '0 dB' : `-${db.toFixed(1)} dB`;
}

function formatSigned(v: number): string {
  const s = v.toFixed(2);
  return v > 0 ? `+${s}` : s;
}

/** A live measurement slot. The fill and value are driven imperatively by the
 *  meter RAF, so this renders once and then stays out of the way. */
function MeterSlot({
  label,
  live,
  bipolar,
  fillRef,
  valueRef,
  title,
}: {
  label: string;
  /** False when the source node doesn't exist yet (no audio stream). */
  live: boolean;
  bipolar?: boolean;
  fillRef: React.RefObject<HTMLSpanElement | null>;
  valueRef: React.RefObject<HTMLSpanElement | null>;
  title: string;
}) {
  return (
    <span className="fx-slot" data-active={live} data-meter="true" title={title}>
      <span className="fx-slot-name">{label}</span>
      <span className="fx-slot-track" data-bipolar={bipolar ? 'true' : 'false'}>
        <span className="fx-slot-fill fx-slot-fill-live" ref={fillRef} />
      </span>
      <span className="fx-slot-value" ref={valueRef}>
        {live ? '—' : 'off'}
      </span>
    </span>
  );
}

function ReadoutSlot({
  label,
  active,
  value,
  fill,
}: {
  label: string;
  active: boolean;
  value: string;
  /** 0..1 — drives the track fill. */
  fill: number;
}) {
  return (
    <span className="fx-slot" data-active={active}>
      <span className="fx-slot-name">{label}</span>
      <span className="fx-slot-track">
        <span className="fx-slot-fill" style={{ width: `${Math.round(fill * 100)}%` }} />
      </span>
      <span className="fx-slot-value">{value}</span>
    </span>
  );
}

function FxModule({
  name,
  active,
  knobs,
  solo,
  auto,
  children,
}: {
  name: string;
  active: boolean;
  /** How many controls this module holds. Drives its share of the row so
   *  every knob gets comparable space regardless of grouping. */
  knobs: number;
  /** Single-knob module — its knob's own label repeats the module name, so
   *  the label is hidden visually (the knob keeps its aria-label). */
  solo?: boolean;
  /** The AI Enhancer is driving this module. Its knobs show the AI's values
   *  and go inert — same wrapper-gating trick as FxSubKnob, since Knob has no
   *  disabled prop. */
  auto?: boolean;
  children: ReactNode;
}) {
  return (
    <section
      className="fx-module"
      data-active={active}
      data-auto={auto ? 'true' : 'false'}
      data-solo={solo ? 'true' : 'false'}
      style={{ '--fx-weight': knobs } as CSSProperties}
    >
      <header className="fx-module-head">
        <span className="fx-module-dot" aria-hidden />
        <span className="fx-module-name">{name}</span>
        {auto && (
          <span className="fx-module-auto" title="Driven by AI Enhance. Switch off Auto effects to take this back.">
            AUTO
          </span>
        )}
      </header>
      <div className="fx-module-body" data-auto={auto ? 'true' : 'false'}>
        {children}
      </div>
    </section>
  );
}

/** A dependent control — inert and faded while its parent effect is at zero.
 *  Knob has no disabled prop, so the gating lives on the wrapper. */
function FxSubKnob({ dim, children }: { dim: boolean; children: ReactNode }) {
  return (
    <div className="fx-subknob" data-dim={dim}>
      {children}
    </div>
  );
}

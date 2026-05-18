import { memo, useEffect, useMemo, useRef, useState } from 'react';
import {
  EQ_PRESETS,
  frequenciesFor,
  labelFor,
  qFor,
  type BandCount,
  type EQPresetId,
  type EQState,
} from '../state/eq';
import { useRenderCount } from '../perf';
import { EqBandActivity } from './EqBandActivity';
import { EqResponseCurve } from './EqResponseCurve';
import { EnhancerPanel } from './EnhancerPanel';
import type { EnhancerState } from '../state/enhancer';
import type { PaletteId } from '../state/settings';

interface Props {
  state: EQState;
  setBand: (index: number, value: number) => void;
  setPreamp: (value: number) => void;
  setBandCount: (count: BandCount) => void;
  applyPreset: (id: Exclude<EQPresetId, 'custom'>) => void;
  toggleBypass: () => void;
  toggleBandLock: (index: number) => void;
  toggleAiEnhance: () => void;
  /** Per-band flags driven by the AI enhancer engine — true for ~500ms after
   *  the engine just nudged that band. Used to flash the slider in the UI. */
  bandAutoActive?: boolean[];
  /** Per-band AI delta in dB (signed). Slider visually shows baseline + delta
   *  so the thumb actually moves when the AI is adjusting. */
  aiDelta?: number[];
  /** When false, the response-curve halo + band-activity RAF loops are paused. */
  active?: boolean;
  reset: () => void;
  playthrough: boolean;
  togglePlaythrough: () => void;
  playthroughDisabled?: boolean;
  enhancerState: EnhancerState;
  setBass: (v: number) => void;
  setMid: (v: number) => void;
  setTreble: (v: number) => void;
  setVolume: (v: number) => void;
  setBalance: (v: number) => void;
  toggleEnhancerBypass: () => void;
  resetEnhancer: () => void;
  accent: string;
  /** Active visualizer palette — threaded down so the EQ band activity bars
   *  render with a per-band gradient matching the visualizer below. */
  paletteId: PaletteId;
  analyser: AnalyserNode | null;
}

const BAND_COUNTS: ReadonlyArray<BandCount> = [10, 15, 31];

export const EqPanel = memo(EqPanelImpl);

function EqPanelImpl({
  state,
  setBand,
  setPreamp,
  setBandCount,
  applyPreset,
  toggleBypass,
  toggleBandLock,
  toggleAiEnhance,
  bandAutoActive,
  aiDelta,
  active = true,
  reset,
  playthrough,
  togglePlaythrough,
  playthroughDisabled = false,
  enhancerState,
  setBass,
  setMid,
  setTreble,
  setVolume,
  setBalance,
  toggleEnhancerBypass,
  resetEnhancer,
  accent,
  paletteId,
  analyser,
}: Props) {
  const freqs = frequenciesFor(state.bandCount);
  useRenderCount('EqPanel');
  const Q = qFor(state.bandCount);
  const preampPercent = ((state.preamp + 12) / 24) * 100;

  // Effective band values = user baseline + AI delta (clamped). The response
  // curve and band activity bars both render from this so they reflect what
  // the audio engine is actually applying, not just the user's baseline.
  // Common case: AI is off (or all deltas are 0) — return state.bands by
  // reference so memo'd children downstream short-circuit.
  const effectiveBands = useMemo(() => {
    if (!aiDelta || aiDelta.length === 0) return state.bands;
    let anyNonZero = false;
    for (let i = 0; i < aiDelta.length; i++) {
      if (aiDelta[i] !== 0) { anyNonZero = true; break; }
    }
    if (!anyNonZero) return state.bands;
    return state.bands.map((v, i) => {
      const d = aiDelta[i] ?? 0;
      const sum = v + d;
      return sum > 12 ? 12 : sum < -12 ? -12 : sum;
    });
  }, [state.bands, aiDelta]);

  /* Multi-band drag-select.
   *
   * UX: pointer-down on any band cell (outside the slider thumb) starts a
   * range selection; dragging across other bands extends the range. Once
   * 2+ bands are selected, dragging ANY selected band's slider moves all
   * selected bands by the same dB delta (so the "shape" between them is
   * preserved). Esc clears the selection. */
  const [selectedBands, setSelectedBands] = useState<Set<number>>(() => new Set());
  const dragSelectStartRef = useRef<number | null>(null);
  // Tracks whether the current pointer interaction has crossed onto a
  // different label since pointerdown. On pointerup: if `false` we treat
  // the gesture as a click (toggle); if `true` we leave the
  // already-applied range selection alone.
  const draggedRef = useRef<boolean>(false);
  // Keep a ref to the latest bands array so the rate-of-change calc in
  // onChange (which can fire many times per drag) always sees fresh values
  // for the OTHER selected bands without re-running the effect.
  const bandsRef = useRef(state.bands);
  bandsRef.current = state.bands;

  useEffect(() => {
    const onPointerUp = () => {
      if (dragSelectStartRef.current !== null && !draggedRef.current) {
        const start = dragSelectStartRef.current;
        // Click (no drag): toggle the band in/out of the selection.
        setSelectedBands((prev) => {
          const next = new Set(prev);
          if (next.has(start)) next.delete(start);
          else next.add(start);
          return next;
        });
      }
      dragSelectStartRef.current = null;
      draggedRef.current = false;
    };
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as HTMLElement | null;
      // Clicking anywhere outside the band grid clears the selection.
      if (!target || !target.closest('.eq-bands')) {
        setSelectedBands(new Set());
        dragSelectStartRef.current = null;
        draggedRef.current = false;
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSelectedBands(new Set());
    };
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('keydown', onKey);
    };
  }, []);

  // Reset selection when band count changes — indices no longer line up.
  useEffect(() => {
    setSelectedBands(new Set());
  }, [state.bandCount]);

  const handleLabelPointerDown = (i: number, e: React.PointerEvent<HTMLSpanElement>) => {
    e.preventDefault();
    // Just record the start — the actual toggle happens on pointerup if
    // no drag occurred, OR the drag handler takes over as user moves
    // onto another label.
    dragSelectStartRef.current = i;
    draggedRef.current = false;
  };

  const handleLabelPointerEnter = (i: number, e: React.PointerEvent<HTMLSpanElement>) => {
    if (dragSelectStartRef.current === null) return;
    if (!(e.buttons & 1)) return;
    if (i === dragSelectStartRef.current) return;
    draggedRef.current = true;
    const start = dragSelectStartRef.current;
    const min = Math.min(start, i);
    const max = Math.max(start, i);
    const next = new Set<number>();
    for (let k = min; k <= max; k++) next.add(k);
    setSelectedBands(next);
  };

  const handleBandChange = (i: number, newValue: number) => {
    if (selectedBands.has(i) && selectedBands.size > 1) {
      const delta = newValue - bandsRef.current[i];
      if (delta === 0) return;
      for (const idx of selectedBands) {
        const target = Math.max(-12, Math.min(12, bandsRef.current[idx] + delta));
        setBand(idx, target);
      }
    } else {
      setBand(i, newValue);
    }
  };

  return (
    <aside
      className="eq-panel"
      data-bypass={state.bypass ? 'true' : 'false'}
      data-bands={state.bandCount}
    >
      <header className="eq-header">
        <div className="eq-header-left">
          <h2 className="eq-title">Equalizer</h2>
          <div className="eq-band-switcher" role="tablist" aria-label="Band count">
            {BAND_COUNTS.map((c) => (
              <button
                key={c}
                role="tab"
                aria-selected={state.bandCount === c}
                className={`eq-band-tab ${state.bandCount === c ? 'is-active' : ''}`}
                onClick={() => setBandCount(c)}
              >
                {c}
              </button>
            ))}
          </div>
        </div>
        <div className="eq-header-actions">
          <button
            className={`eq-live ${playthrough ? 'is-on' : ''}`}
            onClick={togglePlaythrough}
            disabled={playthroughDisabled}
            aria-pressed={playthrough}
            title={
              playthroughDisabled
                ? 'Pick an audio input first to enable playthrough'
                : playthrough
                ? 'Playing the EQ\'d audio through your speakers'
                : 'Click to play the EQ\'d audio through your speakers'
            }
          >
            <span className="eq-live-dot" /> Live
          </button>
          <button
            className={`eq-bypass ${state.bypass ? 'is-bypassed' : 'is-on'}`}
            onClick={toggleBypass}
            aria-pressed={!state.bypass}
          >
            {state.bypass ? 'OFF' : 'ON'}
          </button>
        </div>
      </header>

      <div className="eq-curve">
        <EqResponseCurve
          bands={effectiveBands}
          bandFreqs={freqs}
          Q={Q}
          preamp={state.preamp}
          bypass={state.bypass}
          bassEnhance={enhancerState.bypass ? 0 : enhancerState.bass}
          trebleEnhance={enhancerState.bypass ? 0 : enhancerState.treble}
          accent={accent}
          analyser={analyser}
          active={active}
        />
      </div>

      <div className="eq-controls">
        <div className="eq-preamp">
          <div className="eq-preamp-head">
            <span className="eq-preamp-label-text">Preamp</span>
            <span className="eq-preamp-value">{formatDb(state.preamp)}</span>
          </div>
          <div className="eq-preamp-track-wrap">
            <input
              type="range"
              className="eq-band-slider eq-preamp-fader"
              min={-12}
              max={12}
              step={0.5}
              value={state.preamp}
              onChange={(e) => setPreamp(Number(e.target.value))}
              style={{ ['--fill' as string]: `${preampPercent}%` }}
            />
          </div>
        </div>

        <div className="eq-bands" data-count={state.bandCount}>
          <EqBandActivity
            analyser={analyser}
            bandFreqs={freqs}
            bands={effectiveBands}
            paletteId={paletteId}
            active={active}
          />
          {state.bands.map((value, i) => (
            <BandSlider
              key={i}
              value={value}
              delta={aiDelta?.[i] ?? 0}
              freqLabel={labelFor(freqs[i])}
              onChange={(v) => handleBandChange(i, v)}
              compact={state.bandCount === 31}
              isSelected={selectedBands.has(i)}
              isLocked={state.locked[i] ?? false}
              aiEnabled={state.aiEnhance}
              isAutoActive={bandAutoActive?.[i] ?? false}
              onToggleLock={() => toggleBandLock(i)}
              onLabelPointerDown={(e) => handleLabelPointerDown(i, e)}
              onLabelPointerEnter={(e) => handleLabelPointerEnter(i, e)}
            />
          ))}
        </div>

        <div className="eq-side-column">
          <div className="eq-presets">
            <div className="eq-presets-row">
              {(Object.keys(EQ_PRESETS) as Array<Exclude<EQPresetId, 'custom'>>).map((id) => (
                <button
                  key={id}
                  className={`eq-preset-chip ${state.activePreset === id ? 'is-active' : ''}`}
                  onClick={() => applyPreset(id)}
                >
                  {EQ_PRESETS[id].label}
                </button>
              ))}
              <button
                type="button"
                className={`eq-preset-chip eq-preset-chip-ai ${state.aiEnhance ? 'is-active' : ''}`}
                onClick={toggleAiEnhance}
                title="AI Enhance — adapts the EQ in real time to whatever music is playing. Lock a band (lock icon next to its label) to keep its value fixed."
              >
                AI Enhance
              </button>
            </div>
            <button className="eq-reset" onClick={reset}>
              Reset
            </button>
          </div>
        </div>
      </div>

      <EnhancerPanel
        state={enhancerState}
        setBass={setBass}
        setMid={setMid}
        setTreble={setTreble}
        setVolume={setVolume}
        setBalance={setBalance}
        toggleBypass={toggleEnhancerBypass}
        reset={resetEnhancer}
      />
    </aside>
  );
}

interface BandSliderProps {
  value: number;
  /** AI per-band delta in dB (signed). Slider visually shows `value + delta`
   *  so the thumb actually moves when the engine is adjusting. */
  delta: number;
  freqLabel: string;
  onChange: (v: number) => void;
  compact: boolean;
  isSelected: boolean;
  isLocked: boolean;
  aiEnabled: boolean;
  isAutoActive: boolean;
  onToggleLock: () => void;
  onLabelPointerDown: (e: React.PointerEvent<HTMLSpanElement>) => void;
  onLabelPointerEnter: (e: React.PointerEvent<HTMLSpanElement>) => void;
}

const BandSlider = memo(BandSliderImpl);

function BandSliderImpl({
  value,
  delta,
  freqLabel,
  onChange,
  compact,
  isSelected,
  isLocked,
  aiEnabled,
  isAutoActive,
  onToggleLock,
  onLabelPointerDown,
  onLabelPointerEnter,
}: BandSliderProps) {
  // Effective slider position = user baseline + AI delta, clamped to [-12, 12].
  // When user drags, the displayed value is the new effective value; we
  // subtract the current delta to compute the new baseline so the effective
  // stays where they dropped it (and AI delta is paused on that band).
  const effective = Math.max(-12, Math.min(12, value + delta));
  const fillFromCenter = effective / 12; // -1..+1
  const percent = ((effective + 12) / 24) * 100;

  return (
    <div
      className="eq-band"
      data-positive={effective > 0 ? 'true' : 'false'}
      data-zero={effective === 0 ? 'true' : 'false'}
      data-selected={isSelected ? 'true' : 'false'}
      data-locked={isLocked ? 'true' : 'false'}
      data-auto-active={isAutoActive ? 'true' : 'false'}
    >
      <span className="eq-band-value">{formatDbCompact(effective)}</span>
      <div className="eq-band-track-wrap">
        <input
          type="range"
          className="eq-band-slider"
          min={-12}
          max={12}
          step={0.5}
          value={effective}
          onChange={(e) => {
            // Convert effective slider value back to a baseline change.
            // (delta is held by the engine; pausing happens via the parent's
            // setBand wrapper which calls aiHandle.noteUserTouch.)
            const newEffective = Number(e.target.value);
            onChange(newEffective - delta);
          }}
          aria-label={`${freqLabel} Hz band`}
          style={{
            ['--fill' as string]: `${percent}%`,
            ['--fill-from-center' as string]: `${fillFromCenter}`,
          }}
        />
      </div>
      {aiEnabled && (
        <button
          type="button"
          className="eq-band-lock"
          onClick={onToggleLock}
          aria-label={isLocked ? `Unlock ${freqLabel} Hz band` : `Lock ${freqLabel} Hz band`}
          aria-pressed={isLocked}
          title={isLocked ? 'Locked — AI Enhancer skips this band' : 'Click to lock this band so AI Enhancer leaves it alone'}
        >
          <LockIcon locked={isLocked} />
        </button>
      )}
      <span
        className={`eq-band-label ${compact ? 'is-compact' : ''}`}
        onPointerDown={onLabelPointerDown}
        onPointerEnter={onLabelPointerEnter}
        title="Click to select this band • drag to range-select • click again to deselect"
      >
        {freqLabel}
      </span>
    </div>
  );
}

function formatDb(v: number): string {
  if (Math.abs(v) < 0.05) return '0.0 dB';
  return `${v > 0 ? '+' : ''}${v.toFixed(1)} dB`;
}

function formatDbCompact(v: number): string {
  if (Math.abs(v) < 0.05) return '0';
  return `${v > 0 ? '+' : ''}${v.toFixed(0)}`;
}

/** Padlock icon for the per-band lock button. Closed shackle vs open
 *  shackle distinguishes the two states; inherits currentColor so palette
 *  theming applies. */
function LockIcon({ locked }: { locked: boolean }) {
  return (
    <svg width="11" height="11" viewBox="0 0 14 14" aria-hidden fill="none">
      <rect x="3" y="7" width="8" height="6" rx="1" stroke="currentColor" strokeWidth="1.4" />
      {locked ? (
        <path d="M5 7V5a2 2 0 0 1 4 0v2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      ) : (
        <path d="M5 7V5a2 2 0 0 1 4 0" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      )}
    </svg>
  );
}

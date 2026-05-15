import { useEffect, useRef, useState } from 'react';
import {
  EQ_PRESETS,
  frequenciesFor,
  labelFor,
  qFor,
  type BandCount,
  type EQPresetId,
  type EQState,
} from '../state/eq';
import { EqBandActivity } from './EqBandActivity';
import { EqResponseCurve } from './EqResponseCurve';
import { EnhancerPanel } from './EnhancerPanel';
import type { EnhancerState } from '../state/enhancer';

interface Props {
  state: EQState;
  setBand: (index: number, value: number) => void;
  setPreamp: (value: number) => void;
  setBandCount: (count: BandCount) => void;
  applyPreset: (id: Exclude<EQPresetId, 'custom'>) => void;
  toggleBypass: () => void;
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
  analyser: AnalyserNode | null;
}

const BAND_COUNTS: ReadonlyArray<BandCount> = [10, 15, 31];

export function EqPanel({
  state,
  setBand,
  setPreamp,
  setBandCount,
  applyPreset,
  toggleBypass,
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
  analyser,
}: Props) {
  const freqs = frequenciesFor(state.bandCount);
  const Q = qFor(state.bandCount);
  const preampPercent = ((state.preamp + 12) / 24) * 100;

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
          bands={state.bands}
          bandFreqs={freqs}
          Q={Q}
          preamp={state.preamp}
          bypass={state.bypass}
          bassEnhance={enhancerState.bypass ? 0 : enhancerState.bass}
          trebleEnhance={enhancerState.bypass ? 0 : enhancerState.treble}
          accent={accent}
          analyser={analyser}
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
            bands={state.bands}
            accent={accent}
          />
          {state.bands.map((value, i) => (
            <BandSlider
              key={i}
              value={value}
              freqLabel={labelFor(freqs[i])}
              onChange={(v) => handleBandChange(i, v)}
              compact={state.bandCount === 31}
              isSelected={selectedBands.has(i)}
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
  freqLabel: string;
  onChange: (v: number) => void;
  compact: boolean;
  isSelected: boolean;
  onLabelPointerDown: (e: React.PointerEvent<HTMLSpanElement>) => void;
  onLabelPointerEnter: (e: React.PointerEvent<HTMLSpanElement>) => void;
}

function BandSlider({
  value,
  freqLabel,
  onChange,
  compact,
  isSelected,
  onLabelPointerDown,
  onLabelPointerEnter,
}: BandSliderProps) {
  // Express position 0..1 with 0 at the center (0 dB). The CSS uses this to
  // tint the track from the midline outward.
  const fillFromCenter = (value / 12); // -1..+1
  const percent = ((value + 12) / 24) * 100;

  return (
    <div
      className="eq-band"
      data-positive={value > 0 ? 'true' : 'false'}
      data-zero={value === 0 ? 'true' : 'false'}
      data-selected={isSelected ? 'true' : 'false'}
    >
      <span className="eq-band-value">{formatDbCompact(value)}</span>
      <div className="eq-band-track-wrap">
        <input
          type="range"
          className="eq-band-slider"
          min={-12}
          max={12}
          step={0.5}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          aria-label={`${freqLabel} Hz band`}
          style={{
            ['--fill' as string]: `${percent}%`,
            ['--fill-from-center' as string]: `${fillFromCenter}`,
          }}
        />
      </div>
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

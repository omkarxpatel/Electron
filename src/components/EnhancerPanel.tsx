import { memo } from 'react';
import type { EnhancerState } from '../state/enhancer';
import { Knob } from './Knob';

interface Props {
  state: EnhancerState;
  setBass: (v: number) => void;
  setMid: (v: number) => void;
  setTreble: (v: number) => void;
  setVolume: (v: number) => void;
  setBalance: (v: number) => void;
  toggleBypass: () => void;
  reset: () => void;
}

const KNOB_SIZE = 58;

export const EnhancerPanel = memo(EnhancerPanelImpl);

function EnhancerPanelImpl({
  state,
  setBass,
  setMid,
  setTreble,
  setVolume,
  setBalance,
  toggleBypass,
  reset,
}: Props) {
  return (
    <div className="enhancer-panel" data-bypass={state.bypass ? 'true' : 'false'}>
      <header className="enhancer-header">
        <h3 className="enhancer-title">Enhancer</h3>
        <div className="enhancer-actions">
          <button
            className={`eq-bypass ${state.bypass ? 'is-bypassed' : 'is-on'}`}
            onClick={toggleBypass}
            aria-pressed={!state.bypass}
          >
            {state.bypass ? 'OFF' : 'ON'}
          </button>
          <button className="enhancer-reset" onClick={reset} title="Reset enhancer knobs">
            Reset
          </button>
        </div>
      </header>

      <div className="knob-stack">
        <Knob
          label="Bass"
          value={state.bass}
          min={-12}
          max={12}
          defaultValue={0}
          bipolar
          size={KNOB_SIZE}
          format={formatDb}
          onChange={setBass}
        />
        <Knob
          label="Mid"
          value={state.mid}
          min={-12}
          max={12}
          defaultValue={0}
          bipolar
          size={KNOB_SIZE}
          format={formatDb}
          onChange={setMid}
        />
        <Knob
          label="Treble"
          value={state.treble}
          min={-12}
          max={12}
          defaultValue={0}
          bipolar
          size={KNOB_SIZE}
          format={formatDb}
          onChange={setTreble}
        />
        <div className="knob-stack-divider" aria-hidden />
        <Knob
          label="Volume"
          value={state.volume}
          min={0}
          max={150}
          defaultValue={100}
          size={KNOB_SIZE}
          format={(v) => `${v.toFixed(0)}%`}
          onChange={setVolume}
        />
        <Knob
          label="Balance"
          value={state.balance} 
          min={-100}
          max={100}
          defaultValue={0}
          bipolar
          size={KNOB_SIZE}
          format={formatBalance}
          onChange={setBalance}
        />
      </div>
    </div>
  );
}

function formatDb(v: number): string {
  if (Math.abs(v) < 0.05) return '0';
  return `${v > 0 ? '+' : ''}${v.toFixed(1)}`;
}

function formatBalance(v: number): string {
  if (Math.abs(v) < 1) return 'C';
  return v > 0 ? `R${v.toFixed(0)}` : `L${Math.abs(v).toFixed(0)}`;
}

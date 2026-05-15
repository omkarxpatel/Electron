import type { Settings } from '../state/settings';
import { PALETTES } from '../visualizers/palettes';

interface Props {
  open: boolean;
  onClose: () => void;
  settings: Settings;
  update: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
  reset: () => void;
}

export function SettingsPanel({ open, onClose, settings, update, reset }: Props) {
  return (
    <aside className={`settings-panel ${open ? 'is-open' : ''}`} aria-hidden={!open}>
      <header className="panel-header">
        <h2>Customize</h2>
        <button className="icon-button" onClick={onClose} aria-label="Close settings">
          ×
        </button>
      </header>

      <div className="panel-body">
        <Section title="Palette">
          <div className="palette-grid">
            {Object.values(PALETTES).map((p) => (
              <button
                key={p.id}
                className={`palette-swatch ${settings.palette === p.id ? 'is-active' : ''}`}
                onClick={() => update('palette', p.id)}
                aria-label={p.label}
                style={{
                  background: `linear-gradient(135deg, ${p.stops
                    .map((s) => `${s.color} ${s.pos * 100}%`)
                    .join(', ')})`,
                }}
              >
                <span className="palette-label">{p.label}</span>
              </button>
            ))}
          </div>
        </Section>

        <Section title="Glow & motion">
          <Slider
            label="Glow"
            value={settings.glow}
            min={0}
            max={1}
            step={0.01}
            onChange={(v) => update('glow', v)}
          />
          <Slider
            label="Motion trail"
            value={settings.trail}
            min={0}
            max={0.6}
            step={0.01}
            onChange={(v) => update('trail', v)}
          />
          <Slider
            label="Sensitivity"
            value={settings.sensitivity}
            min={0.5}
            max={10}
            step={0.05}
            onChange={(v) => update('sensitivity', v)}
            format={(v) => `${v.toFixed(2)}×`}
          />
          <Slider
            label="Smoothing"
            value={settings.smoothing}
            min={0}
            max={0.95}
            step={0.01}
            onChange={(v) => update('smoothing', v)}
          />
        </Section>

        <Section title="Bars">
          <Slider
            label="Width"
            value={settings.barWidth}
            min={1}
            max={12}
            step={1}
            onChange={(v) => update('barWidth', v)}
            format={(v) => `${v.toFixed(0)} px`}
          />
          <Slider
            label="Gap"
            value={settings.barGap}
            min={0}
            max={6}
            step={1}
            onChange={(v) => update('barGap', v)}
            format={(v) => `${v.toFixed(0)} px`}
          />
        </Section>

        <Section title="Waveform style">
          <Segmented
            value={settings.waveformStyle}
            options={[
              { id: 'spectrum', label: 'Spectrum' },
              { id: 'ribbon', label: 'Ribbon' },
              { id: 'radial', label: 'Radial' },
              { id: 'dots', label: 'Dots' },
              { id: 'mirror', label: 'Mirror' },
              { id: 'bars', label: 'Bars' },
              { id: 'line', label: 'Line' },
              { id: 'filled', label: 'Filled' },
            ]}
            onChange={(v) => update('waveformStyle', v as Settings['waveformStyle'])}
          />
        </Section>

        <Section title="Background">
          <Segmented
            value={settings.background}
            options={[
              { id: 'glow', label: 'Glow' },
              { id: 'vignette', label: 'Vignette' },
              { id: 'solid', label: 'Solid' },
            ]}
            onChange={(v) => update('background', v as Settings['background'])}
          />
        </Section>

        <button className="reset-button" onClick={reset}>
          Reset to defaults
        </button>
      </div>
    </aside>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="panel-section">
      <h3>{title}</h3>
      {children}
    </section>
  );
}

interface SliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  format?: (v: number) => string;
}

function Slider({ label, value, min, max, step, onChange, format }: SliderProps) {
  const display = format ? format(value) : value.toFixed(2);
  return (
    <label className="slider-row">
      <div className="slider-labels">
        <span>{label}</span>
        <span className="slider-value">{display}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
      />
    </label>
  );
}

interface SegmentedProps<T extends string> {
  value: T;
  options: ReadonlyArray<{ id: T; label: string }>;
  onChange: (v: T) => void;
}

function Segmented<T extends string>({ value, options, onChange }: SegmentedProps<T>) {
  return (
    <div className="segmented">
      {options.map((o) => (
        <button
          key={o.id}
          className={`segmented-button ${value === o.id ? 'is-active' : ''}`}
          onClick={() => onChange(o.id)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

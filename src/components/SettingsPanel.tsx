import type { Settings } from '../state/settings';
import { PALETTES } from '../visualizers/palettes';

interface Props {
  open: boolean;
  onClose: () => void;
  settings: Settings;
  update: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
  reset: () => void;
  spotifyAuthed: boolean;
  onReconnectSpotify: () => void;
  onSignOutSpotify: () => void;
}

export function SettingsPanel({
  open,
  onClose,
  settings,
  update,
  reset,
  spotifyAuthed,
  onReconnectSpotify,
  onSignOutSpotify,
}: Props) {
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
            label={settings.autoGain ? 'Sensitivity (trim)' : 'Sensitivity'}
            value={settings.sensitivity}
            min={0.5}
            max={10}
            step={0.05}
            onChange={(v) => update('sensitivity', v)}
            format={(v) => `${v.toFixed(2)}×`}
            trailing={
              <button
                type="button"
                className={`segmented-button ${settings.autoGain ? 'is-active' : ''}`}
                onClick={() => update('autoGain', !settings.autoGain)}
                title="Auto level: normalizes loudness across songs so quiet tracks don't disappear and loud ones don't clip"
              >
                Auto
              </button>
            }
          />
          <Slider
            label="Smoothing"
            value={settings.smoothing}
            min={0}
            max={.95}
            step={0.01}
            onChange={(v) => update('smoothing', v)}
          />
          <label className="slider-row">
            <div className="slider-labels">
              <span>Spatial spectrum</span>
              <button
                type="button"
                className={`segmented-button ${settings.spectralPosition ? 'is-active' : ''}`}
                onClick={() => update('spectralPosition', !settings.spectralPosition)}
                title="Low frequencies drive the left side, highs drive the right — each part of the visual reacts to the audio at its position."
              >
                {settings.spectralPosition ? 'On' : 'Off'}
              </button>
            </div>
          </label>
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
              { id: 'particles', label: 'Particles' },
              { id: 'silk', label: 'Silk' },
            ]}
            onChange={(v) => update('waveformStyle', v as Settings['waveformStyle'])}
          />
        </Section>

        <Section title="Spotify">
          <div className="settings-spotify-row">
            <button
              type="button"
              className="settings-spotify-btn"
              onClick={onReconnectSpotify}
              title="Re-trigger Spotify OAuth — use if playlists fail to load or the token went stale."
            >
              {spotifyAuthed ? 'Reconnect' : 'Connect'}
            </button>
            {spotifyAuthed && (
              <button
                type="button"
                className="settings-spotify-btn settings-spotify-btn-danger"
                onClick={onSignOutSpotify}
                title="Sign out — clears the stored refresh token and disconnects this Spotify account."
              >
                Sign out
              </button>
            )}
          </div>
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
  trailing?: React.ReactNode;
}

function Slider({ label, value, min, max, step, onChange, format, trailing }: SliderProps) {
  const display = format ? format(value) : value.toFixed(2);
  return (
    <label className="slider-row">
      <div className="slider-labels">
        <span>{label}</span>
        <span className="slider-value">
          {trailing}
          {display}
        </span>
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

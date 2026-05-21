import { useCallback } from 'react';
import type { Settings } from '../state/settings';
import { PALETTES } from '../visualizers/palettes';
import {
  checkForUpdate,
  dismissVersion,
  downloadUpdate,
  installUpdate,
  openReleasePage,
  useUpdateState,
} from '../lib/updateService';
import type { UpdateState } from '../types/api';

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

        <Section title="About">
          <AboutSection />
        </Section>

        <button className="reset-button" onClick={reset}>
          Reset to defaults
        </button>
      </div>
    </aside>
  );
}

/**
 * Version + auto-update status mirror of the main-process state machine.
 * Renders the same state the top-bar UpdateBanner renders, but in a denser
 * Settings-panel form factor: always visible (even when up-to-date), with
 * a manual "Check for updates" trigger for users who want to force a check.
 *
 * All state lives in updateService — this is a pure consumer.
 */
function AboutSection() {
  const version = window.api.app.version;
  const state = useUpdateState();
  const handleCheck = useCallback(() => void checkForUpdate(), []);
  const handleDownload = useCallback(() => void downloadUpdate(), []);
  const handleInstall = useCallback(() => void installUpdate(), []);
  const handleOpenPage = useCallback(
    (url?: string) => void openReleasePage(url),
    [],
  );
  const handleSkip = useCallback(
    (v: string) => void dismissVersion(v),
    [],
  );

  return (
    <div className="settings-about">
      <div className="settings-about-row">
        <span className="settings-about-label">Version</span>
        <span className="settings-about-value">{version}</span>
      </div>
      <div className="settings-about-row">
        <span className="settings-about-label">Status</span>
        <span className="settings-about-value">{formatStateSummary(state)}</span>
      </div>

      <div className="settings-about-action">
        <button
          type="button"
          className="settings-spotify-btn"
          onClick={handleCheck}
          disabled={state.kind === 'checking' || state.kind === 'downloading'}
        >
          {state.kind === 'checking' ? 'Checking…' : 'Check for updates'}
        </button>
      </div>

      {state.kind === 'available' && (
        <div className="settings-about-update">
          <div className="settings-about-update-text">
            <strong>v{state.version} is available</strong>
            <span className="settings-about-update-asset">Downloading in the background…</span>
          </div>
          <div className="settings-about-update-actions">
            <button
              type="button"
              className="settings-spotify-btn"
              onClick={handleDownload}
            >
              Download now
            </button>
            <button
              type="button"
              className="settings-spotify-btn"
              onClick={() => handleOpenPage(state.releasePageUrl)}
            >
              View release
            </button>
            <button
              type="button"
              className="settings-spotify-btn settings-spotify-btn-danger"
              onClick={() => handleSkip(state.version)}
            >
              Skip
            </button>
          </div>
        </div>
      )}

      {state.kind === 'downloading' && (
        <div className="settings-about-update">
          <div className="settings-about-update-text">
            <strong>Downloading v{state.version}</strong>
            <span className="settings-about-update-asset">
              {state.progress.percent.toFixed(0)}% · {formatBytes(state.progress.transferred)} /{' '}
              {formatBytes(state.progress.total)}
            </span>
          </div>
          <div className="settings-about-progress" role="progressbar" aria-valuenow={state.progress.percent} aria-valuemin={0} aria-valuemax={100}>
            <div className="settings-about-progress-fill" style={{ width: `${state.progress.percent}%` }} />
          </div>
        </div>
      )}

      {state.kind === 'downloaded' && (
        <div className="settings-about-update">
          <div className="settings-about-update-text">
            <strong>v{state.version} ready to install</strong>
            <span className="settings-about-update-asset">
              Restart finishes the update. Settings and Spotify auth are preserved.
            </span>
          </div>
          <div className="settings-about-update-actions">
            <button
              type="button"
              className="settings-spotify-btn"
              onClick={handleInstall}
            >
              Restart now
            </button>
            <button
              type="button"
              className="settings-spotify-btn settings-spotify-btn-danger"
              onClick={() => handleSkip(state.version)}
            >
              Skip
            </button>
          </div>
        </div>
      )}

      {state.kind === 'error' && (
        <div className="settings-about-update settings-about-update-error">
          <div className="settings-about-update-text">
            <strong>{state.category === 'network' ? "Couldn't reach the update server" : 'Update check failed'}</strong>
            <span className="settings-about-update-asset">{truncate(state.message, 140)}</span>
          </div>
          <div className="settings-about-update-actions">
            {state.canRetry && (
              <button
                type="button"
                className="settings-spotify-btn"
                onClick={handleCheck}
              >
                Retry
              </button>
            )}
            <button
              type="button"
              className="settings-spotify-btn"
              onClick={() => handleOpenPage(state.lastReleasePageUrl)}
            >
              Open release page
            </button>
          </div>
        </div>
      )}

      {state.kind === 'manual-fallback' && (
        <div className="settings-about-update settings-about-update-error">
          <div className="settings-about-update-text">
            <strong>Auto-update couldn't finish</strong>
            <span className="settings-about-update-asset">{state.reason}</span>
          </div>
          <div className="settings-about-update-actions">
            <button
              type="button"
              className="settings-spotify-btn"
              onClick={() => handleOpenPage(state.releasePageUrl)}
            >
              Download manually
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function formatStateSummary(state: UpdateState): string {
  switch (state.kind) {
    case 'idle': return 'Idle';
    case 'checking': return 'Checking…';
    case 'up-to-date': return `Up to date · last checked ${formatRelative(state.checkedAt)}`;
    case 'available': return `v${state.version} available`;
    case 'downloading': return `Downloading v${state.version} (${state.progress.percent.toFixed(0)}%)`;
    case 'downloaded': return `v${state.version} ready to install`;
    case 'error': return 'Update check failed';
    case 'manual-fallback': return 'Auto-install failed — manual download required';
  }
}

function formatRelative(ts: number): string {
  const delta = Date.now() - ts;
  if (delta < 60_000) return 'just now';
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} min ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} hr ago`;
  return `${Math.floor(delta / 86_400_000)} days ago`;
}

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
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

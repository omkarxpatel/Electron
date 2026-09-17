import { useCallback, useState } from 'react';
import type {
  ResolvedSettings,
  SharedSettings,
  VisualProfile,
  WaveformStyle,
} from '../state/settings';
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

/** Everything from Style through Motion writes to ONE stage's profile. Without
 *  saying so, adjusting glow in fullscreen and seeing the banner unchanged
 *  reads as a bug rather than as the feature working. */
function StageNotice({ immersive, onReset }: { immersive: boolean; onReset: () => void }) {
  return (
    <div className="stage-notice">
      <span className="stage-notice-text">
        Editing <strong>{immersive ? 'fullscreen' : 'banner'}</strong> visuals
      </span>
      <button type="button" className="stage-notice-reset" onClick={onReset}>
        Reset
      </button>
    </div>
  );
}

const BAR_STYLES = new Set<WaveformStyle>(['bars', 'mirror', 'dots', 'spectrum']);

interface Props {
  open: boolean;
  onClose: () => void;
  /** Shared settings flattened with the ACTIVE stage's visual profile, so
   *  every control below reads the values for the stage you're looking at. */
  settings: ResolvedSettings;
  update: <K extends keyof SharedSettings>(key: K, value: SharedSettings[K]) => void;
  /** Writes to the active stage's profile — see useSettings.updateVisual. */
  updateVisual: <K extends keyof VisualProfile>(key: K, value: VisualProfile[K]) => void;
  /** Resets only the stage currently being edited. */
  resetActiveProfile: () => void;
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
  updateVisual,
  resetActiveProfile,
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
        <StageNotice immersive={settings.immersive} onReset={resetActiveProfile} />

        <Section title="Style" defaultOpen>
          <Segmented
            value={settings.waveformStyle}
            options={[
              { id: 'spectrum', label: 'Spectrum' },
              { id: 'ribbon', label: 'Ribbon' },
              { id: 'radial', label: 'Radial' },
              { id: 'mirror', label: 'Mirror' },
              { id: 'bars', label: 'Bars' },
              { id: 'line', label: 'Line' },
              { id: 'filled', label: 'Filled' },
              { id: 'particles', label: 'Particles' },
              { id: 'silk', label: 'Silk' },
              { id: 'lissajous', label: 'Scope' },
              { id: 'crystal', label: 'Bloom' },
              { id: 'ripples', label: 'Ripples' },
            ]}
            onChange={(v) => updateVisual('waveformStyle', v as VisualProfile['waveformStyle'])}
          />
        </Section>

        {settings.waveformStyle === 'particles' && (
          <Section title="Particles" defaultOpen>
            <Slider
              label="Density"
              value={settings.particleDensity}
              min={0.15}
              max={2}
              step={0.05}
              onChange={(v) => updateVisual('particleDensity', v)}
              format={(v) => `${Math.round(v * 100)}%`}
            />
            <Slider
              label="Size"
              value={settings.particleSize}
              min={0.3}
              max={2.5}
              step={0.05}
              onChange={(v) => updateVisual('particleSize', v)}
              format={(v) => `${Math.round(v * 100)}%`}
            />
          </Section>
        )}

        {(settings.waveformStyle === 'lissajous' || settings.waveformStyle === 'crystal') && (
          <Section title={settings.waveformStyle === 'crystal' ? 'Crystal' : 'Scope'} defaultOpen>
            {/* One stored value, two meanings — see scopeDensity in settings.ts. */}
            <Slider
              label={settings.waveformStyle === 'crystal' ? 'Resolution' : 'Density'}
              value={settings.scopeDensity}
              min={0.05}
              max={1}
              step={0.01}
              onChange={(v) => updateVisual('scopeDensity', v)}
              format={(v) => `${Math.round(v * 100)}%`}
            />
            {/* Immersive only, because the effect is: four corner glows have
                nowhere to go across a 110px strip, so the banner profile
                never draws them and a slider here would be inert. */}
            {settings.immersive && (
              <Slider
                label="Ambience"
                value={settings.scopeAmbience}
                min={0}
                max={2}
                step={0.05}
                onChange={(v) => updateVisual('scopeAmbience', v)}
                format={(v) => (v === 0 ? 'off' : `${Math.round(v * 100)}%`)}
              />
            )}
          </Section>
        )}

        {BAR_STYLES.has(settings.waveformStyle) && (
          <Section title="Bar shape" defaultOpen>
            <Slider
              label="Width"
              value={settings.barWidth}
              min={1}
              max={12}
              step={1}
              onChange={(v) => updateVisual('barWidth', v)}
              format={(v) => `${v.toFixed(0)} px`}
            />
            <Slider
              label="Gap"
              value={settings.barGap}
              min={0}
              max={6}
              step={1}
              onChange={(v) => updateVisual('barGap', v)}
              format={(v) => `${v.toFixed(0)} px`}
            />
          </Section>
        )}

        <Section title="Motion">
          <Slider
            label="Glow"
            value={settings.glow}
            min={0}
            max={1}
            step={0.01}
            onChange={(v) => updateVisual('glow', v)}
          />
          <Slider
            label="Motion trail"
            value={settings.trail}
            min={0}
            max={0.6}
            step={0.01}
            onChange={(v) => updateVisual('trail', v)}
          />
          <Slider
            label={settings.autoGain ? 'Sensitivity (trim)' : 'Sensitivity'}
            value={settings.sensitivity}
            min={0.5}
            max={10}
            step={0.05}
            onChange={(v) => updateVisual('sensitivity', v)}
            format={(v) => `${v.toFixed(2)}×`}
            trailing={
              <button
                type="button"
                className={`segmented-button ${settings.autoGain ? 'is-active' : ''}`}
                onClick={() => updateVisual('autoGain', !settings.autoGain)}
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
            onChange={(v) => updateVisual('smoothing', v)}
          />
          <ToggleRow
            title="Spatial spectrum"
            hint="Lows drive the left, highs drive the right"
            value={settings.spectralPosition}
            onToggle={() => updateVisual('spectralPosition', !settings.spectralPosition)}
            tooltip="Low frequencies drive the left side, highs drive the right — each part of the visual reacts to the audio at its position."
          />
        </Section>

        <Section title="Palette">
          <div className="palette-grid">
            {Object.values(PALETTES).map((p) => (
              <button
                key={p.id}
                className={`palette-swatch ${settings.palette === p.id ? 'is-active' : ''}`}
                onClick={() => update('palette', p.id as SharedSettings['palette'])}
                aria-label={p.label}
                style={{
                  background: `linear-gradient(135deg, ${(p.id === 'custom'
                    ? settings.customColors.map((c, i) => ({ color: c, pos: i / 2 }))
                    : p.stops
                  )
                    .map((s) => `${s.color} ${s.pos * 100}%`)
                    .join(', ')})`,
                }}
              >
                <span className="palette-label">{p.label}</span>
              </button>
            ))}
          </div>
          <ToggleRow
            title="Auto-tint from album art"
            hint="Overrides the palette above with colors from the current track"
            value={settings.autoTintFromAlbumArt}
            onToggle={() => update('autoTintFromAlbumArt', !settings.autoTintFromAlbumArt)}
            tooltip={"When on, colors are extracted from the currently-playing Spotify track's album art and override the palette above. When off, the palette above is used literally."}
          />
          {settings.palette === 'custom' && (
            <div className="custom-palette-row">
              {(['Low', 'Mid', 'High'] as const).map((label, i) => (
                <label className="custom-swatch" key={label}>
                  <input
                    type="color"
                    value={settings.customColors[i]}
                    onChange={(e) => {
                      const next = [...settings.customColors] as [string, string, string];
                      next[i] = e.target.value;
                      update('customColors', next);
                    }}
                  />
                  <span>{label}</span>
                </label>
              ))}
            </div>
          )}
        </Section>

        <Section title="Display">
          <ToggleRow
            title="Album art backdrop"
            hint="Blurred cover art behind the visualizer"
            value={settings.albumArtBackdrop}
            onToggle={() => update('albumArtBackdrop', !settings.albumArtBackdrop)}
            tooltip="Renders the current track's album art, blurred and dimmed, behind the visualizer stage."
          />
          <ToggleRow
            title="Lyrics pane"
            hint="Show synced lyrics in the Spotify column"
            value={settings.showLyrics}
            onToggle={() => update('showLyrics', !settings.showLyrics)}
            tooltip="Hide to reclaim the vertical space for the track list."
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

const SECTION_OPEN_KEY = 'av.settings.sectionsOpen';

function readOpenMap(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(SECTION_OPEN_KEY);
    return raw ? (JSON.parse(raw) as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}

/**
 * Collapsible settings group. Open/closed is persisted per title so the panel
 * reopens the way you left it — with a dozen visual controls plus Spotify and
 * About, an always-expanded panel is a scrolling exercise.
 *
 * `defaultOpen` only applies the first time a section is seen; after that the
 * stored value wins, including an explicit `false`.
 */
function Section({
  title,
  children,
  defaultOpen = false,
}: {
  title: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState<boolean>(() => readOpenMap()[title] ?? defaultOpen);

  const toggle = useCallback(() => {
    setOpen((prev) => {
      const next = !prev;
      // Merge on write — each Section owns one key and they all mount at once.
      try {
        localStorage.setItem(
          SECTION_OPEN_KEY,
          JSON.stringify({ ...readOpenMap(), [title]: next }),
        );
      } catch {
        // Storage unavailable — the toggle still works for this session.
      }
      return next;
    });
  }, [title]);

  return (
    <section className={`panel-section ${open ? 'is-open' : ''}`}>
      <button type="button" className="panel-section-header" onClick={toggle} aria-expanded={open}>
        <h3>{title}</h3>
        <svg className="panel-section-chevron" width="10" height="10" viewBox="0 0 10 10" aria-hidden>
          <path
            d="M2.5 4L5 6.5L7.5 4"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
          />
        </svg>
      </button>
      {/* grid-template-rows 0fr -> 1fr animates to auto height, which a plain
          max-height transition cannot do without a hardcoded guess. */}
      <div className="panel-section-body">
        <div className="panel-section-inner">{children}</div>
      </div>
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

/** Standalone on/off setting. Own layout rather than borrowing `.slider-row`,
 *  which is shaped for a range input and left toggles cramped against their
 *  label. Renders a <div>, not a <label> — a <label> wrapping a <button> is
 *  invalid and made the whole row a confusing double click target. */
function ToggleRow({
  title,
  hint,
  value,
  onToggle,
  tooltip,
}: {
  title: string;
  hint?: string;
  value: boolean;
  onToggle: () => void;
  tooltip?: string;
}) {
  return (
    <div className="setting-toggle-row">
      <span className="setting-toggle-label">
        <span className="setting-toggle-title">{title}</span>
        {hint && <span className="setting-toggle-hint">{hint}</span>}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={value}
        className={`segmented-button ${value ? 'is-active' : ''}`}
        onClick={onToggle}
        title={tooltip}
      >
        {value ? 'On' : 'Off'}
      </button>
    </div>
  );
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

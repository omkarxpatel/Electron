import { useCallback, useEffect, useState } from 'react';
import type {
  ResolvedSettings,
  SharedSettings,
  VisualProfile,
  WaveformStyle,
} from '../state/settings';
import { PALETTES } from '../visualizers/palettes';
import { TIER_KNOBS, TIER_LABELS, type UseQuality } from '../state/quality';
import type { QualityTier } from '../types/api';
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
/**
 * Quality tier picker.
 *
 * States what each tier actually does rather than labelling it "quality" and
 * leaving the user to guess — the tier moves render scale and the frame cap,
 * and both are legible as a sentence. It deliberately does not touch particle
 * density or scope ambience: those are literal user-facing multipliers, and a
 * tier that silently clamped them would make their labels a lie.
 */
function PerformanceSection({ quality }: { quality: UseQuality }) {
  const { state, tier, setTier } = quality;
  const knobs = TIER_KNOBS[tier];

  const effect =
    `${knobs.renderScale === 1 ? 'Full resolution' : `${Math.round(knobs.renderScale * 100)}% resolution`}` +
    ` · ${knobs.frameCapHz === null ? 'uncapped frame rate' : `${knobs.frameCapHz} fps cap`}`;

  const origin =
    state.kind !== 'ready'
      ? 'Detecting…'
      : state.profile.source === 'user'
        ? 'Set by you'
        : state.profile.source === 'measured'
          ? 'Measured on this Mac'
          : 'Detected automatically';

  const machine =
    state.kind === 'ready'
      ? [
          state.capability.cpuModel,
          `${state.capability.cpuCount} cores`,
          `${state.capability.primary.refreshHz} Hz`,
          state.capability.canvasAccelerated ? 'GPU accelerated' : 'software rendering',
        ].join(' · ')
      : null;

  return (
    <>
      <Segmented<QualityTier>
        value={tier}
        options={[
          { id: 'high', label: TIER_LABELS.high },
          { id: 'balanced', label: TIER_LABELS.balanced },
          { id: 'low', label: TIER_LABELS.low },
        ]}
        onChange={(t) => void setTier(t)}
      />
      <div className="setting-toggle-row">
        <span className="setting-toggle-label">
          <span className="setting-toggle-title">{effect}</span>
          <span className="setting-toggle-hint">
            {origin}
            {machine ? ` — ${machine}` : ''}
          </span>
        </span>
      </div>
    </>
  );
}

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
  /** The single useQuality() instance, shared with the visualizer. A second
   *  instance here would hold its own tier, so changing it would never reach
   *  the render path. */
  quality: UseQuality;
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
  quality,
  spotifyAuthed,
  onReconnectSpotify,
  onSignOutSpotify,
}: Props) {
  // Two-step confirm rather than a confirm() dialog, matching the playlist
  // delete in SpotifyTrackList: this wipes both stage profiles and there is
  // no undo, and it sits one stray click below the Spotify sign-out button.
  const [confirmingReset, setConfirmingReset] = useState(false);

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

        <Section title="Performance">
          <PerformanceSection quality={quality} />
        </Section>

        <Section title="Menu bar">
          <MenuBarSection />
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

        {confirmingReset ? (
          <div className="reset-confirm">
            <button
              className="reset-button reset-button-danger"
              onClick={() => {
                setConfirmingReset(false);
                reset();
              }}
            >
              Confirm
            </button>
            <button className="reset-button" onClick={() => setConfirmingReset(false)}>
              Cancel
            </button>
          </div>
        ) : (
          <button
            className="reset-button"
            onClick={() => setConfirmingReset(true)}
            title="Restores every visualizer setting — both the banner and fullscreen profiles — to their defaults. There is no undo."
          >
            Reset to defaults
          </button>
        )}
      </div>
    </aside>
  );
}

/**
 * Launch-at-login + hide-to-menu-bar controls.
 *
 * Unlike everything else in this panel, launch-at-login isn't app settings —
 * it's OS state (a macOS login item), owned by the main process. So it has
 * its own fetch on mount and subscribes to `onChange`, which fires when the
 * same option is toggled from the tray menu. Without that subscription the
 * two controls would silently disagree.
 */
function MenuBarSection() {
  const [atLogin, setAtLogin] = useState<boolean | null>(null);
  const [notchOn, setNotchOn] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    void window.api.loginItem
      .get()
      .then((value) => {
        if (!cancelled) setAtLogin(value);
      })
      .catch(() => {
        if (!cancelled) setAtLogin(false);
      });
    const off = window.api.loginItem.onChange((value) => setAtLogin(value));
    return () => {
      cancelled = true;
      off();
    };
  }, []);

  // Same story as launch-at-login: main owns it (it has to, the HUD is
  // created before any renderer exists) and the tray can change it too.
  useEffect(() => {
    let cancelled = false;
    void window.api.notch
      .getEnabled()
      .then((value) => {
        if (!cancelled) setNotchOn(value);
      })
      .catch(() => {
        if (!cancelled) setNotchOn(false);
      });
    const off = window.api.notch.onEnabledChange((value) => setNotchOn(value));
    return () => {
      cancelled = true;
      off();
    };
  }, []);

  const toggleNotch = useCallback((): void => {
    // Until `getEnabled` answers, the row renders "Off" whatever the truth is,
    // so a click here would act on a state we don't have yet — and toggling
    // the HUD off when the user meant to turn it on looks like the switch is
    // broken rather than racing.
    if (notchOn === null) return;
    const next = !notchOn;
    setNotchOn(next); // optimistic — creating the window takes a moment
    void window.api.notch
      .setEnabled(next)
      .then((actual) => setNotchOn(actual))
      .catch(() => setNotchOn(!next));
  }, [notchOn]);

  const toggle = useCallback((): void => {
    const next = !(atLogin ?? false);
    setAtLogin(next); // optimistic — the write is fast but not instant
    void window.api.loginItem
      .set(next)
      // Main re-reads the login item and returns the truth; if the OS
      // refused the write, snap back rather than showing a lie.
      .then((actual) => setAtLogin(actual))
      .catch(() => setAtLogin(!next));
  }, [atLogin]);

  return (
    <>
      <ToggleRow
        title="Notch HUD"
        hint="Music controls that hang from the notch. Hides the dock icon."
        value={notchOn ?? false}
        onToggle={toggleNotch}
        tooltip="Hover the notch for artwork, the current lyric, a scrubber and transport; click the panel to bring this window forward. While this is on the app runs from the menu bar only — macOS requires that for the HUD to appear over fullscreen apps — so there is no dock icon or Cmd+Tab entry. Turning it off restores both."
      />
      <ToggleRow
        title="Launch at login"
        hint="Start hidden in the menu bar when you log in"
        value={atLogin ?? false}
        onToggle={toggle}
        tooltip="Registers a macOS login item that launches the app with no window. Use the menu-bar icon to bring it up."
      />
      <div className="settings-spotify-row">
        <button
          type="button"
          className="settings-spotify-btn"
          onClick={() => void window.api.window.hide()}
          title="Hide the window and the dock icon. The app keeps running — audio, EQ and Spotify polling all continue."
        >
          Hide to menu bar
        </button>
      </div>
    </>
  );
}

/** Both feedback buttons land here. There is no backend to receive a report,
 *  so they open a pre-filled GitHub issue in the user's browser instead —
 *  same repo `build.publish` in package.json already points at. */
const ISSUES_URL = 'https://github.com/omkarxpatel/Electron/issues/new';

/**
 * Pre-fills the environment line, because it is the thing every bug report
 * gets asked for afterwards and the thing a user is least able to answer.
 * All three values are synchronous renderer state — no IPC round-trip, so
 * the browser opens on the click rather than a tick later.
 */
/** Never let the rejection vanish. Main REFUSES urls outside its allowlist by
 *  throwing, and these callers used to `void` the promise — so when the
 *  allowlist and the URL disagreed, the buttons did nothing and said nothing.
 *  A console error is not much, but it is the difference between a five
 *  minute fix and a mystery. */
function openIssueOrWarn(kind: 'bug' | 'feedback'): void {
  openIssue(kind).catch((err) => {
    console.error(`[settings] could not open the ${kind} issue page`, err);
  });
}

function openIssue(kind: 'bug' | 'feedback'): Promise<void> {
  const env = [
    `App ${window.api.app.version} (${window.api.app.arch})`,
    `Electron ${window.api.electronVersion}`,
    window.api.platform,
  ].join(' · ');

  const body =
    kind === 'bug'
      ? `**What happened?**\n\n\n**What did you expect instead?**\n\n\n**Steps to reproduce**\n1. \n2. \n\n---\n${env}\n`
      : `**What would you like to see?**\n\n\n**Why would it help?**\n\n\n---\n${env}\n`;

  const params = new URLSearchParams({
    title: kind === 'bug' ? '[Bug] ' : '[Feedback] ',
    labels: kind === 'bug' ? 'bug' : 'enhancement',
    body,
  });
  return window.api.shell.openExternal(`${ISSUES_URL}?${params.toString()}`);
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

      <div className="settings-about-action">
        <button
          type="button"
          className="settings-spotify-btn"
          onClick={() => openIssueOrWarn('bug')}
          title="Opens a pre-filled GitHub issue in your browser, with your app version and architecture already filled in."
        >
          Report a bug
        </button>
        <button
          type="button"
          className="settings-spotify-btn"
          onClick={() => openIssueOrWarn('feedback')}
          title="Opens a pre-filled GitHub issue in your browser to suggest an idea or improvement."
        >
          Send feedback
        </button>
      </div>

      {state.kind === 'available' && (
        <div className="settings-about-update">
          <div className="settings-about-update-text">
            <strong>v{state.version} is available</strong>
            <span className="settings-about-update-asset">
              Download it to install on your next quit, or skip this version.
            </span>
          </div>
          <div className="settings-about-update-actions">
            <button
              type="button"
              className="settings-spotify-btn"
              onClick={handleDownload}
            >
              Download
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
              Restart now, or it installs on your next quit. Settings and Spotify
              auth are preserved.
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
    case 'skipped': return `v${state.version} available · you skipped it`;
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

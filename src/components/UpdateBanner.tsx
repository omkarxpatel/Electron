import { memo, useCallback } from 'react';
import {
  dismissVersion,
  downloadUpdate,
  installUpdate,
  openReleasePage,
  useUpdateState,
} from '../lib/updateService';
import type { UpdateState } from '../types/api';

/**
 * Compact strip at the very top of the app surfacing update state. Driven
 * entirely by the singleton store in lib/updateService — main owns the
 * actual update machinery, we render whatever state arrives.
 *
 * Six visible states (the seventh, `idle`, and `up-to-date` render nothing):
 *
 *   checking        — spinner-ish indicator, no actions
 *   available       — version + Download + Skip / Open page
 *   downloading     — progress bar + speed + percent + cancel-ish (open page)
 *   downloaded      — call to action: Restart to install / Open page / Skip
 *   error           — categorized message + Retry (if retryable) / Open page
 *   manual-fallback — install failed, only path is manual download
 *
 * The banner always exposes a "Skip" or "Dismiss" action when a version is
 * known, so a user who doesn't want to update can clear the banner without
 * downloading. Dismissals are per-version (main remembers); the banner
 * resurfaces only when a NEWER version drops.
 */
export const UpdateBanner = memo(UpdateBannerImpl);

function UpdateBannerImpl() {
  const state = useUpdateState();

  // Idle + up-to-date render nothing — banner is for *actionable* states.
  if (state.kind === 'idle' || state.kind === 'up-to-date') return null;

  return (
    <div className="update-banner" data-state={state.kind} role="status">
      <BannerContent state={state} />
    </div>
  );
}

function BannerContent({ state }: { state: UpdateState }) {
  // Stable callbacks per render — these are tiny so memoization wouldn't
  // pay off; the parent banner re-renders on each state push anyway.
  const handleDownload = useCallback(() => void downloadUpdate(), []);
  const handleInstall = useCallback(() => void installUpdate(), []);
  const handleOpenPage = useCallback(
    (url?: string) => void openReleasePage(url),
    [],
  );
  const handleSkip = useCallback(
    (version: string) => void dismissVersion(version),
    [],
  );

  switch (state.kind) {
    case 'checking':
      return (
        <>
          <div className="update-banner-text">
            <strong>Checking for updates…</strong>
          </div>
        </>
      );

    case 'available':
      return (
        <>
          <div className="update-banner-text">
            <strong>Update available — v{state.version}</strong>
            <span className="update-banner-sub">
              Downloading in the background.
            </span>
          </div>
          <div className="update-banner-actions">
            <button
              type="button"
              className="update-banner-primary"
              onClick={handleDownload}
              title="Start the download now (it begins automatically anyway)"
            >
              Download now
            </button>
            <button
              type="button"
              className="update-banner-link"
              onClick={() => handleOpenPage(state.releasePageUrl)}
              title="Open the release page in your browser"
            >
              View
            </button>
            <button
              type="button"
              className="update-banner-dismiss"
              onClick={() => handleSkip(state.version)}
              aria-label={`Skip v${state.version}`}
              title="Skip this version (banner returns when a newer one drops)"
            >
              ×
            </button>
          </div>
        </>
      );

    case 'downloading': {
      const pct = Math.max(0, Math.min(100, state.progress.percent));
      return (
        <>
          <div className="update-banner-text">
            <strong>Downloading v{state.version}</strong>
            <span className="update-banner-sub">
              {pct.toFixed(0)}% · {formatRate(state.progress.bytesPerSecond)} ·{' '}
              {formatBytes(state.progress.transferred)} / {formatBytes(state.progress.total)}
            </span>
            <div className="update-banner-progress" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
              <div className="update-banner-progress-fill" style={{ width: `${pct}%` }} />
            </div>
          </div>
          <div className="update-banner-actions">
            <button
              type="button"
              className="update-banner-link"
              onClick={() => handleOpenPage(state.releasePageUrl)}
            >
              View
            </button>
          </div>
        </>
      );
    }

    case 'downloaded':
      return (
        <>
          <div className="update-banner-text">
            <strong>v{state.version} ready to install</strong>
            <span className="update-banner-sub">
              Restart the app to finish updating. Spotify auth and settings are preserved.
            </span>
          </div>
          <div className="update-banner-actions">
            <button
              type="button"
              className="update-banner-primary"
              onClick={handleInstall}
            >
              Restart now
            </button>
            <button
              type="button"
              className="update-banner-link"
              onClick={() => handleOpenPage(state.releasePageUrl)}
            >
              View
            </button>
            <button
              type="button"
              className="update-banner-dismiss"
              onClick={() => handleSkip(state.version)}
              aria-label={`Skip v${state.version}`}
              title="Skip — restart will not include this update until you opt back in"
            >
              ×
            </button>
          </div>
        </>
      );

    case 'error': {
      const friendly = explainError(state.category, state.message);
      return (
        <>
          <div className="update-banner-text">
            <strong>{friendly.headline}</strong>
            <span className="update-banner-sub">{friendly.detail}</span>
          </div>
          <div className="update-banner-actions">
            {state.canRetry && (
              <button
                type="button"
                className="update-banner-primary"
                onClick={() => void window.api.update.check()}
              >
                Retry
              </button>
            )}
            <button
              type="button"
              className="update-banner-link"
              onClick={() => handleOpenPage(state.lastReleasePageUrl)}
            >
              Open release page
            </button>
          </div>
        </>
      );
    }

    case 'manual-fallback':
      return (
        <>
          <div className="update-banner-text">
            <strong>Auto-update couldn't finish</strong>
            <span className="update-banner-sub">{state.reason}</span>
          </div>
          <div className="update-banner-actions">
            <button
              type="button"
              className="update-banner-primary"
              onClick={() => handleOpenPage(state.releasePageUrl)}
            >
              Download manually
            </button>
          </div>
        </>
      );

    default:
      return null;
  }
}

// ── Formatting helpers ────────────────────────────────────────────────────

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

function formatRate(bytesPerSecond: number): string {
  return `${formatBytes(bytesPerSecond)}/s`;
}

function explainError(
  category: 'network' | 'install' | 'unknown',
  raw: string,
): { headline: string; detail: string } {
  if (category === 'network') {
    return {
      headline: "Couldn't reach the update server",
      detail: 'Check your internet connection. Retry once you\'re back online.',
    };
  }
  if (category === 'install') {
    return {
      headline: 'Auto-install failed',
      detail:
        'The downloaded update couldn\'t be applied (commonly a macOS signature/quarantine check). Download manually from the release page.',
    };
  }
  return {
    headline: 'Update check failed',
    detail: raw.length > 120 ? `${raw.slice(0, 120)}…` : raw,
  };
}

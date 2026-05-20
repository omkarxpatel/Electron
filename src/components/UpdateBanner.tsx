import { memo, useEffect, useState } from 'react';
import { checkForUpdate, dismissUpdate, type UpdateInfo } from '../lib/updateChecker';

/**
 * Compact "update available" strip that mounts at the very top of the app
 * above the ChromeBar. Hidden until the GitHub check returns a newer release;
 * fully dismissible per-version.
 *
 * The banner deliberately doesn't auto-download anything — it just opens the
 * release page (or direct DMG link) in the user's browser. macOS unsigned-
 * app constraints rule out silent auto-update; see updateChecker.ts.
 *
 * Two checks per session:
 *   - 5s after mount (let the app settle before doing a network call)
 *   - whenever the window regains focus (catches the case where the user
 *     came back from a long sleep and a new release dropped overnight)
 * The 24-hour TTL in updateChecker prevents either from spamming the API.
 */
export const UpdateBanner = memo(UpdateBannerImpl);

function UpdateBannerImpl() {
  const [info, setInfo] = useState<UpdateInfo | null>(null);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      const result = await checkForUpdate();
      if (cancelled) return;
      if (result) setInfo(result);
    };
    // Defer the initial check so the app paints first.
    const t = window.setTimeout(run, 5000);
    const onFocus = () => void run();
    window.addEventListener('focus', onFocus);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
      window.removeEventListener('focus', onFocus);
    };
  }, []);

  if (!info) return null;

  const handleDownload = (): void => {
    const url = info.assetUrl ?? info.releasePageUrl;
    void window.api.shell.openExternal(url).catch((err) => {
      // Allowlist mismatch shows here — surface to console so we can fix
      // the regex in electron/main.ts without the user being blocked.
      console.error('UpdateBanner: shell.openExternal refused', url, err);
    });
  };

  const handleDismiss = (): void => {
    dismissUpdate(info.latestVersion);
    setInfo(null);
  };

  return (
    <div className="update-banner" role="status">
      <div className="update-banner-text">
        <strong>Update available — v{info.latestVersion}</strong>
        <span className="update-banner-sub">
          You're on v{info.currentVersion}.{' '}
          {info.assetName ? `Download ${info.assetName} from GitHub.` : 'Open the release page.'}
        </span>
      </div>
      <div className="update-banner-actions">
        <button type="button" className="update-banner-primary" onClick={handleDownload}>
          Download
        </button>
        <button
          type="button"
          className="update-banner-dismiss"
          onClick={handleDismiss}
          aria-label={`Dismiss v${info.latestVersion} update notice`}
          title="Don't show again for this version"
        >
          ×
        </button>
      </div>
    </div>
  );
}

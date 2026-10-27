import { Component, type ErrorInfo, type ReactNode } from 'react';

interface State {
  hasError: boolean;
  message: string | null;
}

/**
 * Root error boundary. Catches render-phase exceptions anywhere in the tree
 * and shows a recovery panel instead of leaving the user staring at a white
 * window. Errors are logged to the renderer console; in production they'd
 * also go to a crash reporter (Phase 3).
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { hasError: false, message: null };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, message: error.message };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Root error boundary caught:', error, info);
  }

  render(): ReactNode {
    if (!this.state.hasError) return this.props.children;
    return (
      <div
        style={{
          position: 'fixed',
          inset: 0,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 40,
          background: '#0a0a0a',
          color: '#e8e8e8',
          fontFamily: '-apple-system, system-ui, sans-serif',
          textAlign: 'center',
        }}
      >
        <h2 style={{ marginBottom: 12 }}>Something broke.</h2>
        <p style={{ color: 'rgba(255,255,255,0.55)', fontSize: 13, marginBottom: 20, maxWidth: 480 }}>
          {this.state.message ?? 'An unexpected error occurred.'}
        </p>
        <div style={{ display: 'flex', gap: 10 }}>
          <button
            type="button"
            onClick={() => location.reload()}
            style={{
              padding: '10px 18px',
              background: '#1DB954',
              border: 'none',
              borderRadius: 8,
              color: '#0a0a0a',
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            Reload
          </button>
          <button
            type="button"
            onClick={resetVisualSettings}
            style={{
              padding: '10px 18px',
              background: 'transparent',
              border: '1px solid rgba(255,255,255,0.25)',
              borderRadius: 8,
              color: '#e8e8e8',
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            Reset appearance &amp; reload
          </button>
        </div>
        <p style={{ color: 'rgba(255,255,255,0.35)', fontSize: 11, marginTop: 14, maxWidth: 420 }}>
          Reset clears saved appearance settings only. Your EQ curves, Spotify sign-in and
          track memory are left alone.
        </p>
      </div>
    );
  }
}

/**
 * The escape hatch from a boot loop.
 *
 * Reload alone is not a recovery when the thing that threw is a stored value:
 * it re-reads the same storage and throws again, and the only remaining way
 * out of the app is to stop using it. An unknown palette id used to do
 * exactly that — `PALETTES[id]` came back undefined and threw on first
 * render, above every SectionBoundary, so this panel was all that was left.
 *
 * `load()` validates that id now, so this is the second line of defence
 * rather than the first. It stays because the next unvalidated stored value
 * will land here too, and because a user in a loop needs a button, not a
 * release.
 *
 * Deliberately narrow: appearance keys only. Clearing everything would take
 * the Spotify refresh token with it, so recovering from a bad gradient would
 * cost a re-authentication — and this runs at the exact moment someone is
 * least able to judge the trade.
 */
function resetVisualSettings(): void {
  // Both keys state/settings.ts reads: the current one and the legacy blob
  // it migrates from. Clearing only the current one would let load() fall
  // straight back to the legacy value and re-throw.
  for (const key of ['av.settings.v3', 'av.settings.v2']) {
    try {
      localStorage.removeItem(key);
    } catch {
      // Private mode or a disk error. Nothing useful to do here — the reload
      // below is still worth attempting.
    }
  }
  location.reload();
}

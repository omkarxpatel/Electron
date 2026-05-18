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
      </div>
    );
  }
}

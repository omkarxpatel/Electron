import { Component, Fragment, type ErrorInfo, type ReactNode } from 'react';

/**
 * A boundary around one pane, not the whole window.
 *
 * The root ErrorBoundary catches everything, which is exactly the problem:
 * one bad field anywhere took the entire app down with it. That is not
 * hypothetical — commit 87cb42b exists because a playlist arriving without
 * `tracks` threw during render and blanked the window, visualizer, EQ and
 * player bar along with the track list that actually broke.
 *
 * Wrapping each pane means a failure costs you that pane. The music keeps
 * playing, the EQ keeps working, and the recovery is scoped: `Try again`
 * remounts just this subtree instead of reloading the renderer and throwing
 * away audio graph, Spotify poll state and scroll position.
 */

interface Props {
  /** Shown in the fallback, e.g. "track list". Lower-case; it's mid-sentence. */
  label: string;
  children: ReactNode;
}

interface State {
  hasError: boolean;
  message: string | null;
  /** Bumped on retry to force a fresh subtree rather than re-rendering the
   *  same instances that just threw. */
  attempt: number;
}

export class SectionBoundary extends Component<Props, State> {
  state: State = { hasError: false, message: null, attempt: 0 };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, message: error.message };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Named so a console report says which pane died; the root boundary's
    // message alone never did.
    console.error(`SectionBoundary(${this.props.label}) caught:`, error, info);
  }

  private retry = (): void => {
    this.setState((s) => ({ hasError: false, message: null, attempt: s.attempt + 1 }));
  };

  render(): ReactNode {
    if (!this.state.hasError) {
      // A keyed Fragment, not a wrapper div: several of these sit directly
      // inside flex and grid parents, and an extra element would collapse
      // those layouts. The key still forces a fresh subtree on retry.
      return <Fragment key={this.state.attempt}>{this.props.children}</Fragment>;
    }
    return (
      <div className="section-boundary-failed" role="alert">
        <div className="section-boundary-title">The {this.props.label} stopped working.</div>
        {this.state.message ? (
          <div className="section-boundary-message">{this.state.message}</div>
        ) : null}
        <button type="button" className="section-boundary-retry" onClick={this.retry}>
          Try again
        </button>
      </div>
    );
  }
}

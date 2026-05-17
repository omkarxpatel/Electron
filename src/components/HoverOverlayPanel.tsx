import { memo, useEffect, type ReactNode } from 'react';
import { useRenderCount } from '../perf';

interface Props {
  /** Heading rendered at the top of the panel. */
  title: string;
  /** Panel body. Should manage its own scroll. */
  children: ReactNode;
  /** Whether the panel is currently open. Controlled by the parent so any
   *  element (an icon button, a hotkey, etc.) can drive it. */
  open: boolean;
  /** Fired when the cursor enters the panel — typically cancels a pending
   *  close timer so moving the mouse onto the panel keeps it open. */
  onMouseEnter: () => void;
  /** Fired when the cursor leaves the panel — typically schedules a close
   *  with a small grace period. */
  onMouseLeave: () => void;
  /** Fired when the user clicks the explicit close button or presses Esc. */
  onClose: () => void;
}

export const HoverOverlayPanel = memo(HoverOverlayPanelImpl);

function HoverOverlayPanelImpl({
  title,
  children,
  open,
  onMouseEnter,
  onMouseLeave,
  onClose,
}: Props) {
  useRenderCount('HoverOverlayPanel');
  // Esc closes the panel when it's open.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  return (
    <aside
      className="hover-overlay-panel"
      data-open={open ? 'true' : 'false'}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      aria-hidden={!open}
    >
      <header className="hover-overlay-header">
        <h2 className="hover-overlay-title">{title}</h2>
        <button
          type="button"
          className="hover-overlay-close"
          onClick={onClose}
          aria-label="Close panel"
          title="Close (Esc)"
        >
          ×
        </button>
      </header>
      <div className="hover-overlay-body">{children}</div>
    </aside>
  );
}

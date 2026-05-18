import { useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/**
 * A lightweight portal-rendered context menu. Positioned at viewport
 * coordinates so it isn't clipped by overflow:auto ancestors (the track
 * list scroll container in particular).
 *
 * Dismiss behaviors:
 *  - Click outside the menu
 *  - Escape key
 *  - Window scroll/resize (menu would otherwise hang in stale position)
 *  - Right-click outside (mousedown captures both buttons)
 */

export interface ContextMenuItem {
  label: string;
  onClick: () => void;
  /** When true, the item is rendered but disabled (greyed out). */
  disabled?: boolean;
}

interface Props {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}

export function ContextMenu({ x, y, items, onClose }: Props): ReactNode {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    const onMouseDown = (e: MouseEvent) => {
      // If the click landed inside the menu, our item onClick handler will
      // run and call onClose itself; this catches everything outside.
      const target = e.target as HTMLElement | null;
      if (target && target.closest('[data-context-menu="true"]')) return;
      onClose();
    };
    const onScroll = () => onClose();
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onMouseDown, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onMouseDown, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
    };
  }, [onClose]);

  // Clamp position so the menu doesn't overflow the viewport. Width/height
  // are approximate — close enough that an item never sticks off the edge.
  const approxW = 180;
  const approxH = items.length * 30 + 8;
  const left = Math.min(x, window.innerWidth - approxW - 8);
  const top = Math.min(y, window.innerHeight - approxH - 8);

  return createPortal(
    <div
      className="context-menu"
      data-context-menu="true"
      style={{ left, top }}
      role="menu"
    >
      {items.map((item, i) => (
        <button
          key={i}
          type="button"
          className="context-menu-item"
          role="menuitem"
          disabled={item.disabled}
          onClick={() => {
            if (item.disabled) return;
            item.onClick();
            onClose();
          }}
        >
          {item.label}
        </button>
      ))}
    </div>,
    document.body,
  );
}

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
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
  onClick?: () => void;
  /** When true, the item is rendered but disabled (greyed out). */
  disabled?: boolean;
  /** Native tooltip — the place to say why a `disabled` item is disabled. */
  title?: string;
  /** Draws a hairline rule above this item. */
  separator?: boolean;
  /**
   * Children shown in a panel beside this item, opened on hover. One level
   * only — a submenu item's own `submenu` is ignored. A parent item runs no
   * `onClick` of its own; clicking it just holds its panel open.
   */
  submenu?: ContextMenuSubmenu;
}

export interface ContextMenuSubmenu {
  items: ContextMenuItem[];
  /** Adds a filter box above the list. Omit for short, fixed lists. */
  filterPlaceholder?: string;
  /** Shown when there are no items, or none survive the filter. */
  emptyLabel?: string;
}

interface Props {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
  /**
   * The element the menu was opened from, if there is one.
   *
   * Only used to decide whether a scroll should dismiss the menu: a scroll
   * that cannot move this element cannot strand the menu, so it is ignored.
   * Omit it and any outside scroll dismisses, which is the older behaviour.
   */
  anchor?: HTMLElement | null;
}

// Used to keep the menu inside the viewport before it has been laid out, so
// these are estimates rather than measurements — keep them in step with the
// .context-menu rules in App.css or the clamping drifts.
const MENU_W = 208;
const ITEM_H = 32;
const SEPARATOR_H = 9;
const SUBMENU_W = 236;
const SUBMENU_MAX_H = 312;
const EDGE_PAD = 8;
/** Grace period before a submenu closes on hover-out. The path from a parent
 *  row to its panel crosses whatever row sits below, and closing on that
 *  first crossing makes the submenu impossible to reach diagonally. */
const SUBMENU_CLOSE_GRACE_MS = 160;

export function ContextMenu({ x, y, items, onClose, anchor }: Props): ReactNode {
  /** Index of the item whose submenu is open, or null. */
  const [openSub, setOpenSub] = useState<number | null>(null);
  const closeSubTimerRef = useRef<number | null>(null);
  // In a ref so a re-rendered anchor doesn't tear down and rebuild the
  // window listeners below on every parent render.
  const anchorRef = useRef<HTMLElement | null>(anchor ?? null);
  anchorRef.current = anchor ?? null;

  const cancelSubClose = useCallback((): void => {
    if (closeSubTimerRef.current !== null) {
      window.clearTimeout(closeSubTimerRef.current);
      closeSubTimerRef.current = null;
    }
  }, []);
  const openSubmenu = useCallback(
    (index: number): void => {
      cancelSubClose();
      setOpenSub(index);
    },
    [cancelSubClose],
  );
  const requestSubClose = useCallback((): void => {
    cancelSubClose();
    closeSubTimerRef.current = window.setTimeout(() => {
      setOpenSub(null);
      closeSubTimerRef.current = null;
    }, SUBMENU_CLOSE_GRACE_MS);
  }, [cancelSubClose]);
  useEffect(() => () => cancelSubClose(), [cancelSubClose]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    const insideMenu = (target: EventTarget | null): boolean => {
      const el = target as HTMLElement | null;
      return !!el?.closest?.('[data-context-menu="true"]');
    };
    const onMouseDown = (e: MouseEvent) => {
      // If the click landed inside the menu, our item onClick handler will
      // run and call onClose itself; this catches everything outside.
      if (insideMenu(e.target)) return;
      onClose();
    };
    // Capture-phase, so this sees scrolls from any element — including the
    // submenu's own scrolling list. Scrolling to find a playlist would
    // otherwise dismiss the menu the moment the wheel moved.
    const onScroll = (e: Event) => {
      if (insideMenu(e.target)) return;
      // A scroll only strands the menu if it moved what the menu is pinned
      // to. Closing on every scroll anywhere looked fine until something on
      // screen scrolled itself: the synced lyrics pane auto-scrolls to follow
      // the song, which dismissed this menu ~60ms after it opened. That made
      // the player-bar menu impossible to use and had been quietly closing
      // track-row menus mid-song too.
      const target = e.target as Node | null;
      const pinned = anchorRef.current;
      if (pinned && target && !target.contains(pinned)) return;
      onClose();
    };
    const onResize = () => onClose();
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onMouseDown, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onMouseDown, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    };
  }, [onClose]);

  // Clamp position so the menu doesn't overflow the viewport.
  const approxH =
    items.length * ITEM_H + items.filter((it) => it.separator).length * SEPARATOR_H + 8;
  const left = Math.max(EDGE_PAD, Math.min(x, window.innerWidth - MENU_W - EDGE_PAD));
  const top = Math.max(EDGE_PAD, Math.min(y, window.innerHeight - approxH - EDGE_PAD));

  // Open submenus to the left when there isn't room on the right.
  const flipX = left + MENU_W + SUBMENU_W + EDGE_PAD > window.innerWidth;

  /** Viewport y of a row, used to decide whether its submenu opens downward
   *  from the row or upward from its bottom edge. */
  const rowTop = (index: number): number => {
    let offset = 4;
    for (let i = 0; i < index; i++) {
      offset += ITEM_H + (items[i].separator ? SEPARATOR_H : 0);
    }
    return offset + (items[index].separator ? SEPARATOR_H : 0);
  };

  return createPortal(
    <div
      className="context-menu"
      data-context-menu="true"
      style={{ left, top, width: MENU_W }}
      role="menu"
    >
      {items.map((item, i) => {
        const hasSub = !!item.submenu;
        const subOpen = hasSub && openSub === i;
        return (
          <div
            className="context-menu-row"
            key={i}
            onMouseEnter={() => (hasSub ? openSubmenu(i) : requestSubClose())}
          >
            {item.separator && <div className="context-menu-separator" role="separator" />}
            <button
              type="button"
              className="context-menu-item"
              role="menuitem"
              disabled={item.disabled}
              title={item.title}
              aria-haspopup={hasSub || undefined}
              aria-expanded={hasSub ? subOpen : undefined}
              data-submenu-open={subOpen ? 'true' : undefined}
              onClick={() => {
                if (item.disabled) return;
                // A parent row has nothing to run — it's already open from the
                // hover, and closing the menu here would dismiss the panel the
                // user was reaching for.
                if (hasSub) {
                  openSubmenu(i);
                  return;
                }
                item.onClick?.();
                onClose();
              }}
            >
              <span className="context-menu-label">{item.label}</span>
              {hasSub && <span className="context-menu-caret" aria-hidden>›</span>}
            </button>
            {subOpen && item.submenu && (
              <Submenu
                submenu={item.submenu}
                flipX={flipX}
                // Flip upward when a full-height panel wouldn't fit below.
                flipY={top + rowTop(i) + SUBMENU_MAX_H + EDGE_PAD > window.innerHeight}
                onClose={onClose}
              />
            )}
          </div>
        );
      })}
    </div>,
    document.body,
  );
}

interface SubmenuProps {
  submenu: ContextMenuSubmenu;
  flipX: boolean;
  flipY: boolean;
  onClose: () => void;
}

function Submenu({ submenu, flipX, flipY, onClose }: SubmenuProps) {
  const { items, filterPlaceholder, emptyLabel } = submenu;
  const [query, setQuery] = useState('');

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter((it) => it.label.toLowerCase().includes(q));
  }, [items, query]);

  // Focus on mount so the user can type straight into the filter without
  // aiming at it — the submenu opens under the cursor, not under the caret.
  const focusOnMount = useCallback((el: HTMLInputElement | null) => {
    el?.focus();
  }, []);

  return (
    <div
      className="context-submenu"
      data-flip-x={flipX ? 'true' : 'false'}
      data-flip-y={flipY ? 'true' : 'false'}
      style={{ width: SUBMENU_W, maxHeight: SUBMENU_MAX_H }}
      role="menu"
    >
      {filterPlaceholder && (
        <input
          ref={focusOnMount}
          className="context-submenu-filter"
          type="text"
          placeholder={filterPlaceholder}
          value={query}
          spellCheck={false}
          onChange={(e) => setQuery(e.target.value)}
        />
      )}
      <div className="context-submenu-list">
        {shown.length === 0 ? (
          <div className="context-submenu-empty">{emptyLabel ?? 'Nothing here'}</div>
        ) : (
          shown.map((item, i) => (
            <button
              key={i}
              type="button"
              className="context-menu-item"
              role="menuitem"
              disabled={item.disabled}
              title={item.title}
              onClick={() => {
                if (item.disabled) return;
                item.onClick?.();
                onClose();
              }}
            >
              <span className="context-menu-label">{item.label}</span>
            </button>
          ))
        )}
      </div>
    </div>
  );
}

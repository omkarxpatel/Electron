import { useEffect, type RefObject } from 'react';

/**
 * Closes an anchored popover when the pointer goes down anywhere outside it.
 *
 * Without this, a dropdown's own trigger is the only thing that can close it,
 * so opening a second one leaves the first stacked underneath — which is what
 * the two topbar device menus did to each other.
 *
 * `ref` must wrap the trigger as well as the panel. Point it at the panel
 * alone and the trigger becomes an outside press: mousedown closes the menu,
 * the click that follows re-opens it, and the button can never shut it.
 *
 * Capture phase, as in ContextMenu — a handler that stops propagation on the
 * way up would otherwise leave the menu stranded.
 */
export function useDismissOnOutside(
  ref: RefObject<HTMLElement | null>,
  open: boolean,
  onDismiss: () => void,
): void {
  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent): void => {
      const el = ref.current;
      if (el && e.target instanceof Node && el.contains(e.target)) return;
      onDismiss();
    };
    window.addEventListener('mousedown', onMouseDown, true);
    return () => window.removeEventListener('mousedown', onMouseDown, true);
  }, [ref, open, onDismiss]);
}

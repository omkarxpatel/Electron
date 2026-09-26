/**
 * Requests to open one of the overlay's drill-in views from outside it.
 *
 * The player bar and the section that owns the overlay are siblings under
 * App, which otherwise threads no Spotify props — the two contexts in
 * SpotifyProvider exist precisely so it doesn't have to. Rather than lift
 * this state into App just so it can hand it back down, the request travels
 * as a window event, the same way `QUEUE_CHANGED_EVENT` in api.ts already
 * tells an open queue panel to refetch.
 */

export type OverlayTarget =
  | { kind: 'album'; albumId: string }
  | { kind: 'artist'; artistId: string };

const OVERLAY_NAV_EVENT = 'av:overlay-nav';

export function requestOverlayNav(target: OverlayTarget): void {
  window.dispatchEvent(new CustomEvent<OverlayTarget>(OVERLAY_NAV_EVENT, { detail: target }));
}

/** Returns an unsubscribe function. */
export function onOverlayNav(handler: (target: OverlayTarget) => void): () => void {
  const wrapped = (e: Event): void => handler((e as CustomEvent<OverlayTarget>).detail);
  window.addEventListener(OVERLAY_NAV_EVENT, wrapped);
  return () => window.removeEventListener(OVERLAY_NAV_EVENT, wrapped);
}

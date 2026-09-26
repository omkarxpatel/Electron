/**
 * Revision of the draw path's *cost characteristics*.
 *
 * **Bump this whenever a change makes the visualizers meaningfully faster or
 * slower.** It is what invalidates a stored performance profile: measurements
 * taken against older draw code describe code that no longer exists, and a
 * stale profile is invisible — the app just keeps using a tier the machine
 * outgrew, forever.
 *
 * Not a version number for the visuals. Appearance changes that don't move the
 * frame rate don't need a bump; a batching or blur change does.
 *
 * History:
 *   1 — pre-2026-09-25 baseline.
 *   2 — bars/mirror/spectrum/radial batched into one fill per frame. The
 *       shadow is charged per draw call, so this took them from 17-24 fps to
 *       120 on an M5 at 1512x822. Any profile measured at revision 1 describes
 *       a draw path that was 5-7x slower.
 */
export const DRAW_REVISION = 2;

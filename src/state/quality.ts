/**
 * Quality tier state — the renderer half of electron/deviceProfile.ts.
 *
 * Owns: asking main for the machine's profile, exposing the active tier, and
 * translating that tier into the knobs the render path actually reads.
 *
 * See ADAPTIVE_QUALITY_PLAN.md.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { DRAW_REVISION } from '../visualizers/drawRevision';
import type {
  Capability,
  DeviceProfile,
  QualityTier,
  ResolvedDeviceProfile,
  TestPrompt,
} from '../types/api';

// ── Tier knobs ─────────────────────────────────────────────────────────────

export interface QualityKnobs {
  /** Multiplier on devicePixelRatio for the visualizer backing store. */
  renderScale: number;
  /** Upper bound on visual frames per second. `null` follows the display.
   *  On a 120 Hz panel a 60 Hz cap halves the GPU work for something almost
   *  nobody can see on an audio visualizer — the best saving-to-risk ratio
   *  in this table. */
  frameCapHz: number | null;
}

/**
 * Two knobs, both measured, neither user-facing.
 *
 * Render scale is the lever for pixel-bound styles: radial ran 63.3 fps at 1x
 * against 15.1 at 2x. It does almost nothing for draw-bound styles (bars moved
 * 23.0 to 21.3), which is why it is not the only knob.
 *
 * An echo-count knob was drafted and dropped: Scope and Crystal hold 510-622
 * fps even under software rasterisation, so throttling them would be
 * speculative work against a cost that was never there.
 *
 * Deliberately contains nothing the user can set themselves.
 *
 * Particle density and scope ambience are literal user-facing multipliers, and
 * a tier that quietly clamped them would make the label a lie — the same rule
 * that keeps protective limiters out of the audio path. Render scale, the
 * frame cap and the echo history have no control surface, so a tier can move
 * them without contradicting anything the user was told.
 *
 * Whether a tier may clamp a user value *at all* is still open (see the plan's
 * open decision #2). Until that's settled, this table stays on the safe side.
 */
export const TIER_KNOBS: Record<QualityTier, QualityKnobs> = {
  high: { renderScale: 1, frameCapHz: null },
  balanced: { renderScale: 0.75, frameCapHz: 60 },
  low: { renderScale: 0.5, frameCapHz: 30 },
};

/** Used until the profile resolves, and whenever there's no bridge at all. */
export const FULL_QUALITY: QualityKnobs = TIER_KNOBS.high;

/**
 * Slack allowed when enforcing a frame cap.
 *
 * Demanding the full interval means the vsync that lands exactly on the
 * boundary is rejected by a fraction of a millisecond and we wait a whole
 * extra frame: a 30 Hz cap on a 60 Hz display settles at 20 Hz, and a 60 Hz
 * cap on a 120 Hz display at 40. Half a 120 Hz frame absorbs the jitter
 * without letting the rate creep above the cap.
 */
export const FRAME_CAP_SLACK_MS = 1000 / 240;

/**
 * Whether a frame may be sent now under `capHz`. `null` means uncapped.
 *
 * Exported so `npm run check:quality` can drive it with synthetic vsync
 * traces — an off-by-a-millisecond here halves the frame rate and looks
 * exactly like a slow machine.
 */
export function frameDue(now: number, lastSentAt: number, capHz: number | null): boolean {
  if (capHz === null) return true;
  return now - lastSentAt >= 1000 / capHz - FRAME_CAP_SLACK_MS;
}

export const TIER_LABELS: Record<QualityTier, string> = {
  high: 'High',
  balanced: 'Balanced',
  low: 'Low power',
};

// ── Renderer-side capability probe ─────────────────────────────────────────

/**
 * The GL renderer string, which main cannot read for itself.
 *
 * Worth having even though `getGPUFeatureStatus` exists: that call is wrong
 * until a window has loaded, whereas this one is accurate immediately — on an
 * M5 it returned "ANGLE Metal Renderer: Apple M5" in the very context where
 * the feature status still claimed software rasterisation.
 */
function readGlRenderer(): { glRenderer: string; glVendor: string | null } {
  try {
    const gl = document.createElement('canvas').getContext('webgl');
    if (!gl) return { glRenderer: 'no-webgl', glVendor: null };
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return {
      glRenderer: String(
        ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
      ),
      glVendor: ext ? String(gl.getParameter(ext.UNMASKED_VENDOR_WEBGL)) : null,
    };
  } catch {
    return { glRenderer: 'unknown', glVendor: null };
  }
}

// ── Hook ───────────────────────────────────────────────────────────────────

export type QualityState =
  | { kind: 'loading' }
  | { kind: 'ready'; profile: DeviceProfile; capability: Capability; prompt: TestPrompt }
  /** No bridge (browser-only dev, or preload failed). Render at High. */
  | { kind: 'unavailable' };

export function useQuality() {
  const [state, setState] = useState<QualityState>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    const bridge = window.api?.deviceProfile;
    if (!bridge) {
      setState({ kind: 'unavailable' });
      return;
    }
    void bridge
      .resolve({ ...readGlRenderer(), drawRevision: DRAW_REVISION })
      .then((resolved: ResolvedDeviceProfile) => {
        if (cancelled) return;
        setState({
          kind: 'ready',
          profile: resolved.profile,
          capability: resolved.capability,
          prompt: resolved.prompt,
        });
      })
      .catch(() => {
        if (!cancelled) setState({ kind: 'unavailable' });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /** User override. Sticks across profile invalidation — see resolveProfile. */
  const setTier = useCallback(async (tier: QualityTier) => {
    const next = await window.api?.deviceProfile?.setTier(tier);
    if (next) {
      setState((s) => (s.kind === 'ready' ? { ...s, profile: next } : s));
    }
  }, []);

  /** Remember a refusal. Pass the prompt's own token — it is scoped to this
   *  instance of the reason, so a later update still gets to ask. */
  const declineTest = useCallback(async (token: string) => {
    const next = await window.api?.deviceProfile?.declineTest(token);
    setState((s) =>
      s.kind === 'ready' ? { ...s, profile: next ?? s.profile, prompt: { kind: 'none' } } : s,
    );
  }, []);

  const tier: QualityTier = state.kind === 'ready' ? state.profile.tier : 'high';

  // Memoized: this object is threaded into SettingsPanel as a single prop, and
  // a fresh identity every render would defeat any memo downstream of it.
  return useMemo(
    () => ({ state, tier, knobs: TIER_KNOBS[tier], setTier, declineTest }),
    [state, tier, setTier, declineTest],
  );
}

export type UseQuality = ReturnType<typeof useQuality>;

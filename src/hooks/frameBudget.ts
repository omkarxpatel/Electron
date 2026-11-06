import { createContext, useContext } from 'react';

/** The frame rate the visualizer and the progress bar drop to while the
 *  window sits behind another app with the 'reduced' background setting. */
export const BACKGROUND_FRAME_CAP_HZ = 30;

export interface FrameBudget {
  /** False once nobody can see the window: loops that only exist to be
   *  looked at stop. Same value App passes down as `active`. */
  active: boolean;
  /**
   * Cap for loops that would otherwise repaint on every display refresh,
   * applied with quality.ts's frameDue(). null means uncapped.
   *
   * Set while the window sits behind another app. Someone who left it on a
   * second display still sees the visualizer and the progress bar move, at
   * 30 Hz rather than the 120 Hz a ProMotion display drives.
   */
  frameCapHz: number | null;
}

export const FrameBudgetContext = createContext<FrameBudget>({ active: true, frameCapHz: null });

export function useFrameBudget(): FrameBudget {
  return useContext(FrameBudgetContext);
}

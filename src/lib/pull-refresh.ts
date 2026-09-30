// Pull-to-refresh on a surface that isn't a list: the Local Leaders place
// pill is the handle, because on a full-bleed map every drag belongs to the
// map. Pure so the feel can be tested without a renderer.

/** Distance, after resistance, at which letting go refreshes. */
export const PULL_THRESHOLD = 64;
/** The pill never stretches further than this, however far the finger goes. */
export const PULL_MAX = 110;

/**
 * Finger travel to visible stretch. Rubber-band resistance, like iOS: the
 * first few points follow the finger, then each extra point of travel buys
 * less, approaching PULL_MAX and never passing it. Upward travel is ignored.
 */
export function pullDistance(dy: number): number {
  if (!(dy > 0)) return 0;
  return PULL_MAX * (1 - Math.exp(-dy / PULL_MAX));
}

/** 0 → 1 as the stretch approaches the threshold; drives the progress ring. */
export function pullProgress(distance: number): number {
  if (!(distance > 0)) return 0;
  return Math.min(1, distance / PULL_THRESHOLD);
}

/** Whether releasing at this stretch should refresh. */
export function shouldRefresh(distance: number): boolean {
  return distance >= PULL_THRESHOLD;
}

/** Claim the gesture only for a mostly-downward drag, so a sideways swipe
 *  or a tap on the pill never starts a pull. */
export function isPullGesture(dx: number, dy: number): boolean {
  return dy > 6 && Math.abs(dy) > Math.abs(dx) * 1.5;
}

// The pocket screen: while a run records, the Track screen goes black after a
// short while untouched, and the map stops drawing until it is tapped awake.
//
// Why it exists (2026-10-25): a phone died at ~2 h 50 min into a run that
// started near 9 am. Web recording is foreground-only, so the screen has to
// stay on for the whole run (tracking.ts's wake lock), and outdoors in the
// morning sun auto-brightness drives it to its maximum. On top of that the
// map was repainting a pitched 3D scene ~17 times a second for the route's
// gradient flow (gradient-flow.ts), plus a camera ease on every fix. The
// run's own maths is not the cost: measured on a 3 h copy of a real route,
// tiles + enclosure + laps + pace guard come to ~15 ms every 5 s.
//
// So the fix is what nobody looks at mid-run: the screen in the pocket. A
// black screen costs almost nothing on an OLED panel (every iPhone since the
// X bar the SE), and a map that is not drawn costs nothing on any panel.
// The wake lock stays: GPS needs the page in the foreground, and that is
// the one thing this must never change.
//
// Wakes on a TAP of the black screen (onPress, after the finger lifts), never
// on pointerdown: waking on pointerdown would unmount the black screen
// between down and up, and the click would land on whatever is underneath,
// which is Pause or Finish.
//
// Web only. Native records through Expo Go with its own map and no wake-lock
// workaround; nothing here runs without a `document`.
import { useCallback, useEffect, useState } from 'react';

/** How long without a touch before the screen goes black. Long enough to
 *  read the stats after starting or after a glance, short enough that a
 *  phone put back in a pocket stops drawing within a few seconds of it. */
export const POCKET_IDLE_MS = 15_000;

export function usePocketScreen(enabled: boolean): { asleep: boolean; wake: () => void } {
  const [asleep, setAsleep] = useState(false);
  // Bumped by wake() so the idle timer restarts from the tap.
  const [wakes, setWakes] = useState(0);

  useEffect(() => {
    if (!enabled || typeof document === 'undefined') return;
    // Every (re-)enable starts awake: a session that went to sleep, was
    // paused or ended some other way, and came back would otherwise open on
    // a black screen. Deferred, not called in the effect body — the React
    // Compiler's cascading-render rule, same pattern as index.tsx.
    const reset = setTimeout(() => setAsleep(false), 0);
    let timer = setTimeout(() => setAsleep(true), POCKET_IDLE_MS);
    // Any touch while awake (a pan of the map, a zoom button) restarts the
    // countdown. While asleep the black screen is on top, so the only touch
    // that can arrive is the one that wakes it, handled by wake().
    const onActivity = () => {
      clearTimeout(timer);
      timer = setTimeout(() => setAsleep(true), POCKET_IDLE_MS);
    };
    document.addEventListener('pointerdown', onActivity, { capture: true, passive: true });
    return () => {
      clearTimeout(reset);
      clearTimeout(timer);
      document.removeEventListener('pointerdown', onActivity, { capture: true });
    };
  }, [enabled, wakes]);

  const wake = useCallback(() => {
    setAsleep(false);
    setWakes((n) => n + 1);
  }, []);

  // Never asleep while disabled (paused, finished, another tab).
  return { asleep: enabled && asleep, wake };
}

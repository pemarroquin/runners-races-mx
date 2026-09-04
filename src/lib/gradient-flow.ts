// The one timer behind the route/rim gradient's continuous flow — the
// "feels alive even standing still" motion on every Mapbox surface that
// draws a route or a territory edge: the live Track map (track-map.web.tsx),
// the just-finished-run summary (fence-map.web.tsx), and every saved
// territory on the Territories map (territories-map.web.tsx).
//
// It knows nothing about mapbox-gl: the caller passes an `apply` that paints
// whichever layers it owns. That is what lets one implementation drive a
// single live route and twenty saved territories alike, and what keeps this
// file testable without a GL context.
//
// WEB ONLY in practice. react-native-maps' Polyline takes one colour per
// VERTEX (see fence-draw.ts's gradientStrokeColors), so flowing it would
// mean re-rendering the whole line every tick — the native maps keep the
// static wheel, an accepted platform difference like the missing
// fill-extrusion.
//
// Three things keep the cost down, all of them mattering more the more
// territories are on screen at once:
//
//   1. The loop is PERIODIC, so its frames are precomputed once (FRAME_COUNT
//      of them) and thereafter only indexed. No colour maths, no string
//      building and no allocation happens on a tick.
//   2. Every animated layer on a screen shares ONE timer and ONE expression
//      per tick — the per-territory cost is a setPaintProperty call, not a
//      timer of its own.
//   3. A tick doesn't paint; it queues one rAF callback that does. Ticks
//      that land in the same displayed frame collapse into a single paint,
//      the value lands immediately before the browser draws, and a hidden
//      tab paints nothing at all (rAF doesn't fire there).
import { ROUTE_GRADIENT_FRAME_MS, ROUTE_GRADIENT_LOOP_MS } from '@/constants/map';
import { flowingRouteGradient, lineGradientExpression } from '@/lib/fence-draw';

/** Distinct frames in one loop. The flow repeats exactly this often, which
 *  is what makes precomputing them possible at all. */
const FRAME_COUNT = Math.max(1, Math.round(ROUTE_GRADIENT_LOOP_MS / ROUTE_GRADIENT_FRAME_MS));

let frames: string[] | null = null;

/** Built on the first flow of the session, then shared by every later one —
 *  the table is identical for all of them, and it is ~73 expressions of 14
 *  stops, not something worth rebuilding per map or per territory. */
function gradientFrames(): string[] {
  if (frames === null) {
    frames = Array.from({ length: FRAME_COUNT }, (_, i) =>
      lineGradientExpression(flowingRouteGradient(i / FRAME_COUNT)),
    );
  }
  return frames;
}

/**
 * Starts the flow and returns its stopper. `apply` is handed a ready-made
 * `line-gradient` expression roughly every ROUTE_GRADIENT_FRAME_MS and should
 * do nothing but pass it to the layers it owns.
 *
 * The phase comes from the WALL CLOCK, not from counting ticks: a dropped or
 * late tick (GC, a busy main thread, a throttled background tab) then costs a
 * frame rather than permanently slowing the loop down, and two surfaces
 * started seconds apart still run at the same speed.
 */
export function startGradientFlow(apply: (gradient: string) => void): () => void {
  const table = gradientFrames();
  const startedAt = Date.now();
  let timer: ReturnType<typeof setInterval> | null = null;
  let frame: number | null = null;
  let painted = -1;

  const paint = () => {
    frame = null;
    const elapsed = Date.now() - startedAt;
    const index = Math.floor((elapsed / ROUTE_GRADIENT_LOOP_MS) * FRAME_COUNT) % FRAME_COUNT;
    // Two ticks inside one displayed frame, or a repaint request that the
    // clock says hasn't advanced a frame yet: nothing to draw.
    if (index === painted) return;
    painted = index;
    apply(table[index]);
  };

  const canSchedule = typeof requestAnimationFrame === 'function';
  const tick = () => {
    if (!canSchedule) {
      paint();
      return;
    }
    // Already queued — let that one callback read the clock for both ticks
    // rather than stacking a second paint onto the same frame.
    if (frame === null) frame = requestAnimationFrame(paint);
  };

  const start = () => {
    if (timer === null) timer = setInterval(tick, ROUTE_GRADIENT_FRAME_MS);
  };
  const stop = () => {
    if (timer !== null) clearInterval(timer);
    timer = null;
    if (frame !== null && canSchedule) cancelAnimationFrame(frame);
    frame = null;
  };

  // A backgrounded tab keeps its map mounted and its timers running.
  // Browsers throttle a background setInterval to roughly 1Hz, but throttled
  // is not stopped — and this is a phone that has to survive a 40-minute run
  // with the screen on. rAF already declines to fire while hidden, so this
  // mainly stops the timer itself; it costs one listener.
  const hasDocument = typeof document !== 'undefined';
  const onVisibility = () => {
    if (document.visibilityState === 'hidden') stop();
    else start();
  };
  if (hasDocument) {
    document.addEventListener('visibilitychange', onVisibility);
    if (document.visibilityState !== 'hidden') start();
  } else {
    start();
  }

  return () => {
    stop();
    if (hasDocument) document.removeEventListener('visibilitychange', onVisibility);
  };
}

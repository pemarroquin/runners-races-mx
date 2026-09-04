// "You are not running" detection, live, during a session.
//
// Pedro drove a car on 2026-09-03 and banked 3 299 m / 977 565 m2 of
// territory. This is the guard that ends a session like that before it can
// be saved. Every constant below was measured against real data — two
// drives and one genuine 52-minute walk/jog — rather than guessed. The full
// write-up, with the raw rows, is in
// `Source Data/Outputs/Running App/ANTI-CHEAT-EVIDENCE.md`, and
// `npm run audit-territories` re-derives all of it.
//
// THE TRAP, and the reason this is a WINDOW and not a speed check: the
// genuine run in that sample contains a single segment at 171 km/h. It is
// an ordinary GPS glitch between two good fixes, and it is not rare. Any
// rule of the form "if speed > X then cheat" ends honest runners' sessions.
// Never add one. Judge sustained movement only.
//
// Pure and platform-free so it can be tested against the real recorded paths
// (test/pace-guard.test.ts replays all three) — this project has no React
// renderer in its test setup, so anything that must be proven correct has to
// live outside a component.
import { haversineM } from '@/lib/territory';
import type { TrackPoint } from '@/lib/tracking';

/**
 * Seconds of movement to judge. Measured maxima over a sliding window:
 *
 *            15 s     30 s     60 s
 *   drive    60.5     58.7     51.0
 *   drive    62.9     60.2     55.3
 *   real     15.7     12.1     11.6
 *
 * 15 s is too twitchy — a real run touched 15.7 km/h over one. 60 s costs
 * another half-minute of driving and buys no extra separation. At 30 s the
 * gap between a real run and a car is 12.2 against ~59.
 */
export const PACE_GUARD_WINDOW_S = 30;

/**
 * Sustained km/h that ends the session. The real run peaked at 12.2 over a
 * 30 s window, so this sits comfortably above honest movement, and both
 * drives crossed it 25-26 seconds in — still in the car park, before any
 * territory worth claiming existed.
 *
 * For scale: the men's 10 000 m world record averages ~22.9 km/h and the
 * marathon WR ~20.9 km/h. Nobody sustains 20 km/h for 30 seconds while
 * claiming neighbourhood tiles, and the cost to the rare person who could is
 * a message they can dismiss — not a ban, and not a lost account.
 */
export const PACE_GUARD_KMH = 20;

/** Fewest segments in a window for its median to mean anything. */
const MIN_SEGMENTS = 3;

/**
 * The highest MEDIAN segment speed (km/h) across any window of `windowS`
 * seconds, or 0 when the run is too short to judge.
 *
 * The median is the whole trick, and it was arrived at by measurement after
 * the obvious version failed. Averaging the window's total distance looks
 * equivalent and is not: one bad fix 300 m off adds 600 m to the window
 * (out AND back), which over 30 s reads as 80 km/h and ends an honest run.
 * Trimming the largest segment does not fix it either — a jump is always
 * two segments, so a 300 m jump still read as 45 km/h. A median cannot be
 * moved by any minority of bad fixes at all.
 *
 * Measured on the three recorded runs plus a clean 10 km/h path with a
 * single injected jump:
 *
 *                     mean   drop-2   MEDIAN
 *   drive-sep3        58.7     54.5     59.1
 *   drive-sep2        60.2     55.7     60.2
 *   real run          12.1     10.6     12.2
 *   10 km/h + 300 m jump  80.8     44.6      9.0
 *   10 km/h + 600 m jump 153.3     80.8      9.0
 *   10 km/h clean          9.0      8.4      9.0
 *
 * The median reads a glitched run as exactly the clean run it really is,
 * while reading a car as a car.
 */
export function maxSustainedKmh(points: TrackPoint[], windowS = PACE_GUARD_WINDOW_S): number {
  if (points.length < 2) return 0;

  // Speed of each segment, and the time it covers. Index i is the segment
  // ENDING at points[i], so segmentKmh[0] is unused padding.
  const segmentKmh: number[] = [0];
  for (let i = 1; i < points.length; i++) {
    const seconds = (points[i].ts - points[i - 1].ts) / 1000;
    // A duplicate or out-of-order timestamp has no speed — not an infinite
    // one. Recorded as 0 so it neither trips the guard nor shifts a median
    // much, rather than being dropped and silently misaligning the window.
    segmentKmh.push(seconds > 0 ? (haversineM(points[i - 1], points[i]) / seconds) * 3.6 : 0);
  }

  let best = 0;
  let start = 0;
  for (let end = 0; end < points.length; end++) {
    while ((points[end].ts - points[start].ts) / 1000 > windowS) start++;
    const seconds = (points[end].ts - points[start].ts) / 1000;
    // Require most of a full window. Without this the first two fixes of a
    // run span a fraction of a second and read as an instantaneous speed —
    // exactly the single-fix judgement this guard exists to avoid.
    if (seconds < windowS * 0.8) continue;

    const window = segmentKmh.slice(start + 1, end + 1);
    if (window.length < MIN_SEGMENTS) continue;
    const sorted = [...window].sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    const median =
      sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    if (median > best) best = median;
  }
  return best;
}

/**
 * True when the runner has been moving faster than anyone runs, for long
 * enough that it cannot be GPS noise. The caller ends and DISCARDS the
 * session — a run that trips this is never saved, so cheating earns nothing
 * rather than earning less.
 *
 * Returns false for a short run rather than guessing: there is no way to
 * know from four seconds of fixes, and ending someone's session on a guess
 * is worse than missing 30 seconds of a drive.
 */
export function isImpossiblePace(points: TrackPoint[]): boolean {
  return maxSustainedKmh(points) > PACE_GUARD_KMH;
}

// "You are not running" detection, live, during a session.
//
// Pedro drove a car on 2026-09-03 and banked 3 299 m / 977 565 m2 of
// territory. This is the guard that ends a session like that, and keeps only
// what was recorded before the drive (2026-10-25: it used to delete the
// whole session, and a false trip at a water stop cost a real hour). Every constant below was measured against real data — two
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
import { splitLegs } from '@/lib/gap-policy';
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
 * 15 s is too twitchy — a real run touched 15.7 km/h over one. This was
 * 30 s, where the gap between a real run and a car is 12.2 against ~59.
 *
 * 60 s since 2026-10-25, for the phone standing still indoors (see
 * paceVerdict): the centre test averages each half-window's fixes, and at
 * 30 s a half holds only ~7, so 60 m of bounce still crossed 20 km/h
 * somewhere in ten minutes. At 60 s it reads ~10. The half-minute it costs
 * in catching a drive no longer matters: a trip now cuts the run at the
 * START of the first fast window, so the extra seconds are dropped with
 * the rest (measured cuts: 0 s and 32 s into the two drives).
 */
export const PACE_GUARD_WINDOW_S = 60;

/**
 * Sustained km/h that ends the session. The real run peaked at 12.2 over a
 * 30 s window (11.3 over 60 s), so this sits comfortably above honest movement, and both
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
 * Fixes the phone itself reported as worse than this (metres) are not
 * judged at all. Same bar as tracking.ts's MIN_ACCURACY_M: a fix past it is
 * only ever recorded because the accuracy filter FAILED OPEN (three rejects
 * in a row), which is what a phone indoors does. Measured 2026-10-25: a
 * stationary phone whose fail-open fixes land 100-150 m around it every
 * ~8 s reads 125-190 km/h on the median and still 25-37 km/h on the
 * centroid test below. They are noise about where you are, and the guard
 * judges speed.
 */
export const POOR_FIX_M = 100;

/**
 * The guard's two numbers for a run: the highest sustained km/h over any
 * window, and where the FIRST window over PACE_GUARD_KMH started (its first
 * point's timestamp), or null if none did.
 *
 * A window is judged on two measures and counts only as fast as the SLOWER
 * of them:
 *
 * - the MEDIAN segment speed. Robust to a minority of bad fixes (see the
 *   table below), but blind to a phone standing still with every fix
 *   bouncing: then EVERY segment is fast. That is a restroom or a shop for
 *   water mid-run, and it ended and deleted real runs (Pedro, 2026-10-25,
 *   "there was no activity and the run got cancelled"; an hour of a 21 km
 *   run gone). Measured on a stationary phone whose fixes scatter 30 m:
 *   median 119 km/h. 60 m: 239.
 * - how far the window's CENTRE moved: the mean position of its first half
 *   against its second half, over the time between them. Bouncing averages
 *   out, travel does not. The same 30 m and 60 m bounce read 4.5 and 9.0;
 *   both drives still read 58 and 60, and the real runs 7-14.
 */
function paceVerdict(
  allPoints: TrackPoint[],
  windowS: number,
): { maxKmh: number; tripStartTs: number | null } {
  const points = allPoints.filter((p) => p.acc === undefined || p.acc <= POOR_FIX_M);
  if (points.length < 2) return { maxKmh: 0, tripStartTs: null };

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
  let tripStartTs: number | null = null;
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
    // Cheap test first: most windows of a run are nowhere near the bar.
    if (median <= best) continue;

    const kmh = Math.min(median, centreKmh(points, start, end));
    if (kmh > best) best = kmh;
    if (tripStartTs === null && kmh > PACE_GUARD_KMH) tripStartTs = points[start].ts;
  }
  return { maxKmh: best, tripStartTs };
}

/** km/h between the mean position of points[start..end]'s first half and
 *  its second half — see paceVerdict. */
function centreKmh(points: TrackPoint[], start: number, end: number): number {
  const n = end - start + 1;
  const half = n >> 1;
  const mean = (from: number, to: number) => {
    let lat = 0;
    let lng = 0;
    let ts = 0;
    for (let i = from; i < to; i++) {
      lat += points[i].lat;
      lng += points[i].lng;
      ts += points[i].ts;
    }
    const k = to - from;
    return { lat: lat / k, lng: lng / k, ts: ts / k };
  };
  const a = mean(start, start + half);
  const b = mean(start + half, end + 1);
  const seconds = (b.ts - a.ts) / 1000;
  return seconds > 0 ? (haversineM(a, b) / seconds) * 3.6 : 0;
}

/**
 * The highest sustained km/h across any window of `windowS` seconds, or 0
 * when the run is too short to judge. See paceVerdict for how a window is
 * judged; the MEDIAN half of it was arrived at by measurement after the
 * obvious version failed. Averaging the window's total distance looks
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
  return paceVerdict(points, windowS).maxKmh;
}

/**
 * True when the runner has been moving faster than anyone runs, for long
 * enough that it cannot be GPS noise.
 *
 * Returns false for a short run rather than guessing: there is no way to
 * know from four seconds of fixes, and ending someone's session on a guess
 * is worse than missing a minute of a drive.
 */
export function isImpossiblePace(points: TrackPoint[]): boolean {
  return paceGuardCut(points) !== null;
}

/**
 * Where to cut a run that tripped the guard: the timestamp the first fast
 * window started at, or null if none did. The caller ends the session and
 * keeps only what came before it (`ts < cut`).
 *
 * Kept, not discarded: the guard used to delete the WHOLE session, so one
 * false trip cost an honest runner everything recorded before it. What
 * stops a drive banking territory is that the drive itself never counts;
 * whatever was honestly run before it was never the problem.
 */
export function paceGuardCut(points: TrackPoint[]): number | null {
  return paceVerdict(points, PACE_GUARD_WINDOW_S).tripStartTs;
}

/**
 * The part of a run recorded before `cut` (see paceGuardCut), with its
 * distance. The distance is re-measured from the kept points rather than
 * scaled from the live total: summed leg by leg (splitLegs), so it crosses
 * only the gaps the rest of the app would bridge, the same rule the live
 * total's gap credit follows.
 */
export function keptBeforeCut(
  points: TrackPoint[],
  cut: number,
): { points: TrackPoint[]; distanceM: number } {
  const kept = points.filter((p) => p.ts < cut);
  let distanceM = 0;
  for (const leg of splitLegs(kept)) {
    for (let i = 1; i < leg.length; i++) distanceM += haversineM(leg[i - 1], leg[i]);
  }
  return { points: kept, distanceM };
}

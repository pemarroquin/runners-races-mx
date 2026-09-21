// detectLaps — real lap/loop detection, replacing the "cycle bonus" that
// never detected a cycle (reported 2026-09-20). See src/lib/laps.ts's own
// header for the full story of the bug this replaces.
//
// Fixtures are built from REAL H3 geometry around Monterrey (h3-js's own
// latLngToCell/gridPathCells, converted back to lat/lng with cellToLatLng),
// never hand-written H3 id strings or hand-picked lat/lng offsets meant to
// coincidentally land in particular cells — same convention as
// test/tiles.test.ts and test/marker-anchor.test.ts (fix/conquest-marker-
// centre).
//
// Routes are built from straight axis-aligned legs (`walk`/`chain` below)
// rather than gridPathCells directly: every scenario here needs multiple
// CONNECTED legs (a rectangle, an out-and-back, a figure-8), and stitching
// those from real lat/lng waypoints exercises the same latLngToCell mapping
// detectLaps itself does, without coupling the fixtures to gridPathCells'
// internals the way a single from->to hop would.
import { cellToLatLng, gridDisk, latLngToCell } from 'h3-js';
import { describe, expect, it } from 'vitest';

import type { TimedPoint } from '@/lib/gap-policy';
import {
  detectLaps,
  MIN_REPEAT_FRACTION,
  MIN_REPEATED_CELLS,
  MIN_SEPARATION_CELLS,
  pickLapMarkerCenter,
} from '@/lib/laps';
import { DEFAULT_TILE_RES } from '@/lib/tiles';

const MTY = { lat: 25.6714, lng: -100.369 };
const M_PER_DEG_LAT = 111_320;
const M_PER_DEG_LNG = M_PER_DEG_LAT * Math.cos((MTY.lat * Math.PI) / 180);

// A comfortable jogging pace (~10.8 km/h) at a realistic 2s fix cadence —
// 6m per fix, comfortably smaller than a res-12 cell's ~10.8m edge, so
// consecutive fixes often land in the same cell (collapsed, as real GPS
// traces are) rather than skipping cells entirely.
const STEP_M = 6;
const FIX_MS = 2000;

/** A point `eastM`/`northM` from the MTY origin, at wall-clock `atMs` — flat
 *  local-tangent approximation, accurate enough over the few-km spans these
 *  fixtures use. */
function pointAt(eastM: number, northM: number, atMs: number): TimedPoint {
  return {
    lat: MTY.lat + northM / M_PER_DEG_LAT,
    lng: MTY.lng + eastM / M_PER_DEG_LNG,
    ts: atMs,
  };
}

/**
 * Stitches a straight-line, constant-cadence path through a list of
 * (eastM, northM) waypoints — each consecutive pair becomes one leg, walked
 * at STEP_M/FIX_MS. Waypoints are visited in order and every one appears in
 * the output (including the very last), so repeating a waypoint (closing a
 * loop, or reversing direction for an out-and-back) produces exactly the
 * revisit a real runner's GPS trace would.
 */
function chain(waypoints: [number, number][]): TimedPoint[] {
  const points: TimedPoint[] = [];
  let ms = 0;
  for (let i = 0; i < waypoints.length - 1; i++) {
    const [fromE, fromN] = waypoints[i];
    const [toE, toN] = waypoints[i + 1];
    const dist = Math.hypot(toE - fromE, toN - fromN);
    const steps = Math.max(1, Math.round(dist / STEP_M));
    for (let s = 0; s < steps; s++) {
      const t = s / steps;
      points.push(pointAt(fromE + (toE - fromE) * t, fromN + (toN - fromN) * t, ms));
      ms += FIX_MS;
    }
  }
  const [lastE, lastN] = waypoints[waypoints.length - 1];
  points.push(pointAt(lastE, lastN, ms));
  return points;
}

/** A closed rectangle loop's own waypoints, big enough (comfortably over
 *  MIN_REPEATED_CELLS cells per lap) that two or three real laps around it
 *  clear both `qualifies` thresholds. ~1100m x ~1000m. */
const BIG_LOOP: [number, number][] = [
  [0, 0],
  [0, 1100],
  [1000, 1100],
  [1000, 0],
  [0, 0],
];

/** N laps of `waypoints`, sharing each seam vertex exactly once (no
 *  zero-length duplicate leg between repeats). */
function laps(waypoints: [number, number][], count: number): [number, number][] {
  const out = [...waypoints];
  for (let i = 1; i < count; i++) out.push(...waypoints.slice(1));
  return out;
}

describe('detectLaps', () => {
  it('returns laps: 0 for an empty path', () => {
    const result = detectLaps([]);
    expect(result).toEqual({ laps: 0, repeatedCells: [], repeatFraction: 0, qualifies: false });
  });

  it('returns laps: 1 for a single point', () => {
    const result = detectLaps([pointAt(0, 0, 0)]);
    expect(result.laps).toBe(1);
    expect(result.repeatedCells).toEqual([]);
    expect(result.qualifies).toBe(false);
  });

  it('an ordinary single loop (no genuine repeat) does not qualify', () => {
    // A completely normal, boring single lap — most loop-shaped runs ever
    // recorded. Its own start/finish cell is technically visited twice (once
    // leaving, once arriving back), which is why `laps` itself reads 2 here
    // rather than 1 — that one coincidence is real, not a bug, and is why
    // `qualifies` (not the raw `laps` number) is what actually gates the
    // bonus: exactly ONE cell out of the whole route is "repeated", nowhere
    // near MIN_REPEATED_CELLS, so this never awards anything. This is the
    // reported failure mode's mirror image: a run that is NOT a loop-repeat
    // must not read as one.
    const result = detectLaps(chain(BIG_LOOP));
    expect(result.repeatedCells.length).toBeLessThanOrEqual(1);
    expect(result.qualifies).toBe(false);
  });

  it('two clean laps of a closed loop qualify', () => {
    // laps === 3, not 2: BIG_LOOP's own start/finish cell is crossed once on
    // arrival plus once per lap-completion (see the single-loop test above
    // for why) — 1 initial + 2 completions = 3. Every OTHER cell on the loop
    // reads exactly 2 (once per lap), which is what actually drives
    // `repeatedCells`/`qualifies`; `laps` is the MAX across all cells per its
    // own spec, and the shared start/finish point is a genuine, if slightly
    // surprising, maximum.
    const result = detectLaps(chain(laps(BIG_LOOP, 2)));
    expect(result.laps).toBe(3);
    expect(result.repeatedCells.length).toBeGreaterThanOrEqual(MIN_REPEATED_CELLS);
    expect(result.repeatFraction).toBeGreaterThanOrEqual(MIN_REPEAT_FRACTION);
    expect(result.qualifies).toBe(true);
  });

  it('three laps report laps: 4 (three completions plus the initial arrival)', () => {
    const result = detectLaps(chain(laps(BIG_LOOP, 3)));
    expect(result.laps).toBe(4);
    expect(result.qualifies).toBe(true);
  });

  it('an out-and-back qualifies — CONFIRMED PRODUCT DECISION, not a bug', () => {
    // The user explicitly confirmed retracing the same road home counts as
    // covering the route twice: "OUT-AND-BACK COUNTS". No bearing/direction
    // check exists anywhere in detectLaps, deliberately — this is the test
    // that would fail the instant one got added. 1100m one-way, long enough
    // that the ~100m unusable zone right at the turnaround (too close
    // together to clear MIN_SEPARATION_CELLS) still leaves >= 50 cleanly
    // separated repeated cells.
    const outAndBack = chain([
      [0, 0],
      [1100, 0],
      [0, 0],
    ]);
    const result = detectLaps(outAndBack);
    expect(result.laps).toBe(2);
    expect(result.repeatedCells.length).toBeGreaterThanOrEqual(MIN_REPEATED_CELLS);
    expect(result.qualifies).toBe(true);
  });

  it('a one-way route sharing only its first/last ~200m does not qualify', () => {
    // A "lollipop": a shared out/back stick (0 -> 1200m east) plus a
    // distinct three-sided loop that closes itself by continuing straight
    // back through the stick to the origin. Only the stick (~73 cells) is
    // genuinely revisited; the loop's other three sides (~370 cells) are
    // each covered exactly once — well past the ~200m the brief describes,
    // scaled up so the REPEATED-CELL COUNT alone clears MIN_REPEATED_CELLS
    // and only the fraction gate is left to reject it (see below).
    const route = chain([
      [0, 0],
      [1200, 0], // shared "stick" out
      [1200, 1500], // distinct loop, leg 1
      [2700, 1500], // distinct loop, leg 2
      [2700, 0], // distinct loop, leg 3 — continues straight through
      [0, 0], // (1200,0) back to origin: retraces the stick
    ]);
    const result = detectLaps(route);
    expect(result.repeatedCells.length).toBeGreaterThanOrEqual(MIN_REPEATED_CELLS);
    // The count alone clears the bar — it's the FRACTION that must reject
    // this, exactly the scaling problem a flat count can't solve on its own.
    expect(result.repeatFraction).toBeLessThan(0.3); // well under MIN_REPEAT_FRACTION (0.6)
    expect(result.qualifies).toBe(false);
  });

  it('a figure-8 sharing only its crossing point does not qualify', () => {
    // Two closed squares meeting at the origin — a real figure-8's shared
    // "middle" is usually a short stretch, not a single point, and would
    // score higher than this (the brief's own estimate: ~0.3). A single
    // shared crossing point is the strongest, simplest version of "not a
    // real repeat" and must reject at least as hard.
    const figureEight = chain([
      [0, 0],
      [500, 0],
      [500, 500],
      [0, 500],
      [0, 0], // closes loop A
      [-500, 0],
      [-500, -500],
      [0, -500],
      [0, 0], // closes loop B
    ]);
    const result = detectLaps(figureEight);
    expect(result.repeatFraction).toBeLessThan(MIN_REPEAT_FRACTION);
    expect(result.qualifies).toBe(false);
  });

  it('GPS jitter at a standstill reports laps: 1 and never qualifies (anti-farming case)', () => {
    // A runner standing still for ~10 minutes while GPS noise flickers
    // between two ADJACENT cells. Between any two visits to either cell the
    // only "other" cell present is the one it borders — a distinct count of
    // 1, nowhere near MIN_SEPARATION_CELLS (10) — no matter how long this
    // goes on for, which is exactly the point: a time-based cooldown could
    // be waited out, an intervening-cell requirement cannot.
    const cellA = latLngToCell(MTY.lat, MTY.lng, DEFAULT_TILE_RES);
    const cellB = gridDisk(cellA, 1).find((c) => c !== cellA)!;
    const [latA, lngA] = cellToLatLng(cellA);
    const [latB, lngB] = cellToLatLng(cellB);
    const points: TimedPoint[] = Array.from({ length: 300 }, (_, i) => ({
      lat: i % 2 === 0 ? latA : latB,
      lng: i % 2 === 0 ? lngA : lngB,
      ts: i * FIX_MS,
    }));
    const result = detectLaps(points);
    expect(result.laps).toBe(1);
    expect(result.repeatedCells).toEqual([]);
    expect(result.qualifies).toBe(false);
  });

  it('a tiny loop run many times does not qualify despite high laps and repeatFraction', () => {
    // ~100m x ~100m — comfortably fewer than MIN_REPEATED_CELLS (50) cells
    // per lap, run 5 times. Both `laps` and `repeatFraction` read as a
    // strong, unambiguous repeat; only the flat MIN_REPEATED_CELLS floor
    // catches that the actual ground covered is trivial.
    const TINY_LOOP: [number, number][] = [
      [0, 0],
      [0, 100],
      [100, 100],
      [100, 0],
      [0, 0],
    ];
    const result = detectLaps(chain(laps(TINY_LOOP, 5)));
    expect(result.laps).toBeGreaterThanOrEqual(3);
    expect(result.repeatFraction).toBeGreaterThanOrEqual(MIN_REPEAT_FRACTION);
    expect(result.repeatedCells.length).toBeLessThan(MIN_REPEATED_CELLS);
    expect(result.qualifies).toBe(false);
  });

  it('a malformed fix (NaN lat) mid-path does not throw and the rest still processes', () => {
    const points = chain(laps(BIG_LOOP, 2));
    const withNaN = [...points];
    const mid = Math.floor(withNaN.length / 2);
    withNaN.splice(mid, 0, { lat: NaN, lng: MTY.lng, ts: withNaN[mid].ts - 1 });

    expect(() => detectLaps(withNaN)).not.toThrow();
    const result = detectLaps(withNaN);
    // One bad fix among hundreds of good ones must not blank the result —
    // same posture as pathToTiles' own per-point guard (tiles.ts). 3, not 2
    // — see the "two clean laps" test above for why.
    expect(result.laps).toBe(3);
    expect(result.qualifies).toBe(true);
  });

  it('MIN_SEPARATION_CELLS rejects a revisit with too little separation', () => {
    // Two visits to the same cell with only a handful of distinct cells
    // between them — well under the 10-cell floor — must not count as a lap,
    // regardless of how far apart they are in the path overall.
    const cellA = latLngToCell(MTY.lat, MTY.lng, DEFAULT_TILE_RES);
    const ring = gridDisk(cellA, 1).filter((c) => c !== cellA).slice(0, 3); // 3 neighbours < 10
    const cells = [cellA, ...ring, cellA];
    let ms = 0;
    const points: TimedPoint[] = cells.map((c) => {
      const [lat, lng] = cellToLatLng(c);
      const p = { lat, lng, ts: ms };
      ms += FIX_MS;
      return p;
    });
    const result = detectLaps(points);
    expect(result.laps).toBe(1);
    expect(result.qualifies).toBe(false);
  });
});

describe('pickLapMarkerCenter', () => {
  it('returns null for empty input', () => {
    expect(pickLapMarkerCenter([])).toBeNull();
  });

  it('always lands on one of the input cells, never an arithmetic mean outside the set', () => {
    // A V-shaped (non-convex) set of repeated cells, same class of shape
    // that broke the conquest marker's raw mean (fix/conquest-marker-centre,
    // 482m off-route on a real run). Two arms meeting at a point, far enough
    // apart that their own mean falls in the empty gap between them.
    const points = chain([
      [0, 0],
      [-500, 1000],
    ]).concat(
      chain([
        [0, 0],
        [500, 1000],
      ]),
    );
    const cells = [...new Set(points.map((p) => latLngToCell(p.lat, p.lng, DEFAULT_TILE_RES)))];
    const center = pickLapMarkerCenter(cells);
    expect(center).not.toBeNull();
    if (!center) return;
    const landedCell = latLngToCell(center.lat, center.lng, DEFAULT_TILE_RES);
    expect(cells).toContain(landedCell);
  });
});

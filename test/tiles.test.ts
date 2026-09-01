// pathToTiles — the core of the coverage-model migration (Tile Coverage
// Model brief §3, §6 step 1). Must-have cases per the brief: a straight
// path yields a contiguous cell run with no gaps; a stationary runner
// yields one cell; a 25m out-and-back yields the same cells both ways
// (idempotent). Plus the speed-cap fix (b8's review, 2026-09-01): an
// unbounded bridge is the enclosure model's auto-close bug wearing
// different clothes — a background-gap jump used to be bridged exactly
// like a normal throttle gap, silently claiming ground never run over.
import { getResolution, gridDistance, gridPathCells, latLngToCell } from 'h3-js';
import { describe, expect, it } from 'vitest';

import { DEFAULT_TILE_RES, MAX_BRIDGE_SPEED_MS, pathToTiles, type TilePoint } from '@/lib/tiles';

// Monterrey-ish latitude, matching territory.test.ts's own fixtures.
const LAT = 25.67;
const LNG = -100.31;
// ~111,320m per degree latitude everywhere; longitude scales by cos(lat).
const M_PER_DEG_LAT = 111_320;
const M_PER_DEG_LNG = M_PER_DEG_LAT * Math.cos((LAT * Math.PI) / 180);

// A comfortable jogging pace, safely under MAX_BRIDGE_SPEED_MS (~6.94 m/s /
// 25 km/h) — used for fixtures where the point of the test is gap-FILL
// behaviour, not the speed cap itself. Timestamps are derived FROM this
// pace and the actual distance, so "this gap is physically plausible" is
// true by construction rather than by accident.
const JOG_MS = 3; // 10.8 km/h

/** A point `metres` east of a fixed origin, at wall-clock `atMs`. */
function pointEast(metres: number, atMs: number): TilePoint {
  return { lat: LAT, lng: LNG + metres / M_PER_DEG_LNG, ts: atMs };
}

/** A straight-line path east from the origin, `stepM` apart, with
 *  timestamps derived from `speedMs` — the implied speed between every
 *  consecutive pair is exactly `speedMs`, by construction. */
function pathAtPace(steps: number, stepM: number, speedMs: number): TilePoint[] {
  const stepMs = (stepM / speedMs) * 1000;
  return Array.from({ length: steps }, (_, i) => pointEast(i * stepM, i * stepMs));
}

describe('pathToTiles', () => {
  it('returns nothing for an empty path', () => {
    const result = pathToTiles([]);
    expect(result.cells).toEqual([]);
    expect(result.directCount).toBe(0);
    expect(result.gapFilledCount).toBe(0);
    expect(result.bridgeFailures).toBe(0);
    expect(result.bridgesSkipped).toBe(0);
  });

  it('a single point yields exactly one cell, direct', () => {
    const result = pathToTiles([pointEast(0, 0)]);
    expect(result.cells).toHaveLength(1);
    expect(result.directCount).toBe(1);
    expect(result.gapFilledCount).toBe(0);
    expect(result.cells[0]).toBe(latLngToCell(LAT, LNG, DEFAULT_TILE_RES));
  });

  it('a stationary runner (many fixes, same spot) yields one cell', () => {
    const path: TilePoint[] = Array.from({ length: 20 }, (_, i) => pointEast(0, i * 2000));
    const result = pathToTiles(path);
    expect(result.cells).toHaveLength(1);
    expect(result.directCount).toBe(1);
    expect(result.gapFilledCount).toBe(0);
  });

  it('two fixes within the same tile need no gap-fill', () => {
    // A handful of metres — well inside one ~25m-edge res-11 cell.
    const result = pathToTiles([pointEast(0, 0), pointEast(5, 2000)]);
    expect(result.gapFilledCount).toBe(0);
    expect(result.bridgesSkipped).toBe(0);
  });

  it('bridges a realistic 55m gap at a plausible pace — no hole between consecutive fixes', () => {
    // 55m: empirically confirmed (see the git history of this test file) as
    // reliably needing an intermediate cell — res-11 cell CENTRES are only
    // ~25-45m apart, so smaller gaps can land in plain neighbours.
    const path = pathAtPace(2, 55, JOG_MS);
    const result = pathToTiles(path);

    const cellA = latLngToCell(path[0].lat, path[0].lng, DEFAULT_TILE_RES);
    const cellB = latLngToCell(path[1].lat, path[1].lng, DEFAULT_TILE_RES);
    expect(cellA).not.toBe(cellB);

    // The direct proof of "no gaps": every cell H3's own line function says
    // sits between the two fixes must be present in the result.
    const expectedLine = gridPathCells(cellA, cellB);
    for (const cell of expectedLine) expect(result.cells).toContain(cell);

    expect(result.gapFilledCount).toBeGreaterThan(0);
    expect(result.bridgesSkipped).toBe(0);
    expect(result.directCount).toBe(2);
  });

  it('a longer straight path at a plausible pace stays contiguous end to end', () => {
    // 10 fixes, 45m apart, at jogging pace — realistic spacing where
    // gap-filling matters at every step, not just once.
    const path = pathAtPace(10, 45, JOG_MS);
    const result = pathToTiles(path);

    for (let i = 1; i < path.length; i++) {
      const cellA = latLngToCell(path[i - 1].lat, path[i - 1].lng, DEFAULT_TILE_RES);
      const cellB = latLngToCell(path[i].lat, path[i].lng, DEFAULT_TILE_RES);
      for (const cell of gridPathCells(cellA, cellB)) {
        expect(result.cells).toContain(cell);
      }
    }
    expect(result.bridgesSkipped).toBe(0);
  });

  it('every claimed cell is within one grid step of some other claimed cell (no islands)', () => {
    const path = pathAtPace(8, 45, JOG_MS);
    const { cells } = pathToTiles(path);
    for (const cell of cells) {
      const hasNeighbour = cells.some((other) => other !== cell && gridDistance(cell, other) === 1);
      expect(hasNeighbour).toBe(true);
    }
  });

  it('an out-and-back over the same ~25m ground claims the same tiles both ways (idempotent)', () => {
    const a = pointEast(0, 0);
    const legMs = (25 / JOG_MS) * 1000;
    const b = pointEast(25, legMs);
    const forward = pathToTiles([a, b]);
    const outAndBack = pathToTiles([a, b, { ...a, ts: legMs * 2 }]);
    expect([...outAndBack.cells].sort()).toEqual([...forward.cells].sort());
  });

  it('resolves at DEFAULT_TILE_RES', () => {
    const result = pathToTiles([pointEast(0, 0)]);
    expect(getResolution(result.cells[0])).toBe(DEFAULT_TILE_RES);
  });

  it('accepts an explicit resolution override', () => {
    const result = pathToTiles([pointEast(0, 0)], 9);
    expect(getResolution(result.cells[0])).toBe(9);
  });

  it('a cell reached both directly and via gap-fill counts as direct, not double', () => {
    // A short zigzag that recrosses its own tile: fixes on either side of
    // one small cell, then a third fix landing back inside it directly.
    // All three legs at jogging pace, so the speed cap never interferes.
    const p0 = pointEast(0, 0);
    const p1 = pointEast(60, (60 / JOG_MS) * 1000);
    const p2 = pointEast(5, p1.ts + (55 / JOG_MS) * 1000);
    const result = pathToTiles([p0, p1, p2]);
    expect(result.directCount + result.gapFilledCount).toBe(result.cells.length);
  });

  it('bridgeFailures stays 0 on ordinary paths, including realistic gaps', () => {
    const path = pathAtPace(10, 45, JOG_MS);
    expect(pathToTiles(path).bridgeFailures).toBe(0);
  });

  it('counts a failed bridge rather than silently leaving an unobservable hole', () => {
    // gridPathCells genuinely throws only for cells far beyond anything a
    // real gap produces (empirically: thousands of km). The elapsed time
    // (60 days) keeps the IMPLIED SPEED under MAX_BRIDGE_SPEED_MS on
    // purpose — this must fail on gridPathCells's own distance limit, not
    // get intercepted by the speed cap first, or it would prove nothing
    // about bridgeFailures specifically.
    const here = pointEast(0, 0);
    const farAway: TilePoint = { lat: -LAT, lng: -LNG, ts: 60 * 24 * 60 * 60 * 1000 };
    const result = pathToTiles([here, farAway]);

    expect(result.bridgesSkipped).toBe(0);
    expect(result.bridgeFailures).toBe(1);
    // Fails OPEN: both endpoints are still claimed even though nothing
    // filled the (very real, very large) gap between them.
    expect(result.cells).toHaveLength(2);
    expect(result.directCount).toBe(2);
    expect(result.gapFilledCount).toBe(0);
  });
});

describe('the bridge speed cap (background-gap fix)', () => {
  // Reproduces b8's own measurement: bridging used to happen regardless of
  // implied speed, so a background-gap jump was bridged exactly like a
  // normal 30-50m throttle gap. A 2km jump claimed ~44 tiles (~95,000 m²)
  // of ground never run over — silently, since nothing THREW.
  const GAP_CASES: Array<[label: string, metres: number]> = [
    ['0m', 0],
    ['200m', 200],
    ['800m', 800],
    ['2000m', 2000],
  ];

  it.each(GAP_CASES)('a %s gap over a normal ~2s fix interval', (label, metres) => {
    // 2s matches the tracker's own real fix cadence (TIME_INTERVAL_MS,
    // tracking.ts) — the realistic shape of "the next recorded fix jumped
    // this far", background gap or not.
    const a = pointEast(0, 0);
    const b = pointEast(metres, 2000);
    const result = pathToTiles([a, b]);

    if (metres === 0) {
      // The 0m case must be UNCHANGED: no gap at all, nothing to skip or
      // fill either way.
      expect(result.bridgesSkipped).toBe(0);
      expect(result.gapFilledCount).toBe(0);
      return;
    }

    // Every non-zero case implies a wildly superhuman speed even at the
    // smallest (200m/2s = 100 m/s = 360 km/h) — all must be skipped,
    // claiming only the two directly-covered endpoints, per b8's ask:
    // "800m and 2000m must claim only the directly-covered tiles."
    expect(result.bridgesSkipped, `${label} gap should be skipped`).toBe(1);
    expect(result.gapFilledCount).toBe(0);
    expect(result.cells).toHaveLength(2);
    expect(result.directCount).toBe(2);
  });

  it('the same 2000m gap DOES bridge when the elapsed time makes it a plausible walk', () => {
    // The fix is a SPEED cap, not a distance cap — a long gap is fine if
    // enough real time passed to explain it. 2000m over 15 minutes is an
    // easy walking pace (~2.2 m/s), comfortably under MAX_BRIDGE_SPEED_MS.
    const a = pointEast(0, 0);
    const b = pointEast(2000, 15 * 60 * 1000);
    const result = pathToTiles([a, b]);
    expect(result.bridgesSkipped).toBe(0);
    expect(result.gapFilledCount).toBeGreaterThan(0);
  });

  it('MAX_BRIDGE_SPEED_MS matches the server anti-cheat threshold (25 km/h)', () => {
    // supabase/migrations/20260827_anti_cheat_flag.sql's max_kmh — reused
    // rather than a second, potentially-disagreeing number.
    expect(MAX_BRIDGE_SPEED_MS).toBeCloseTo(25 / 3.6, 5);
  });
});

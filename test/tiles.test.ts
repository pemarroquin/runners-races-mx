// pathToTiles — the core of the coverage-model migration (Tile Coverage
// Model brief §3, §6 step 1). Must-have cases per the brief: a straight
// path yields a contiguous cell run with no gaps; a stationary runner
// yields one cell; a 25m out-and-back yields the same cells both ways
// (idempotent).
import { getResolution, gridDistance, gridPathCells, latLngToCell } from 'h3-js';
import { describe, expect, it } from 'vitest';

import { DEFAULT_TILE_RES, pathToTiles } from '@/lib/tiles';
import type { LatLng } from '@/lib/territory';

// Monterrey-ish latitude, matching territory.test.ts's own fixtures.
const LAT = 25.67;
const LNG = -100.31;
// ~111,320m per degree latitude everywhere; longitude scales by cos(lat).
const M_PER_DEG_LAT = 111_320;
const M_PER_DEG_LNG = M_PER_DEG_LAT * Math.cos((LAT * Math.PI) / 180);

/** A point `metres` east of the fixed origin — keeps every fixture on one
 *  simple, inspectable line. */
function pointEast(metres: number): LatLng {
  return { lat: LAT, lng: LNG + metres / M_PER_DEG_LNG };
}

describe('pathToTiles', () => {
  it('returns nothing for an empty path', () => {
    const result = pathToTiles([]);
    expect(result.cells).toEqual([]);
    expect(result.directCount).toBe(0);
    expect(result.gapFilledCount).toBe(0);
    expect(result.bridgeFailures).toBe(0);
  });

  it('a single point yields exactly one cell, direct', () => {
    const result = pathToTiles([pointEast(0)]);
    expect(result.cells).toHaveLength(1);
    expect(result.directCount).toBe(1);
    expect(result.gapFilledCount).toBe(0);
    expect(result.cells[0]).toBe(latLngToCell(LAT, LNG, DEFAULT_TILE_RES));
  });

  it('a stationary runner (many fixes, same spot) yields one cell', () => {
    const path: LatLng[] = Array.from({ length: 20 }, () => pointEast(0));
    const result = pathToTiles(path);
    expect(result.cells).toHaveLength(1);
    expect(result.directCount).toBe(1);
    expect(result.gapFilledCount).toBe(0);
  });

  it('two fixes within the same tile need no gap-fill', () => {
    // A handful of metres — well inside one ~25m-edge res-11 cell.
    const result = pathToTiles([pointEast(0), pointEast(5)]);
    expect(result.gapFilledCount).toBe(0);
  });

  it('bridges a realistic 55m throttle gap — no hole between consecutive fixes', () => {
    // Matches the brief's own "30-50m apart" scenario: far enough that
    // gridPathCells has a real intermediate cell to fill (empirically
    // checked — res-11 cell CENTRES are only ~25-45m apart, so a naive
    // "further than one edge means a gap" assumption undershoots; 40m
    // still lands in plain neighbours with nothing between them, 55m
    // reliably does not).
    const a = pointEast(0);
    const b = pointEast(55);
    const result = pathToTiles([a, b]);

    const cellA = latLngToCell(a.lat, a.lng, DEFAULT_TILE_RES);
    const cellB = latLngToCell(b.lat, b.lng, DEFAULT_TILE_RES);
    expect(cellA).not.toBe(cellB);

    // The direct proof of "no gaps": every cell H3's own line function says
    // sits between the two fixes must be present in the result.
    const expectedLine = gridPathCells(cellA, cellB);
    for (const cell of expectedLine) expect(result.cells).toContain(cell);

    // And the fill actually did something — this is the number the tile
    // preview script reports to check whether §3's gotcha is load-bearing.
    expect(result.gapFilledCount).toBeGreaterThan(0);
    expect(result.directCount).toBe(2);
  });

  it('a longer straight path stays contiguous end to end', () => {
    // 10 fixes, 45m apart — realistic 2s/3m-throttle spacing for a runner
    // moving at an easy pace, and > one tile edge, so gap-filling matters
    // at every step, not just once.
    const path: LatLng[] = Array.from({ length: 10 }, (_, i) => pointEast(i * 45));
    const result = pathToTiles(path);

    for (let i = 1; i < path.length; i++) {
      const cellA = latLngToCell(path[i - 1].lat, path[i - 1].lng, DEFAULT_TILE_RES);
      const cellB = latLngToCell(path[i].lat, path[i].lng, DEFAULT_TILE_RES);
      for (const cell of gridPathCells(cellA, cellB)) {
        expect(result.cells).toContain(cell);
      }
    }
  });

  it('every claimed cell is within one grid step of some other claimed cell (no islands)', () => {
    // A weaker, path-independent sanity check on top of the pairwise proof
    // above: nothing in the result should be a stray cell with no
    // neighbour anywhere else in the set (which pairwise gridPathCells
    // containment already implies, but this catches it a different way).
    const path: LatLng[] = Array.from({ length: 8 }, (_, i) => pointEast(i * 45));
    const { cells } = pathToTiles(path);
    for (const cell of cells) {
      const hasNeighbour = cells.some((other) => other !== cell && gridDistance(cell, other) === 1);
      expect(hasNeighbour).toBe(true);
    }
  });

  it('an out-and-back over the same ~25m ground claims the same tiles both ways (idempotent)', () => {
    const a = pointEast(0);
    const b = pointEast(25);
    const forward = pathToTiles([a, b]);
    const outAndBack = pathToTiles([a, b, a]);
    expect([...outAndBack.cells].sort()).toEqual([...forward.cells].sort());
  });

  it('resolves at DEFAULT_TILE_RES', () => {
    const result = pathToTiles([pointEast(0)]);
    expect(getResolution(result.cells[0])).toBe(DEFAULT_TILE_RES);
  });

  it('accepts an explicit resolution override', () => {
    const result = pathToTiles([pointEast(0)], 9);
    expect(getResolution(result.cells[0])).toBe(9);
  });

  it('a cell reached both directly and via gap-fill counts as direct, not double', () => {
    // A short zigzag that recrosses its own tile: fixes on either side of
    // one small cell, then a third fix landing back inside it directly.
    const path: LatLng[] = [pointEast(0), pointEast(60), pointEast(5)];
    const result = pathToTiles(path);
    expect(result.directCount + result.gapFilledCount).toBe(result.cells.length);
  });

  it('bridgeFailures stays 0 on ordinary paths, including realistic gaps', () => {
    const path: LatLng[] = Array.from({ length: 10 }, (_, i) => pointEast(i * 45));
    expect(pathToTiles(path).bridgeFailures).toBe(0);
  });

  it('counts a failed bridge rather than silently leaving an unobservable hole', () => {
    // gridPathCells genuinely throws only for cells far beyond anything a
    // real gap produces (empirically: thousands of km, not the tens of km
    // a bad background-gap jump could plausibly cover) — a plain distance
    // check couldn't stand in for the real library call here, so this
    // exercises the actual throw path rather than asserting on a mock.
    const here = pointEast(0);
    const farAway = { lat: -LAT, lng: -LNG }; // antipodal-ish — thousands of km away
    const result = pathToTiles([here, farAway]);

    expect(result.bridgeFailures).toBe(1);
    // Fails OPEN: both endpoints are still claimed even though nothing
    // filled the (very real, very large) gap between them.
    expect(result.cells).toHaveLength(2);
    expect(result.directCount).toBe(2);
    expect(result.gapFilledCount).toBe(0);
  });
});

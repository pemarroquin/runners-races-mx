import { describe, expect, it } from 'vitest';

import { buildWallPolygon, splitTrailing } from '@/lib/fence-3d';
import { haversineM, pathDistanceM, type LatLng } from '@/lib/territory';

/** A straight north-heading track with ~11m between fixes. */
function northLine(count: number): LatLng[] {
  return Array.from({ length: count }, (_, i) => ({ lat: 25.67 + i * 0.0001, lng: -100.31 }));
}

describe('splitTrailing', () => {
  it('leaves everything active until the route is longer than the window', () => {
    const short = northLine(3); // ~22m total, well under a 100m window
    const { settled, active } = splitTrailing(short, 100);
    expect(settled).toEqual([]);
    expect(active).toBe(short);
  });

  it('splits at the requested distance back from the current position', () => {
    const points = northLine(40); // ~433m
    const { settled, active } = splitTrailing(points, 100);
    expect(settled.length).toBeGreaterThan(0);
    // The live edge covers at least the requested window (it splits on the
    // first fix that reaches it, so it can slightly overshoot, never under).
    expect(pathDistanceM(active)).toBeGreaterThanOrEqual(100);
    // ...but isn't wildly longer — one sample's worth of overshoot at most.
    expect(pathDistanceM(active)).toBeLessThan(100 + 15);
  });

  it('shares a join point so the line and the wall meet with no gap', () => {
    const points = northLine(40);
    const { settled, active } = splitTrailing(points, 100);
    expect(settled[settled.length - 1]).toEqual(active[0]);
  });

  it('never loses a point across the split', () => {
    const points = northLine(40);
    const { settled, active } = splitTrailing(points, 100);
    // The join is counted twice by design, hence the +1.
    expect(settled.length + active.length).toBe(points.length + 1);
  });

  it('handles a route too short to split at all', () => {
    expect(splitTrailing([], 100)).toEqual({ settled: [], active: [] });
    const one = [{ lat: 25.67, lng: -100.31 }];
    expect(splitTrailing(one, 100)).toEqual({ settled: [], active: one });
  });
});

describe('buildWallPolygon', () => {
  it('returns null when there is no line to thicken', () => {
    expect(buildWallPolygon([], 3)).toBeNull();
    expect(buildWallPolygon([{ lat: 25.67, lng: -100.31 }], 3)).toBeNull();
  });

  it('produces a closed ring with two sides per input point', () => {
    const points = northLine(5);
    const wall = buildWallPolygon(points, 3)!;
    const ring = wall.geometry.coordinates[0];
    expect(ring).toHaveLength(points.length * 2 + 1); // both sides + closing point
    expect(ring[0]).toEqual(ring[ring.length - 1]);
  });

  it('is the requested width across, not merely non-zero', () => {
    const points = northLine(5);
    const width = 3;
    const wall = buildWallPolygon(points, width)!;
    const ring = wall.geometry.coordinates[0];
    // First point of the left side vs. last of the right side — the two
    // offsets of the SAME input point, so their separation is the thickness.
    const left = { lng: ring[0][0], lat: ring[0][1] };
    const right = { lng: ring[ring.length - 2][0], lat: ring[ring.length - 2][1] };
    expect(haversineM(left, right)).toBeCloseTo(width, 1);
  });

  it('keeps the same thickness on an east-west run as a north-south one', () => {
    // The cos(latitude) correction exists for exactly this: without it an
    // east-west wall renders visibly thicker than a north-south one.
    const eastWest: LatLng[] = Array.from({ length: 5 }, (_, i) => ({
      lat: 25.67,
      lng: -100.31 + i * 0.0001,
    }));
    const wall = buildWallPolygon(eastWest, 3)!;
    const ring = wall.geometry.coordinates[0];
    const left = { lng: ring[0][0], lat: ring[0][1] };
    const right = { lng: ring[ring.length - 2][0], lat: ring[ring.length - 2][1] };
    expect(haversineM(left, right)).toBeCloseTo(3, 1);
  });
});

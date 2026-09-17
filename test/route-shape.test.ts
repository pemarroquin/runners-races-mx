import { describe, expect, it } from 'vitest';

import { routeToSvgPath } from '@/lib/route-shape';
import type { LatLng } from '@/lib/territory';

const SQUARE: LatLng[] = [
  { lat: 25.67, lng: -100.31 },
  { lat: 25.671, lng: -100.31 },
  { lat: 25.671, lng: -100.309 },
  { lat: 25.67, lng: -100.309 },
];

describe('routeToSvgPath', () => {
  it('returns empty for fewer than 2 points', () => {
    expect(routeToSvgPath([], 300, 300, 30).empty).toBe(true);
    expect(routeToSvgPath([SQUARE[0]], 300, 300, 30).empty).toBe(true);
  });

  it('starts with M and draws one segment per remaining point', () => {
    const shape = routeToSvgPath(SQUARE, 300, 300, 30);
    expect(shape.empty).toBe(false);
    const commands = shape.d.split(' ').filter((tok) => tok === 'M' || tok === 'L');
    expect(commands).toEqual(['M', 'L', 'L', 'L']);
  });

  it('fits every point inside the padded box', () => {
    const width = 300;
    const height = 300;
    const padding = 30;
    const shape = routeToSvgPath(SQUARE, width, height, padding);
    const coords = shape.d
      .split(/[ML]/)
      .map((s) => s.trim())
      .filter(Boolean)
      .map((pair) => pair.split(' ').map(Number));
    for (const [x, y] of coords) {
      expect(x).toBeGreaterThanOrEqual(padding - 0.01);
      expect(x).toBeLessThanOrEqual(width - padding + 0.01);
      expect(y).toBeGreaterThanOrEqual(padding - 0.01);
      expect(y).toBeLessThanOrEqual(height - padding + 0.01);
    }
  });

  it('preserves aspect ratio — a taller-than-wide route is not stretched to fill a square box', () => {
    // A route running due north for 200m then 0m east: spanY (lat) >> spanX
    // (lng, which is 0 here). Squashing it to fill both axes would make a
    // straight line look diagonal.
    const tall: LatLng[] = [
      { lat: 25.67, lng: -100.31 },
      { lat: 25.672, lng: -100.31 },
    ];
    const shape = routeToSvgPath(tall, 300, 300, 0);
    const [[x0], [x1]] = shape.d
      .split(/[ML]/)
      .map((s) => s.trim())
      .filter(Boolean)
      .map((pair) => pair.split(' ').map(Number));
    expect(x0).toBeCloseTo(x1, 5);
  });

  it('flips latitude so north is up (smaller y) on screen', () => {
    const northSouth: LatLng[] = [
      { lat: 25.67, lng: -100.31 }, // south point, recorded first
      { lat: 25.672, lng: -100.31 }, // north point, recorded second
    ];
    const shape = routeToSvgPath(northSouth, 300, 300, 30);
    const [[, ySouth], [, yNorth]] = shape.d
      .split(/[ML]/)
      .map((s) => s.trim())
      .filter(Boolean)
      .map((pair) => pair.split(' ').map(Number));
    expect(yNorth).toBeLessThan(ySouth);
  });
});

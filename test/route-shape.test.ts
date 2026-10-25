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

describe('routeToSvgPath — unrecorded gaps', () => {
  const leg = (fromTs: number, fromLng: number, n: number) =>
    Array.from({ length: n }, (_, i) => ({ lat: 25.66, lng: fromLng + i * 0.00006, ts: fromTs + i * 2000 }));

  it('starts a new subpath across a gap the shared plan refuses to bridge', () => {
    const a = leg(0, -100.3, 50);
    const b = leg(a[a.length - 1].ts + 600_000, -100.28, 50); // ~2 km jump, 10 min
    const { d } = routeToSvgPath([...a, ...b], 100, 100, 0);
    expect(d.match(/M /g)).toHaveLength(2);
  });

  it('draws one line for a continuous timed run', () => {
    const { d } = routeToSvgPath(leg(0, -100.3, 50), 100, 100, 0);
    expect(d.match(/M /g)).toHaveLength(1);
  });

  it('draws one line for untimed points, as before', () => {
    const a = leg(0, -100.3, 5).map(({ lat, lng }) => ({ lat, lng }));
    const b = leg(0, -100.28, 5).map(({ lat, lng }) => ({ lat, lng }));
    const { d } = routeToSvgPath([...a, ...b], 100, 100, 0);
    expect(d.match(/M /g)).toHaveLength(1);
  });
});

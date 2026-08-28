import area from '@turf/area';
import { polygon } from '@turf/helpers';
import { describe, expect, it } from 'vitest';

import {
  buildFence,
  closeRing,
  cleanPolygon,
  haversineM,
  pathDistanceM,
  type LatLng,
} from '@/lib/territory';
import { decimate } from '@/lib/mapbox';
import { formatArea, formatDistance, formatDuration } from '@/lib/tracking';

// A simple square loop, ~100m per side near Monterrey's latitude, given as
// [lat,lng] the way expo-location reports it — deliberately NOT closed
// (last point != first), since that's what a real recorded run looks like.
const SQUARE_OPEN: LatLng[] = [
  { lat: 25.67, lng: -100.31 },
  { lat: 25.671, lng: -100.31 },
  { lat: 25.671, lng: -100.309 },
  { lat: 25.67, lng: -100.309 },
];

// The bowtie/hourglass trap: (0,0)→(2,0)→(0,2)→(2,2)→close-to-(0,0) crosses
// itself at the center. This is the shape the feature plan calls out —
// `@turf/area` on the raw ring doesn't error, it just silently answers a
// question different from "how much ground did this route enclose."
const BOWTIE: LatLng[] = [
  { lat: 25.67, lng: -100.31 },
  { lat: 25.67, lng: -100.308 },
  { lat: 25.672, lng: -100.31 },
  { lat: 25.672, lng: -100.308 },
];

describe('closeRing', () => {
  it('appends the start point when the path is open', () => {
    const coords = SQUARE_OPEN.map((p): [number, number] => [p.lng, p.lat]);
    const closed = closeRing(coords);
    expect(closed.length).toBe(coords.length + 1);
    expect(closed[closed.length - 1]).toEqual(closed[0]);
  });

  it('is a no-op when the path is already closed', () => {
    const coords = SQUARE_OPEN.map((p): [number, number] => [p.lng, p.lat]);
    const alreadyClosed = [...coords, coords[0]];
    expect(closeRing(alreadyClosed)).toEqual(alreadyClosed);
  });
});

describe('cleanPolygon', () => {
  it('leaves a simple (non-self-intersecting) polygon untouched', () => {
    const coords = SQUARE_OPEN.map((p): [number, number] => [p.lng, p.lat]);
    const simple = polygon([closeRing(coords)]);
    expect(cleanPolygon(simple)).toBe(simple); // same reference — true no-op, not just equal
  });
});

describe('buildFence', () => {
  it('matches turf area() directly on a simple closed square', () => {
    const fence = buildFence(SQUARE_OPEN, 0); // tolerance 0: skip simplification noise for this check
    expect(fence).not.toBeNull();

    const coords = SQUARE_OPEN.map((p): [number, number] => [p.lng, p.lat]);
    const manuallyClosed = polygon([closeRing(coords)]);
    expect(fence!.areaM2).toBeCloseTo(area(manuallyClosed), 6);
  });

  it('a self-intersecting bowtie produces a different area than the naive raw shoelace, and it is positive', () => {
    const fence = buildFence(BOWTIE, 0);
    expect(fence).not.toBeNull();
    expect(fence!.areaM2).toBeGreaterThan(0);

    const coords = BOWTIE.map((p): [number, number] => [p.lng, p.lat]);
    const naiveRaw = polygon([closeRing(coords)]);
    const naiveArea = area(naiveRaw);

    // The whole point of the cleaning step: this must NOT just equal the
    // naive shoelace answer on the crossed ring. If it ever does, the
    // kinks()/unkink()/union() path silently stopped doing anything.
    expect(fence!.areaM2).not.toBeCloseTo(naiveArea, 0);
  });

  it('area is unchanged by which point the runner happened to start from', () => {
    // The fence is the ground enclosed, so rotating the same loop's starting
    // point must not change its size. This is the cheapest guard against the
    // auto-close step (closeRing) quietly attaching the closing segment in
    // the wrong place.
    const rotated = [...SQUARE_OPEN.slice(2), ...SQUARE_OPEN.slice(0, 2)];
    const a = buildFence(SQUARE_OPEN, 0);
    const b = buildFence(rotated, 0);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(b!.areaM2).toBeCloseTo(a!.areaM2, 6);
  });

  it('returns null for a path with too few distinct points to fence', () => {
    expect(buildFence([{ lat: 25.67, lng: -100.31 }])).toBeNull();
    expect(buildFence([])).toBeNull();
    // Two points, one repeated (a runner who barely moved before stopping).
    expect(
      buildFence([
        { lat: 25.67, lng: -100.31 },
        { lat: 25.67, lng: -100.31 },
      ]),
    ).toBeNull();
  });
});

describe('haversineM', () => {
  // One degree of latitude is ~111.19 km everywhere, which makes it the one
  // distance that can be checked against a known constant rather than
  // against the function's own output.
  it('matches the known length of one degree of latitude', () => {
    const d = haversineM({ lat: 25, lng: -100 }, { lat: 26, lng: -100 });
    expect(d).toBeGreaterThan(111_000);
    expect(d).toBeLessThan(111_400);
  });

  // A lat/lng swap is the classic silent bug in this kind of code: it still
  // returns a plausible-looking positive number. At MTY's latitude a degree
  // of longitude is ~100km, clearly distinct from latitude's ~111km.
  it('is not symmetric under swapping lat and lng', () => {
    const byLat = haversineM({ lat: 25, lng: -100 }, { lat: 26, lng: -100 });
    const byLng = haversineM({ lat: 25, lng: -100 }, { lat: 25, lng: -99 });
    expect(byLng).toBeLessThan(byLat * 0.95);
  });

  it('is zero for a point against itself, and symmetric', () => {
    const a = { lat: 25.67, lng: -100.31 };
    const b = { lat: 25.68, lng: -100.32 };
    expect(haversineM(a, a)).toBe(0);
    expect(haversineM(a, b)).toBeCloseTo(haversineM(b, a), 9);
  });
});

describe('pathDistanceM', () => {
  it('sums the legs, and is route length rather than fence perimeter', () => {
    const path: LatLng[] = [
      { lat: 25.67, lng: -100.31 },
      { lat: 25.671, lng: -100.31 },
      { lat: 25.671, lng: -100.309 },
    ];
    const expected =
      haversineM(path[0], path[1]) + haversineM(path[1], path[2]);
    expect(pathDistanceM(path)).toBeCloseTo(expected, 9);
    // Explicitly NOT closed: the synthetic segment back to the start is part
    // of the fence, never part of how far the runner actually ran.
    expect(pathDistanceM(path)).toBeLessThan(expected + haversineM(path[2], path[0]));
  });

  it('is zero for an empty or single-point path', () => {
    expect(pathDistanceM([])).toBe(0);
    expect(pathDistanceM([{ lat: 25.67, lng: -100.31 }])).toBe(0);
  });
});

describe('formatters', () => {
  it('switches distance units at 1 km', () => {
    expect(formatDistance(840)).toBe('840 m');
    expect(formatDistance(999)).toBe('999 m');
    expect(formatDistance(1000)).toBe('1.00 km');
    expect(formatDistance(5421)).toBe('5.42 km');
  });

  it('pads the clock and only shows hours once there are any', () => {
    expect(formatDuration(9)).toBe('0:09');
    expect(formatDuration(75)).toBe('1:15');
    expect(formatDuration(600)).toBe('10:00');
    expect(formatDuration(3661)).toBe('1:01:01');
  });

  it('never renders a real area as 0.00 km²', () => {
    // The reason the unit switches at all: a first run encloses a few
    // thousand m², which in km² would round to a demoralising 0.00.
    expect(formatArea(8400)).toBe('8,400 m²');
    expect(formatArea(1_240_000)).toBe('1.24 km²');
  });

  it('clamps negative durations rather than emitting a negative clock', () => {
    expect(formatDuration(-5)).toBe('0:00');
  });
});

describe('decimate', () => {
  it('leaves a short list untouched', () => {
    const items = [1, 2, 3];
    expect(decimate(items, 100)).toBe(items);
  });

  it('thins to the cap while keeping the first and last', () => {
    const items = Array.from({ length: 500 }, (_, i) => i);
    const out = decimate(items, 100);
    expect(out).toHaveLength(100);
    // The route has to still start and end where the run did — dropping
    // either end would draw a line that stops short of the runner.
    expect(out[0]).toBe(0);
    expect(out[out.length - 1]).toBe(499);
  });

  it('keeps the order it was given', () => {
    const out = decimate(Array.from({ length: 300 }, (_, i) => i), 50);
    const ascending = out.every((v, i) => i === 0 || v > out[i - 1]);
    expect(ascending).toBe(true);
  });
});

// Degenerate shapes. These are not edge cases dreamed up for coverage: a
// straight there-and-stop walk is the most ordinary thing a person can do
// with a tracking app, and until 2026-08-27 it CRASHED the Track tab —
// simplify() threw "invalid polygon, fewer than 4 points" from inside turf
// during render, at the moment the runner pressed Stop.
describe('buildFence on shapes that enclose nothing', () => {
  const O = { lat: 25.6866, lng: -100.3161 };
  const m = (n: number) => n / 111_320;

  it('returns null for a straight walk instead of throwing', () => {
    const straight = Array.from({ length: 15 }, (_, i) => ({ lat: O.lat + m(i * 3.5), lng: O.lng }));
    expect(() => buildFence(straight)).not.toThrow();
    expect(buildFence(straight)).toBeNull();
  });

  it('returns null for an out-and-back along the same path', () => {
    const out = Array.from({ length: 15 }, (_, i) => ({ lat: O.lat + m(i * 3.5), lng: O.lng }));
    expect(() => buildFence([...out, ...out.slice().reverse()])).not.toThrow();
    expect(buildFence([...out, ...out.slice().reverse()])).toBeNull();
  });

  it('never returns a zero-area fence', () => {
    // A 0 m² territory is not something to offer the runner a Save button for.
    const straight = Array.from({ length: 8 }, (_, i) => ({ lat: O.lat + m(i * 10), lng: O.lng }));
    const fence = buildFence(straight);
    expect(fence === null || fence.areaM2 > 0).toBe(true);
  });

  it('still builds a real fence from a small loop', () => {
    const loop = [
      ...Array.from({ length: 10 }, (_, i) => ({ lat: O.lat + m(i * 5), lng: O.lng })),
      ...Array.from({ length: 6 }, (_, i) => ({ lat: O.lat + m(50), lng: O.lng + m(i * 5) })),
      ...Array.from({ length: 10 }, (_, i) => ({ lat: O.lat + m(50 - i * 5), lng: O.lng + m(30) })),
      ...Array.from({ length: 6 }, (_, i) => ({ lat: O.lat, lng: O.lng + m(30 - i * 5) })),
    ];
    const fence = buildFence(loop);
    expect(fence).not.toBeNull();
    expect(fence!.areaM2).toBeGreaterThan(500);
  });
});

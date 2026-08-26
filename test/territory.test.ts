import area from '@turf/area';
import { polygon } from '@turf/helpers';
import { describe, expect, it } from 'vitest';

import { buildFence, closeRing, cleanPolygon, type LatLng } from '@/lib/territory';

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

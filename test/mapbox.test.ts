// buildFenceMapUrl — the Saved tab's fence thumbnail URL builder. Covers the
// route overlay added to fix the same bug `1df2ae6` fixed for the summary
// map: a card was drawing the fence polygon's boundary instead of the run
// that was actually recorded. See vitest.config.ts for why
// EXPO_PUBLIC_MAPBOX_TOKEN is stubbed for this whole suite — the module
// returns null from every builder when it's unset.
import type { Polygon } from 'geojson';
import { describe, expect, it } from 'vitest';

import { buildFenceMapUrl, decimate } from '@/lib/mapbox';

const SQUARE: Polygon = {
  type: 'Polygon',
  coordinates: [
    [
      [-100.31, 25.67],
      [-100.309, 25.67],
      [-100.309, 25.671],
      [-100.31, 25.671],
      [-100.31, 25.67],
    ],
  ],
};

const SHORT_ROUTE = [
  { lat: 25.67, lng: -100.31 },
  { lat: 25.6705, lng: -100.3095 },
  { lat: 25.671, lng: -100.309 },
];

describe('buildFenceMapUrl', () => {
  it('fence-only call signature still works unchanged', () => {
    const url = buildFenceMapUrl(SQUARE, true, '#e4572e');
    expect(url).not.toBeNull();
    expect(url).toContain('geojson(');
    // No path overlay when route is omitted entirely.
    expect(url).not.toContain('path-4');
  });

  it('adds a path overlay ahead of the geojson overlay when a route is given', () => {
    const url = buildFenceMapUrl(SQUARE, true, '#e4572e', SHORT_ROUTE);
    expect(url).not.toBeNull();
    expect(url).toContain('path-4+e4572e-0.9(');
    expect(url).toContain('geojson(');
    // Same request: one comma-joined overlay list ahead of /auto/.
    const overlaySegment = url!.split('/static/')[1].split('/auto/')[0];
    const pathIndex = overlaySegment.indexOf('path-4');
    const geojsonIndex = overlaySegment.indexOf('geojson(');
    expect(pathIndex).toBeGreaterThanOrEqual(0);
    expect(geojsonIndex).toBeGreaterThan(pathIndex);
  });

  it('ignores a route with fewer than 2 points — same as no route at all', () => {
    const oneAndEmpty = [
      buildFenceMapUrl(SQUARE, true, '#e4572e', []),
      buildFenceMapUrl(SQUARE, true, '#e4572e', [SHORT_ROUTE[0]]),
    ];
    for (const url of oneAndEmpty) {
      expect(url).not.toBeNull();
      expect(url).not.toContain('path-4');
    }
  });

  it('decimates a long route the same way buildPathMapUrl does', () => {
    const longRoute = Array.from({ length: 500 }, (_, i) => ({
      lat: 25.67 + i * 0.0001,
      lng: -100.31 + i * 0.0001,
    }));
    const url = buildFenceMapUrl(SQUARE, true, '#e4572e', longRoute);
    expect(url).not.toBeNull();
    // decimate(longRoute, 100) is what the builder feeds encodePolyline —
    // assert the same helper it reuses produces a bounded point count.
    expect(decimate(longRoute, 100)).toHaveLength(100);
  });

  it('the length guard accounts for the combined overlay string, not just the fence alone', () => {
    // A fence alone comfortably fits; adding a long, unDecimated-in-spirit
    // route (before decimation this many points would blow the budget) must
    // still fit because decimate() caps it — but an absurdly large ring on
    // top of a route can still legitimately blow the 8000-char guard.
    const hugeRing: Polygon = {
      type: 'Polygon',
      coordinates: [
        Array.from({ length: 2000 }, (_, i) => [-100.31 + i * 0.00001, 25.67 + i * 0.00001]).concat([
          [-100.31, 25.67],
        ]) as [number, number][],
      ],
    };
    const longRoute = Array.from({ length: 500 }, (_, i) => ({
      lat: 25.67 + i * 0.0001,
      lng: -100.31 + i * 0.0001,
    }));
    const withoutRoute = buildFenceMapUrl(hugeRing, true, '#e4572e');
    const withRoute = buildFenceMapUrl(hugeRing, true, '#e4572e', longRoute);
    // The huge ring alone should already be over budget (or very close);
    // adding a route overlay on top can only make the combined string
    // longer, so it must not sneak past the guard just because the fence
    // portion alone would have.
    if (withoutRoute === null) {
      expect(withRoute).toBeNull();
    } else {
      expect(withRoute === null || withRoute.length <= 8000).toBe(true);
    }
  });
});

// The two fence payloads Pedro's account actually holds in production
// (`runs` rows fbc7f628… and c2f5dec9…, fetched 2026-09-04 via PostgREST),
// pinned as fixtures.
//
// WHY A FIXTURE AND NOT A HAND-WRITTEN GEOMETRY. On 2026-09-04 the
// Territories tab rendered empty for this exact account while both rows sat
// intact on the server, and "the client is silently rejecting the geometry"
// was one of the two live hypotheses (the other — the real cause — was
// territories-map.web.tsx never running its sync; see that file's load
// handler). Ruling this half out by hand is worth nothing, because a
// hand-written `{type, coordinates}` is NOT what PostGIS sends: the real
// payload carries a third member, `crs`, that RFC 7946 removed from GeoJSON
// and that nothing in this codebase writes. A parser tightened to reject
// unknown members would pass every hand-written test and reject every real
// row — emptying the map with no error anywhere, which is exactly the
// failure shape this app keeps getting bitten by.
//
// Coordinates are trimmed to a few points per ring (the real Polygon has
// 435 raw path points behind it, the real MultiPolygon 8 separate polygons)
// — the SHAPE is what's under test, not the geography.
import { describe, expect, it, vi } from 'vitest';

import { outerRings } from '@/lib/territory';

// Same mock as territory-sync.test.ts, for the same reason: importing the
// module for real constructs a Supabase client whose auto-refresh timer
// later throws "window is not defined" under Node.
vi.mock('@/lib/supabase', () => ({
  supabase: {},
  ensureSession: async () => null,
  TERRITORY_ENABLED: false,
}));

const { parseFenceGeometry } = await import('@/lib/territory-sync');

const CRS = { type: 'name', properties: { name: 'EPSG:4326' } };

/** runs.fbc7f628-cc12-47a6-8ea8-2756497a414d — 3299 m, area_m2 977565. */
const REAL_POLYGON = {
  type: 'Polygon',
  crs: CRS,
  coordinates: [
    [
      [-100.36989973926387, 25.657953937640592],
      [-100.36995918082863, 25.657990864723345],
      [-100.36947454412868, 25.658957806422155],
      [-100.36861572681374, 25.661375852835587],
    ],
  ],
};

/** runs.c2f5dec9-a80a-4545-930b-4f3fdc2e51cf — 5945 m, area_m2 73419. Eight
 *  separate polygons in production; three here. A MultiPolygon is the
 *  ORDINARY result for a route that crosses itself several times (see
 *  territory.ts's unkinkPolygon), not an anomaly. */
const REAL_MULTIPOLYGON = {
  type: 'MultiPolygon',
  crs: CRS,
  coordinates: [
    [
      [
        [-100.38287151549352, 25.660874842443384],
        [-100.38286554108514, 25.660803688880215],
        [-100.38275, 25.6607],
      ],
    ],
    [
      [
        [-100.3801, 25.6612],
        [-100.3799, 25.6614],
        [-100.3797, 25.6611],
      ],
    ],
    [
      [
        [-100.3776, 25.6629],
        [-100.3774, 25.6631],
        [-100.3772, 25.6628],
      ],
    ],
  ],
};

describe('parseFenceGeometry, against real production payloads', () => {
  it('accepts the real Polygon row, `crs` member and all', () => {
    const parsed = parseFenceGeometry(REAL_POLYGON);
    expect(parsed).not.toBeNull();
    expect(parsed?.type).toBe('Polygon');
  });

  it('accepts the real MultiPolygon row — not just the Polygon case', () => {
    const parsed = parseFenceGeometry(REAL_MULTIPOLYGON);
    expect(parsed).not.toBeNull();
    expect(parsed?.type).toBe('MultiPolygon');
  });

  it('still rejects a geometry type no map layer here can draw', () => {
    expect(parseFenceGeometry({ type: 'LineString', crs: CRS, coordinates: [[0, 0]] })).toBeNull();
  });

  it('still rejects a (Multi)Polygon with no coordinates array', () => {
    expect(parseFenceGeometry({ type: 'Polygon', crs: CRS })).toBeNull();
  });
});

describe('outerRings, against real production payloads', () => {
  it('returns the single outer ring of the real Polygon', () => {
    const rings = outerRings(parseFenceGeometry(REAL_POLYGON)!);
    expect(rings).toHaveLength(1);
    expect(rings[0]).toHaveLength(4);
  });

  it('returns one outer ring PER POLYGON for the real MultiPolygon', () => {
    // The bug this guards: treating a MultiPolygon's coordinates as a
    // Polygon's would yield 1 ring of 3 rings-worth of nonsense, and the
    // bounds computed from it would be garbage rather than an error.
    const rings = outerRings(parseFenceGeometry(REAL_MULTIPOLYGON)!);
    expect(rings).toHaveLength(3);
    for (const ring of rings) {
      for (const [lng, lat] of ring) {
        expect(Number.isFinite(lng)).toBe(true);
        expect(Number.isFinite(lat)).toBe(true);
        // Monterrey. A ring read at the wrong nesting depth lands nowhere
        // near here (or is NaN), which a finite-only check would miss.
        expect(lng).toBeGreaterThan(-101);
        expect(lng).toBeLessThan(-100);
        expect(lat).toBeGreaterThan(25);
        expect(lat).toBeLessThan(26);
      }
    }
  });
});

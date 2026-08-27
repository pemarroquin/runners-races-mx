// fence-draw.ts + the fence colour selection — pure helpers behind the
// native fence rendering. The colour test matters most: fenceColorForRun
// must be deterministic from started_at alone, because that is the ONLY
// thing tying the live ribbon, the summary highlight, and the Saved tab to
// the same colour (there is no colour column in Supabase, on purpose).
import type { MultiPolygon, Polygon } from 'geojson';
import { describe, expect, it } from 'vitest';

import {
  FENCE_COLOR_SETS,
  fenceColorForRun,
  ROUTE_GRADIENT,
  withAlpha,
} from '../src/constants/map';
import {
  gradientColorAt,
  gradientStrokeColors,
  polygonRings,
  ringToCoords,
} from '../src/lib/fence-draw';

describe('fenceColorForRun', () => {
  it('is deterministic for the same start time', () => {
    const t = Date.parse('2026-08-27T14:00:00Z');
    expect(fenceColorForRun(t)).toEqual(fenceColorForRun(t));
  });

  it('ignores sub-second precision — Postgres round-trips ms, the choice must not depend on it', () => {
    const t = Date.parse('2026-08-27T14:00:00Z');
    expect(fenceColorForRun(t)).toEqual(fenceColorForRun(t + 999));
  });

  it('always returns a set from the configured list', () => {
    for (const t of [0, 1, 1756303200000, Number.MAX_SAFE_INTEGER]) {
      expect(FENCE_COLOR_SETS).toContain(fenceColorForRun(t));
    }
  });
});

describe('withAlpha', () => {
  it('converts hex + alpha to rgba()', () => {
    expect(withAlpha('#8A2BE2', 0.55)).toBe('rgba(138, 43, 226, 0.55)');
  });
});

describe('gradientColorAt', () => {
  it('hits the exact stop colours at their offsets', () => {
    for (const [offset, color] of ROUTE_GRADIENT) {
      expect(gradientColorAt(offset).toUpperCase()).toBe(color.toUpperCase());
    }
  });

  it('clamps outside [0,1]', () => {
    expect(gradientColorAt(-1).toUpperCase()).toBe(ROUTE_GRADIENT[0][1].toUpperCase());
    expect(gradientColorAt(2).toUpperCase()).toBe(
      ROUTE_GRADIENT[ROUTE_GRADIENT.length - 1][1].toUpperCase(),
    );
  });
});

describe('gradientStrokeColors', () => {
  it('returns one colour per vertex, tail-to-head', () => {
    const colors = gradientStrokeColors(5);
    expect(colors).toHaveLength(5);
    expect(colors[0].toUpperCase()).toBe(ROUTE_GRADIENT[0][1].toUpperCase());
    expect(colors[4].toUpperCase()).toBe(
      ROUTE_GRADIENT[ROUTE_GRADIENT.length - 1][1].toUpperCase(),
    );
  });

  it('handles degenerate counts', () => {
    expect(gradientStrokeColors(0)).toEqual([]);
    expect(gradientStrokeColors(1)).toHaveLength(1);
  });
});

describe('polygonRings / ringToCoords', () => {
  const square: Polygon = {
    type: 'Polygon',
    coordinates: [
      [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
        [0, 0],
      ],
    ],
  };

  it('wraps a Polygon as a single polygon', () => {
    expect(polygonRings(square)).toHaveLength(1);
    expect(polygonRings(square)[0][0]).toHaveLength(5);
  });

  it('flattens a MultiPolygon into its polygons', () => {
    const multi: MultiPolygon = {
      type: 'MultiPolygon',
      coordinates: [square.coordinates, square.coordinates],
    };
    expect(polygonRings(multi)).toHaveLength(2);
  });

  it('converts [lng,lat] to {latitude,longitude} — the order swap that silently lands on the wrong side of the planet otherwise', () => {
    expect(ringToCoords([[-100.3, 25.7]])).toEqual([{ latitude: 25.7, longitude: -100.3 }]);
  });
});

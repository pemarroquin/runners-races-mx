// Privacy-zone masking. The jitter tests are the important ones: a fixed
// clip radius puts every run's first surviving point on one circle centred
// on the runner's home, which is how Strava's privacy zones were defeated.
// Anything that "simplifies" jitteredRadius to a constant fails here.
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_ZONE_RADIUS_M,
  isInsideZone,
  jitteredRadius,
  maskPath,
  ZONE_JITTER_FRACTION,
  type PrivacyZone,
} from '../src/lib/privacy-zone';
import { haversineM } from '../src/lib/territory';
import type { TrackPoint } from '../src/lib/tracking';

const HOME = { lat: 25.6866, lng: -100.3161 };
const ZONE: PrivacyZone = { home: HOME, radiusM: 200 };

/** A point `metres` due north of home. */
function north(metres: number, ts = 0): TrackPoint {
  return { lat: HOME.lat + metres / 111_320, lng: HOME.lng, ts };
}

/** Out-and-back: starts at home, goes north to `peakM`, returns. */
function outAndBack(peakM: number, step = 100): TrackPoint[] {
  const pts: TrackPoint[] = [];
  let ts = 0;
  for (let d = 0; d <= peakM; d += step) pts.push(north(d, ts++));
  for (let d = peakM - step; d >= 0; d -= step) pts.push(north(d, ts++));
  return pts;
}

describe('jitteredRadius', () => {
  it('never cuts less than the nominal radius', () => {
    expect(jitteredRadius(200, () => 0)).toBe(200);
  });

  it('extends by at most the jitter fraction', () => {
    expect(jitteredRadius(200, () => 1)).toBeCloseTo(200 * (1 + ZONE_JITTER_FRACTION), 6);
  });

  it('varies between calls — a constant would put every endpoint on one circle', () => {
    const values = new Set(Array.from({ length: 50 }, () => jitteredRadius(200)));
    expect(values.size).toBeGreaterThan(1);
  });
});

describe('maskPath', () => {
  it('does nothing without a zone', () => {
    const path = outAndBack(1000);
    const result = maskPath(path, null);
    expect(result.points).toEqual(path);
    expect(result.masked).toBe(false);
  });

  it('removes every point inside the cut radius, at both ends', () => {
    const result = maskPath(outAndBack(1000), ZONE, () => 0);
    expect(result.masked).toBe(true);
    for (const p of result.points) {
      expect(haversineM(HOME, p)).toBeGreaterThan(ZONE.radiusM);
    }
  });

  it('keeps the middle of the run intact', () => {
    const result = maskPath(outAndBack(1000), ZONE, () => 0);
    // The 1000m peak is far outside the zone and must survive.
    const peak = Math.max(...result.points.map((p) => haversineM(HOME, p)));
    expect(peak).toBeCloseTo(1000, -1);
  });

  it('trims by distance, not by a fixed point count', () => {
    // Many tightly-spaced fixes near home (a slow warm-up) then a long leg.
    const dense: TrackPoint[] = [];
    let ts = 0;
    for (let d = 0; d <= 190; d += 10) dense.push(north(d, ts++));
    dense.push(north(900, ts++));
    const result = maskPath(dense, ZONE, () => 0);
    // All 20 warm-up points sit inside the zone and must all go.
    expect(result.trimmedStart).toBe(20);
    expect(result.points).toHaveLength(1);
  });

  it('reports a run entirely inside the zone instead of returning a stub', () => {
    const result = maskPath(outAndBack(150), ZONE, () => 0);
    expect(result.fullyInsideZone).toBe(true);
    expect(result.points).toHaveLength(0);
  });

  it('leaves a run that never enters the zone untouched', () => {
    const far: TrackPoint[] = [north(5000, 0), north(5100, 1), north(5200, 2)];
    const result = maskPath(far, ZONE, () => 0);
    expect(result.points).toHaveLength(3);
    expect(result.masked).toBe(false);
  });

  it('resists triangulation: repeated runs do not share one endpoint radius', () => {
    // The actual attack. With a fixed cut, every run's first surviving point
    // lands at the same distance from home, and three such points give up
    // the centre exactly. Jitter must spread them out.
    const distances = Array.from({ length: 30 }, () => {
      const result = maskPath(outAndBack(2000, 10), ZONE);
      return Math.round(haversineM(HOME, result.points[0]));
    });
    expect(new Set(distances).size).toBeGreaterThan(3);
  });

  it('never returns a surviving point closer than the nominal radius', () => {
    // Jitter may only ever cut MORE, never less — otherwise the zone is
    // smaller than the runner was told.
    for (let i = 0; i < 30; i++) {
      const result = maskPath(outAndBack(2000, 10), ZONE);
      for (const p of result.points) {
        expect(haversineM(HOME, p)).toBeGreaterThan(ZONE.radiusM);
      }
    }
  });
});

describe('isInsideZone', () => {
  it('uses the nominal radius, not the jittered one', () => {
    expect(isInsideZone(north(100), ZONE)).toBe(true);
    expect(isInsideZone(north(300), ZONE)).toBe(false);
  });

  it('is false with no zone set', () => {
    expect(isInsideZone(north(1), null)).toBe(false);
  });
});

describe('defaults', () => {
  it('matches the agreed 200m', () => {
    expect(DEFAULT_ZONE_RADIUS_M).toBe(200);
  });
});

// The pace guard, replayed against THREE REAL RECORDED RUNS.
//
// Two are Pedro driving a car (2026-09-03 and 09-02) and one is a genuine
// 52-minute walk/jog. They are the actual `raw_path` rows pulled from the
// live database before the cheat runs were deleted — fixtures/path-*.json,
// [lat, lng, epochMs] triples, coordinates rounded to 6dp (~11 cm).
//
// Synthetic fixtures cannot do this job. The whole difficulty of the feature
// is that a real run contains GPS artefacts indistinguishable from cheating
// if you look at any single fix — the honest run here has a segment at
// 171 km/h — and nobody writing a fake path by hand puts one in. The cost of
// a false positive is ending a real runner's session and deleting their run,
// so the guard has to be proven against real noise.
//
// See Source Data/Outputs/Running App/ANTI-CHEAT-EVIDENCE.md.
import { describe, expect, it } from 'vitest';

import { isImpossiblePace, maxSustainedKmh, PACE_GUARD_KMH } from '@/lib/pace-guard';
import type { TrackPoint } from '@/lib/tracking';

import driveSep3 from './fixtures/path-drive-sep3.json';
import driveSep2 from './fixtures/path-drive-sep2.json';
import realRun from './fixtures/path-real-run.json';

const toPoints = (raw: number[][]): TrackPoint[] =>
  raw.map(([lat, lng, ts]) => ({ lat, lng, ts }));

const DRIVE_SEP3 = toPoints(driveSep3 as number[][]);
const DRIVE_SEP2 = toPoints(driveSep2 as number[][]);
const REAL = toPoints(realRun as number[][]);

describe('pace guard vs real recorded runs', () => {
  it('never fires on a genuine 52-minute run', () => {
    // The one that must never break. This path contains a single 171 km/h
    // segment; averaged over 30 s it comes out at 12.1 km/h.
    expect(isImpossiblePace(REAL)).toBe(false);
  });

  it('leaves a 5x margin on that run, not a hair', () => {
    const peak = maxSustainedKmh(REAL);
    expect(peak).toBeLessThan(13);
    expect(PACE_GUARD_KMH / peak).toBeGreaterThan(1.5);
  });

  it('fires on both drives', () => {
    expect(isImpossiblePace(DRIVE_SEP3)).toBe(true);
    expect(isImpossiblePace(DRIVE_SEP2)).toBe(true);
  });

  it('sees the drives at roughly 60 km/h sustained', () => {
    expect(maxSustainedKmh(DRIVE_SEP3)).toBeGreaterThan(50);
    expect(maxSustainedKmh(DRIVE_SEP2)).toBeGreaterThan(50);
  });

  it('catches a drive early, replaying fix by fix', () => {
    // What the live guard actually experiences: points arriving one at a
    // time. The run must be stopped early, while the car is still near where
    // it started, not after it has banked a neighbourhood.
    //
    // Measured: Sep 2 trips at 25 s, Sep 3 at 77 s — the latter spent its
    // first minute pulling out slowly, and a median needs MOST of the window
    // to be fast before it moves. 77 s of driving is ~1.2 km in a line, and
    // a line encloses no territory; anything that does get through is caught
    // at save time by the closure-gap and impossible-area checks. The bound
    // here is the measured worst case plus headroom, not an aspiration.
    const firstTrip = (points: TrackPoint[]): number | null => {
      for (let n = 2; n <= points.length; n++) {
        if (isImpossiblePace(points.slice(0, n))) {
          return (points[n - 1].ts - points[0].ts) / 1000;
        }
      }
      return null;
    };
    expect(firstTrip(DRIVE_SEP3)).toBeLessThan(120);
    expect(firstTrip(DRIVE_SEP2)).toBeLessThan(40);
    // And the real run never trips, at any prefix — not just at the end.
    expect(firstTrip(REAL)).toBeNull();
  });
});

describe('maxSustainedKmh', () => {
  /** A straight-line path at a constant speed, one fix per second. */
  const LAT = 25.65;
  // A degree of LONGITUDE shrinks with latitude — 111 320 m at the equator
  // but only ~100 340 m at Monterrey's 25.65 deg. Using the equatorial
  // figure here made every synthetic path 10% slower than its label and
  // sent me looking for a bug in the guard that was never there.
  const metresPerDegLng = 111320 * Math.cos((LAT * Math.PI) / 180);
  const constantSpeed = (kmh: number, seconds: number): TrackPoint[] =>
    Array.from({ length: seconds + 1 }, (_, i) => ({
      lat: LAT,
      lng: -100.3 + (i * (kmh / 3.6)) / metresPerDegLng,
      ts: 1_700_000_000_000 + i * 1000,
    }));

  it('measures a known constant speed', () => {
    expect(maxSustainedKmh(constantSpeed(10, 120))).toBeCloseTo(10, 0);
    expect(maxSustainedKmh(constantSpeed(25, 120))).toBeCloseTo(25, 0);
  });

  it('returns 0 for a run too short to judge, rather than guessing', () => {
    expect(maxSustainedKmh([])).toBe(0);
    expect(maxSustainedKmh(constantSpeed(80, 5))).toBe(0);
    expect(isImpossiblePace(constantSpeed(80, 5))).toBe(false);
  });

  it.each([100, 300, 600])('is unmoved by a single fix %i m off course', (jumpM) => {
    // The exact shape that makes mean-based window speed unusable: one bad
    // fix adds its distance to the window TWICE, going out and coming back.
    // At 300 m a mean read 80.8 km/h and a largest-segment-trimmed mean
    // still read 44.6. The median reads 9.0 — the clean run's own figure.
    const points = constantSpeed(10, 120);
    points[60] = { ...points[60], lat: points[60].lat + jumpM / 110540 };
    expect(isImpossiblePace(points)).toBe(false);
    expect(maxSustainedKmh(points)).toBeCloseTo(maxSustainedKmh(constantSpeed(10, 120)), 1);
  });

  it('still catches sustained speed that starts mid-run', () => {
    // Ran first, then got in the car — the guard must not be fooled by an
    // honest opening stretch dragging the average down.
    const walk = constantSpeed(8, 120);
    const last = walk[walk.length - 1];
    const drive = Array.from({ length: 60 }, (_, i) => ({
      lat: last.lat,
      lng: last.lng + ((i + 1) * (60 / 3.6)) / metresPerDegLng,
      ts: last.ts + (i + 1) * 1000,
    }));
    expect(isImpossiblePace([...walk, ...drive])).toBe(true);
  });
});

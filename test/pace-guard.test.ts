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

import {
  isImpossiblePace,
  keptBeforeCut,
  maxSustainedKmh,
  PACE_GUARD_KMH,
  paceGuardCut,
} from '@/lib/pace-guard';
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

  it('clears the guard by a margin, not by a hair', () => {
    // Measured: the run peaks at ~12.1 km/h sustained against a 20 km/h
    // guard, so ~1.65x. The bound asserted is 1.5x — deliberately below the
    // measured figure, because the point is "there is real headroom", not
    // "the headroom is exactly this". (The name used to claim 5x, which no
    // assertion here ever checked and the data never supported.)
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
    // time. Measured with the 60 s window (2026-10-25): Sep 2 trips at 49 s,
    // Sep 3 at 90 s (its first minute was a slow pull-out). How LATE it
    // trips stopped mattering when a trip began cutting the run at the
    // first fast window instead of deleting it: everything from that window
    // on is dropped whenever it is detected. What matters now is the next
    // test, where the cut lands. Bounds are the measured values plus
    // headroom, not an aspiration.
    const firstTrip = (points: TrackPoint[]): number | null => {
      for (let n = 2; n <= points.length; n++) {
        if (isImpossiblePace(points.slice(0, n))) {
          return (points[n - 1].ts - points[0].ts) / 1000;
        }
      }
      return null;
    };
    expect(firstTrip(DRIVE_SEP3)).toBeLessThan(120);
    expect(firstTrip(DRIVE_SEP2)).toBeLessThan(70);
    // And the real run never trips, at any prefix — not just at the end.
    expect(firstTrip(REAL)).toBeNull();
  });
});

describe('where a drive is cut', () => {
  it('keeps less of either drive than a run worth saving', () => {
    // Both recordings are a drive from the start, so the session must still
    // end with nothing saved: index.tsx discards a kept part under 300 m.
    // Measured cut points: 0 s into Sep 2, 32 s into Sep 3 (pulling out).
    for (const drive of [DRIVE_SEP2, DRIVE_SEP3]) {
      const cut = paceGuardCut(drive);
      expect(cut).not.toBeNull();
      expect(keptBeforeCut(drive, cut!).distanceM).toBeLessThan(300);
    }
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
    const clean = constantSpeed(10, 120);
    const points = constantSpeed(10, 120);
    points[60] = { ...points[60], lat: points[60].lat + jumpM / 110540 };
    expect(isImpossiblePace(points)).toBe(false);
    expect(maxSustainedKmh(points)).toBeCloseTo(maxSustainedKmh(clean), 1);
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

// 2026-10-25: a water stop / restroom mid-run ended and DELETED the session
// ("there was no activity and the run got cancelled"; an hour of a 21 km
// run lost). A phone standing still indoors scatters its fixes around one
// spot, so every segment reads fast and the median with it: 30 m of scatter
// read 119 km/h. Deterministic noise so a failure reproduces.
describe('a phone standing still indoors', () => {
  const LAT = 25.67;
  const LNG = -100.3;
  const bounce = (sigmaM: number, everyS: number, count: number, acc?: number, t0 = 0): TrackPoint[] => {
    let seed = 7;
    const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const gauss = () => Math.sqrt(-2 * Math.log(rand() + 1e-9)) * Math.cos(2 * Math.PI * rand());
    return Array.from({ length: count }, (_, i) => ({
      lat: LAT + (gauss() * sigmaM) / 110540,
      lng: LNG + (gauss() * sigmaM) / 100340,
      ts: t0 + i * everyS * 1000,
      ...(acc !== undefined ? { acc } : {}),
    }));
  };

  it.each([30, 60])('is not moving when good fixes bounce %i m around one spot', (sigma) => {
    // Ten minutes of it, fixes every 2 s.
    expect(isImpossiblePace(bounce(sigma, 2, 300))).toBe(false);
  });

  it('ignores fixes the phone itself reported as poor', () => {
    // What the accuracy filter lets through when it fails open: wild fixes
    // every ~8 s. These read 25-37 km/h even on the centre test, which is
    // why poor fixes are not judged at all.
    expect(isImpossiblePace(bounce(150, 8, 120, 140))).toBe(false);
  });

  it('a stop in the middle of the real run does not trip it', () => {
    const t0 = REAL[REAL.length - 1].ts + 2000;
    const stop = bounce(60, 2, 150, 40, t0).map((p) => ({
      ...p,
      lat: p.lat - LAT + REAL[REAL.length - 1].lat,
      lng: p.lng - LNG + REAL[REAL.length - 1].lng,
    }));
    expect(isImpossiblePace([...REAL, ...stop])).toBe(false);
  });
});

describe('what a trip keeps', () => {
  const LAT = 25.65;
  const metresPerDegLng = 111320 * Math.cos((LAT * Math.PI) / 180);
  const walk = Array.from({ length: 601 }, (_, i) => ({
    lat: LAT,
    lng: -100.3 + (i * (10 / 3.6)) / metresPerDegLng,
    ts: 1_700_000_000_000 + i * 1000,
  }));
  const last = walk[walk.length - 1];
  const drive = Array.from({ length: 120 }, (_, i) => ({
    lat: last.lat,
    lng: last.lng + ((i + 1) * (60 / 3.6)) / metresPerDegLng,
    ts: last.ts + (i + 1) * 1000,
  }));

  it('keeps the honest part before a drive, and none of the drive', () => {
    // It used to delete everything. 10 minutes at 10 km/h = ~1 667 m.
    const run = [...walk, ...drive];
    const cut = paceGuardCut(run);
    expect(cut).not.toBeNull();
    const kept = keptBeforeCut(run, cut!);
    expect(kept.points.every((p) => p.ts < cut!)).toBe(true);
    expect(kept.distanceM).toBeGreaterThan(1500);
    // At most the window's worth of walking is lost, and no drive is kept
    // beyond the few seconds inside the first fast window.
    expect(kept.distanceM).toBeLessThan(1667 + 100);
  });

  it('has nothing to cut on an honest run', () => {
    expect(paceGuardCut(REAL)).toBeNull();
    expect(paceGuardCut(walk)).toBeNull();
  });
});

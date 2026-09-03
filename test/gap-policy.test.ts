// The shared gap plausibility policy (src/lib/gap-policy.ts) — imported by
// both tracking.ts's distance credit and tiles.ts's tile gap-fill, so the
// two subsystems can no longer independently decide whether the same real
// gap "happened." This is the layer vitest.config.ts's node environment can
// actually exercise: evaluateGap is pure, no React, no document, no
// visibilitychange event.
//
// One fixture below is built directly from the 2026-09-02 geometry audit's
// numbers (Source Data/Outputs/Running App/Geometry Audit — Saved Runs vs
// Recomputed (2026-09-02).md, run `68e32c11`): a real 76.0s/105.9m gap that
// the audit traced as the entire cause of that run's distance step, and
// which the tile builder was already bridging under the exact same caps
// tested here.
import { describe, expect, it } from 'vitest';

import { evaluateGap, MAX_BRIDGE_DISTANCE_M, MAX_BRIDGE_SPEED_MS } from '@/lib/gap-policy';
import type { LatLng } from '@/lib/territory';

// Monterrey-ish latitude, matching territory.test.ts / tiles.test.ts's own
// fixtures.
const LAT = 25.67;
const LNG = -100.31;
const M_PER_DEG_LAT = 111_320;
const M_PER_DEG_LNG = M_PER_DEG_LAT * Math.cos((LAT * Math.PI) / 180);

/** A point `metres` due east of a fixed origin. */
function pointEast(metres: number): LatLng {
  return { lat: LAT, lng: LNG + metres / M_PER_DEG_LNG };
}

const ORIGIN = pointEast(0);

describe('evaluateGap', () => {
  it('credits the real audit gap — 76.0s / 105.9m, run 68e32c11', () => {
    const to = pointEast(105.9);
    const dtMs = 76_000;
    const result = evaluateGap({ from: ORIGIN, to, dtMs });
    expect(result).not.toBeNull();
    expect(result!.chordM).toBeCloseTo(105.9, 0);
    // Implied speed ≈ 5.0 km/h, comfortably under both caps.
    expect(result!.credited).toBe(true);
  });

  it('credits a short, ordinary-pace gap', () => {
    const to = pointEast(20);
    const result = evaluateGap({ from: ORIGIN, to, dtMs: 15_000 }); // 4.8 km/h
    expect(result?.credited).toBe(true);
  });

  it('does NOT credit a gap over the distance cap, even at a plausible speed', () => {
    // 200m in 144s is 5 km/h — an entirely ordinary walking pace — but the
    // distance cap exists precisely because plausible speed alone isn't
    // enough: a straight line this long is a guess about which streets were
    // actually taken (see MAX_BRIDGE_DISTANCE_M's own doc).
    const to = pointEast(MAX_BRIDGE_DISTANCE_M + 50);
    const dtMs = ((MAX_BRIDGE_DISTANCE_M + 50) / 1.39) * 1000; // ~5 km/h
    const result = evaluateGap({ from: ORIGIN, to, dtMs });
    expect(result?.chordM).toBeGreaterThan(MAX_BRIDGE_DISTANCE_M);
    expect(result?.credited).toBe(false);
  });

  it('does NOT credit a gap over the speed cap, even under the distance cap', () => {
    // 100m in 2s implies 50 m/s (180 km/h) — a car or a GPS jump, not a
    // runner — well over MAX_BRIDGE_SPEED_MS despite the short distance.
    const to = pointEast(100);
    const result = evaluateGap({ from: ORIGIN, to, dtMs: 2_000 });
    expect(result?.chordM).toBeLessThan(MAX_BRIDGE_DISTANCE_M);
    const impliedSpeedMs = (result?.chordM ?? 0) / 2;
    expect(impliedSpeedMs).toBeGreaterThan(MAX_BRIDGE_SPEED_MS);
    expect(result?.credited).toBe(false);
  });

  it('does NOT credit a zero-duration gap — no elapsed time to judge a speed from', () => {
    const to = pointEast(10);
    const result = evaluateGap({ from: ORIGIN, to, dtMs: 0 });
    expect(result?.credited).toBe(false);
  });

  it('does NOT credit a negative-duration gap (out-of-order timestamps) — fails safe', () => {
    const to = pointEast(10);
    const result = evaluateGap({ from: ORIGIN, to, dtMs: -500 });
    expect(result?.credited).toBe(false);
  });

  it('returns null — nothing to chord against — when there is no prior point', () => {
    // Mirrors tracking.ts: a gap that opens before any fix has ever been
    // recorded (right after Start, before the first fix arrives) has no
    // near end to measure from.
    const result = evaluateGap({ from: null, to: pointEast(10), dtMs: 5_000 });
    expect(result).toBeNull();
  });

  it('a stationary gap (zero chord) is trivially credited — nothing implausible about not moving', () => {
    const result = evaluateGap({ from: ORIGIN, to: ORIGIN, dtMs: 10_000 });
    expect(result?.chordM).toBeCloseTo(0, 3);
    expect(result?.credited).toBe(true);
  });

  it('exposes the same caps tiles.ts bridges gaps with, so both stay in sync', () => {
    expect(MAX_BRIDGE_DISTANCE_M).toBe(150);
    expect(MAX_BRIDGE_SPEED_MS).toBeCloseTo((25 * 1000) / 3600, 6);
  });
});

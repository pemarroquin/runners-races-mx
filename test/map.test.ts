// rotateRouteGradient — the pure logic behind the live route line's colour
// cycle (track-map.web.tsx). Split out from that component precisely so this
// can be tested without a GL renderer: a wraparound bug here would ship as
// an invalid `interpolate` expression (unsorted stops), which Mapbox GL
// rejects silently the same way a missing lineMetrics does — a flat/frozen
// line, not a visible error.
import { describe, expect, it } from 'vitest';

import { ROUTE_GRADIENT, rotateRouteGradient } from '@/constants/map';

describe('rotateRouteGradient', () => {
  it('never moves the offsets — only the colours', () => {
    for (let step = 0; step < 10; step++) {
      const rotated = rotateRouteGradient(step);
      expect(rotated.map(([offset]) => offset)).toEqual(ROUTE_GRADIENT.map(([offset]) => offset));
    }
  });

  it('offsets stay strictly increasing at every step — a real interpolate expression', () => {
    for (let step = 0; step < ROUTE_GRADIENT.length * 2; step++) {
      const offsets = rotateRouteGradient(step).map(([offset]) => offset);
      for (let i = 1; i < offsets.length; i++) {
        expect(offsets[i]).toBeGreaterThan(offsets[i - 1]);
      }
    }
  });

  it('step 0 matches the base gradient exactly', () => {
    expect(rotateRouteGradient(0)).toEqual(ROUTE_GRADIENT);
  });

  it('is a permutation of the same colours at every step — never invents or drops one', () => {
    const baseColors = [...ROUTE_GRADIENT.map(([, c]) => c)].sort();
    for (let step = 0; step < 8; step++) {
      const rotatedColors = rotateRouteGradient(step)
        .map(([, c]) => c)
        .sort();
      expect(rotatedColors).toEqual(baseColors);
    }
  });

  it('returns to the base gradient after a full cycle', () => {
    expect(rotateRouteGradient(ROUTE_GRADIENT.length)).toEqual(ROUTE_GRADIENT);
    expect(rotateRouteGradient(ROUTE_GRADIENT.length * 3)).toEqual(ROUTE_GRADIENT);
  });

  it('wraps correctly for negative steps too', () => {
    const n = ROUTE_GRADIENT.length;
    expect(rotateRouteGradient(-1)).toEqual(rotateRouteGradient(n - 1));
    expect(rotateRouteGradient(-n)).toEqual(rotateRouteGradient(0));
  });
});

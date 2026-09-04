// flowingRouteGradient / cyclicGradientColorAt / lineGradientExpression —
// the pure logic behind the route line's and the saved territories' colour
// flow (track-map.web.tsx, territories-map.web.tsx, fence-map.web.tsx).
// Split out from those components precisely so this can be tested without a
// GL renderer: a wraparound bug here would ship as an invalid `interpolate`
// expression (unsorted stops), which Mapbox GL rejects SILENTLY the same way
// a missing lineMetrics does — a flat/frozen line, not a visible error.
import { describe, expect, it } from 'vitest';

import {
  ROUTE_GRADIENT,
  ROUTE_GRADIENT_COLORS,
  ROUTE_GRADIENT_FRAME_MS,
  ROUTE_GRADIENT_LOOP_MS,
} from '@/constants/map';
import {
  cyclicGradientColorAt,
  flowingRouteGradient,
  lineGradientExpression,
} from '@/lib/fence-draw';

/** Case-insensitive colour compare — the wheel's own literals are uppercase,
 *  while every interpolated colour comes back lowercase from hexLerp. */
function sameColor(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

const channels = (hex: string) => {
  const v = parseInt(hex.slice(1), 16);
  return [16, 8, 0].map((shift) => (v >> shift) & 0xff);
};

/** Max per-channel distance between two '#rrggbb' colours. */
function channelDistance(a: string, b: string): number {
  const [ra, ga, ba] = channels(a);
  const [rb, gb, bb] = channels(b);
  return Math.max(Math.abs(ra - rb), Math.abs(ga - gb), Math.abs(ba - bb));
}

/** How far from grey a colour is — max channel minus min channel. */
function spread(hex: string): number {
  const ch = channels(hex);
  return Math.max(...ch) - Math.min(...ch);
}

describe('ROUTE_GRADIENT_COLORS', () => {
  it('is the twelve-colour wheel the flow assumes', () => {
    expect(ROUTE_GRADIENT_COLORS).toHaveLength(12);
    expect(new Set(ROUTE_GRADIENT_COLORS).size).toBe(12);
    for (const color of ROUTE_GRADIENT_COLORS) expect(color).toMatch(/^#[0-9A-Fa-f]{6}$/);
  });

  it('lays out as evenly spaced stops that close on themselves', () => {
    expect(ROUTE_GRADIENT).toHaveLength(13);
    const offsets = ROUTE_GRADIENT.map(([offset]) => offset);
    for (let i = 1; i < offsets.length; i++) expect(offsets[i]).toBeGreaterThan(offsets[i - 1]);
    expect(offsets[0]).toBe(0);
    expect(offsets[offsets.length - 1]).toBe(1);
    expect(ROUTE_GRADIENT[12][1]).toBe(ROUTE_GRADIENT[0][1]);
  });
});

describe('cyclicGradientColorAt', () => {
  it('has period 1 — t and t+1 are the same colour', () => {
    for (const t of [0, 0.13, 0.5, 0.82, 0.999]) {
      expect(cyclicGradientColorAt(t)).toBe(cyclicGradientColorAt(t + 1));
      expect(cyclicGradientColorAt(t)).toBe(cyclicGradientColorAt(t + 5));
    }
  });

  it('wraps negatives the same way', () => {
    expect(cyclicGradientColorAt(-0.25)).toBe(cyclicGradientColorAt(0.75));
    expect(cyclicGradientColorAt(-1)).toBe(cyclicGradientColorAt(0));
  });

  it('lands each wheel colour on its own even leg', () => {
    ROUTE_GRADIENT_COLORS.forEach((color, i) => {
      expect(sameColor(cyclicGradientColorAt(i / 12), color)).toBe(true);
    });
  });

  it('never jumps anywhere, the wrap at t=0 included', () => {
    // Why the wheel has to close in hue. Sampled finely all the way around,
    // no two neighbouring samples may differ much. Running a ramp that
    // spanned only half the wheel and blending its warm end back to its cool
    // start jumped ~175 units per channel at the seam.
    const step = 0.002;
    let worst = 0;
    for (let t = 0; t < 1; t += step) {
      worst = Math.max(worst, channelDistance(cyclicGradientColorAt(t), cyclicGradientColorAt(t + step)));
    }
    expect(worst).toBeLessThan(8);
  });

  it('never desaturates — no grey band anywhere in the wheel', () => {
    // A straight warm->cool return leg passes through ~#A69AA5, whose
    // channel spread is 12. Every colour in the wheel and every blend
    // between two of them has to stay far clear of that: this is the whole
    // "vibrant" ask, asserted rather than eyeballed.
    for (let t = 0; t < 1; t += 0.002) {
      expect(spread(cyclicGradientColorAt(t))).toBeGreaterThan(60);
    }
  });
});

describe('flowingRouteGradient', () => {
  const phases = [0, 1 / 12, 0.02, 0.2, 0.37, 0.5, 0.83, 0.99];

  it('offsets stay strictly increasing — a real interpolate expression', () => {
    for (let i = 0; i <= 240; i++) {
      const offsets = flowingRouteGradient(i / 240).map(([offset]) => offset);
      for (let j = 1; j < offsets.length; j++) {
        expect(offsets[j]).toBeGreaterThan(offsets[j - 1]);
      }
    }
  });

  it('spans exactly [0,1] — GL clamps anything outside it', () => {
    for (const phase of phases) {
      const stops = flowingRouteGradient(phase);
      expect(stops[0][0]).toBe(0);
      expect(stops[stops.length - 1][0]).toBe(1);
    }
  });

  it('closes the loop — first and last stop share a colour, so a ring has no seam', () => {
    for (const phase of phases) {
      const stops = flowingRouteGradient(phase);
      // sameColor, not toBe: when a boundary lands exactly on offset 0 that
      // end carries the wheel's own uppercase literal while the other end is
      // a lowercase hexLerp result. Same colour to Mapbox, and to the eye.
      expect(sameColor(stops[0][1], stops[stops.length - 1][1])).toBe(true);
    }
  });

  it('stays small — boundary stops, not a resampled grid', () => {
    // 12 wheel boundaries plus the two line ends, minus one when a boundary
    // lands exactly on an end. The cost that scales with how many
    // territories are on screen is stop count x layers, so this is a real
    // budget, not trivia.
    for (const phase of phases) {
      expect(flowingRouteGradient(phase).length).toBeLessThanOrEqual(14);
    }
    expect(flowingRouteGradient(0)).toHaveLength(13);
  });

  it('is exact — every stop sits on the colour the wheel says belongs there', () => {
    // The point of using boundaries instead of a fixed grid: no resampling
    // error at all, so the wheel's corners can never round off.
    for (const phase of phases) {
      for (const [offset, color] of flowingRouteGradient(phase)) {
        expect(sameColor(color, cyclicGradientColorAt(offset - phase))).toBe(true);
      }
    }
  });

  it('is periodic in phase — a full loop returns to the start', () => {
    expect(flowingRouteGradient(1)).toEqual(flowingRouteGradient(0));
    expect(flowingRouteGradient(-0.3)).toEqual(flowingRouteGradient(0.7));
  });

  it('advances smoothly — one frame of phase never jumps a colour', () => {
    // The actual regression guard for the "stepped" bug: the old
    // rotate-the-stops implementation moved every colour a whole stop along
    // the ramp per tick. Here, sampling both frames at the SAME offsets (the
    // stops move, so comparing stop-to-stop would compare different places
    // on the line), one frame may only shift a colour slightly.
    const perTick = ROUTE_GRADIENT_FRAME_MS / ROUTE_GRADIENT_LOOP_MS;
    const ticksPerLoop = Math.ceil(1 / perTick);
    let worst = 0;
    for (let step = 0; step < ticksPerLoop; step++) {
      for (let x = 0; x <= 1; x += 0.01) {
        worst = Math.max(
          worst,
          channelDistance(
            cyclicGradientColorAt(x - step * perTick),
            cyclicGradientColorAt(x - (step + 1) * perTick),
          ),
        );
      }
    }
    expect(worst).toBeLessThan(26);
  });

  it('travels forward — a colour moves toward offset 1 as phase grows', () => {
    // One full leg of phase puts wheel colour i where colour i-1 used to be.
    const leg = 1 / 12;
    for (let j = 1; j < 12; j++) {
      expect(
        sameColor(cyclicGradientColorAt(j * leg - leg), ROUTE_GRADIENT_COLORS[j - 1]),
      ).toBe(true);
    }
    const before = flowingRouteGradient(0);
    const after = flowingRouteGradient(leg);
    // Every boundary is back where it started, carrying the previous colour.
    expect(after.map(([offset]) => offset)).toEqual(before.map(([offset]) => offset));
    for (let i = 1; i < before.length - 1; i++) {
      expect(sameColor(after[i][1], before[i - 1][1])).toBe(true);
    }
  });
});

describe('lineGradientExpression', () => {
  it('flattens to the interpolate form line-gradient requires', () => {
    const expr = lineGradientExpression([
      [0, '#000000'],
      [1, '#ffffff'],
    ]) as unknown as unknown[];
    expect(expr).toEqual(['interpolate', ['linear'], ['line-progress'], 0, '#000000', 1, '#ffffff']);
  });

  it('defaults to the static wheel', () => {
    const expr = lineGradientExpression() as unknown as unknown[];
    expect(expr.slice(3)).toEqual(ROUTE_GRADIENT.flat());
  });
});

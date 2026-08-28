// The GPS accuracy filter's accept/reject rule.
//
// These exist because of a real device bug (2026-08-27): near an office
// building every fix reported >100m accuracy, the filter rejected all of
// them, and the route never grew past its single seed point — so no line was
// ever drawn. Pausing and resuming was the only thing that worked, because
// resume() clears `lastRef` and the first fix of a leg bypasses the filter.
//
// The rule that fixes it: reject OUTLIERS, never the environment.
import { describe, expect, it } from 'vitest';

import { shouldAcceptFix } from '../src/lib/tracking';

describe('shouldAcceptFix', () => {
  it('always keeps the first fix of a leg, however poor', () => {
    expect(
      shouldAcceptFix({ isFirst: true, accuracyM: 5000, consecutiveRejects: 0 }),
    ).toBe(true);
  });

  it('keeps an accurate fix', () => {
    expect(
      shouldAcceptFix({ isFirst: false, accuracyM: 12, consecutiveRejects: 0 }),
    ).toBe(true);
  });

  it('drops an isolated poor fix — outlier rejection still works', () => {
    expect(
      shouldAcceptFix({ isFirst: false, accuracyM: 400, consecutiveRejects: 0 }),
    ).toBe(false);
  });

  it('FAILS OPEN once poor fixes are sustained — the office-building bug', () => {
    // Three in a row means this is the environment, not an outlier. A
    // degraded route beats no route at all.
    expect(
      shouldAcceptFix({ isFirst: false, accuracyM: 400, consecutiveRejects: 3 }),
    ).toBe(true);
  });

  it('never starves the track no matter how long the signal stays poor', () => {
    // The actual regression: with an unconditional filter, every one of
    // these was dropped and the route stayed a single point forever.
    let consecutiveRejects = 0;
    let accepted = 0;
    for (let i = 0; i < 40; i++) {
      if (shouldAcceptFix({ isFirst: false, accuracyM: 250, consecutiveRejects })) {
        accepted++;
        consecutiveRejects = 0;
      } else {
        consecutiveRejects++;
      }
    }
    expect(accepted).toBeGreaterThan(0);
  });

  it('keeps a fix that reports no accuracy at all', () => {
    // Nothing to judge on — dropping these would discard usable positions on
    // any platform that omits the field.
    expect(
      shouldAcceptFix({ isFirst: false, accuracyM: null, consecutiveRejects: 0 }),
    ).toBe(true);
  });

  it('honours the boundary exactly', () => {
    expect(
      shouldAcceptFix({ isFirst: false, accuracyM: 100, consecutiveRejects: 0, maxAccuracyM: 100 }),
    ).toBe(true);
    expect(
      shouldAcceptFix({ isFirst: false, accuracyM: 101, consecutiveRejects: 0, maxAccuracyM: 100 }),
    ).toBe(false);
  });
});

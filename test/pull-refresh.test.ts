import { describe, expect, it } from 'vitest';

import {
  PULL_MAX,
  PULL_THRESHOLD,
  isPullGesture,
  pullDistance,
  pullProgress,
  shouldRefresh,
} from '../src/lib/pull-refresh';

describe('pullDistance', () => {
  it('ignores upward and zero travel', () => {
    expect(pullDistance(-40)).toBe(0);
    expect(pullDistance(0)).toBe(0);
    expect(pullDistance(Number.NaN)).toBe(0);
  });

  it('grows with travel but resists', () => {
    const a = pullDistance(40);
    const b = pullDistance(80);
    expect(b).toBeGreaterThan(a);
    expect(b - a).toBeLessThan(a);
  });

  it('never passes the max', () => {
    expect(pullDistance(10_000)).toBeLessThanOrEqual(PULL_MAX);
  });

  it('reaches the threshold with a reasonable pull', () => {
    expect(shouldRefresh(pullDistance(120))).toBe(true);
    expect(shouldRefresh(pullDistance(30))).toBe(false);
  });
});

describe('pullProgress', () => {
  it('runs 0 to 1 and clamps', () => {
    expect(pullProgress(0)).toBe(0);
    expect(pullProgress(PULL_THRESHOLD / 2)).toBeCloseTo(0.5);
    expect(pullProgress(PULL_THRESHOLD * 3)).toBe(1);
  });
});

describe('isPullGesture', () => {
  it('claims a downward drag', () => {
    expect(isPullGesture(2, 20)).toBe(true);
  });

  it('leaves taps, sideways and upward drags alone', () => {
    expect(isPullGesture(0, 3)).toBe(false);
    expect(isPullGesture(30, 20)).toBe(false);
    expect(isPullGesture(0, -20)).toBe(false);
  });
});

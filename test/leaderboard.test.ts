// Leaderboard aggregation. The union behaviour is the point of these tests:
// summing `area_m2` per user would be the obvious implementation and it is
// WRONG — running the same loop twice would double your score. Anything that
// "simplifies" unionAreaM2 into a sum fails here.
import type { Polygon } from 'geojson';
import { describe, expect, it } from 'vitest';

import { rankByArea, regionsWithRuns, unionAreaM2, type LeaderboardRun } from '../src/lib/leaderboard';

/** An axis-aligned square, in degrees, near Monterrey. */
function square(west: number, south: number, size: number): Polygon {
  return {
    type: 'Polygon',
    coordinates: [
      [
        [west, south],
        [west + size, south],
        [west + size, south + size],
        [west, south + size],
        [west, south],
      ],
    ],
  };
}

const A = square(-100.32, 25.68, 0.01);
// Fully overlapping A — the "ran the same loop twice" case.
const A_AGAIN = square(-100.32, 25.68, 0.01);
// Disjoint from A.
const B = square(-100.2, 25.68, 0.01);

function run(
  userId: string,
  geometry: Polygon,
  region: string | null = 'mty',
  flagged = false,
): LeaderboardRun {
  return { userId, displayName: null, region, geometry, flagged };
}

describe('unionAreaM2', () => {
  it('counts overlapping fences once, not twice', () => {
    const single = unionAreaM2([A]);
    const twice = unionAreaM2([A, A_AGAIN]);
    expect(twice).toBeCloseTo(single, 0);
  });

  it('adds up disjoint fences', () => {
    const total = unionAreaM2([A, B]);
    expect(total).toBeCloseTo(unionAreaM2([A]) + unionAreaM2([B]), 0);
  });

  it('is 0 for no fences', () => {
    expect(unionAreaM2([])).toBe(0);
  });
});

describe('rankByArea', () => {
  it('ranks by area held, descending', () => {
    const ranked = rankByArea([run('u1', A), run('u2', A), run('u2', B)], null);
    expect(ranked.map((e) => e.userId)).toEqual(['u2', 'u1']);
    expect(ranked[0].runCount).toBe(2);
  });

  it('does not let a repeated loop outrank genuinely new ground', () => {
    // u1 ran the same loop three times; u2 ran two different ones.
    const ranked = rankByArea(
      [run('u1', A), run('u1', A_AGAIN), run('u1', A), run('u2', A), run('u2', B)],
      null,
    );
    expect(ranked[0].userId).toBe('u2');
  });

  it('filters to one region, dropping users with nothing there', () => {
    const ranked = rankByArea([run('u1', A, 'mty'), run('u2', B, 'cdmx')], 'mty');
    expect(ranked.map((e) => e.userId)).toEqual(['u1']);
  });

  it('includes every region when regionId is null', () => {
    const ranked = rankByArea([run('u1', A, 'mty'), run('u2', B, 'cdmx')], null);
    expect(ranked).toHaveLength(2);
  });

  it('excludes untagged runs from a regional board but keeps them globally', () => {
    const runs = [run('u1', A, null)];
    expect(rankByArea(runs, 'mty')).toHaveLength(0);
    expect(rankByArea(runs, null)).toHaveLength(1);
  });

  it('prefers a set display name over a null from a partial join', () => {
    const ranked = rankByArea(
      [
        { userId: 'u1', displayName: null, region: 'mty', geometry: A },
        { userId: 'u1', displayName: 'Pedro', region: 'mty', geometry: B },
      ],
      null,
    );
    expect(ranked[0].displayName).toBe('Pedro');
  });

  it('orders ties stably rather than reshuffling between loads', () => {
    const runs = [run('zzz', A), run('aaa', A_AGAIN)];
    expect(rankByArea(runs, null).map((e) => e.userId)).toEqual(
      rankByArea([...runs].reverse(), null).map((e) => e.userId),
    );
  });
});

describe('flag counting', () => {
  it('counts flagged runs per user without excluding them from the score', () => {
    // "Counts, but marked" — a flagged run still contributes its area, so a
    // GPS glitch never silently costs someone their territory.
    const clean = rankByArea([run('u1', A)], null)[0];
    const flagged = rankByArea([run('u1', A, 'mty', true)], null)[0];
    expect(flagged.areaM2).toBeCloseTo(clean.areaM2, 0);
    expect(flagged.flaggedCount).toBe(1);
    expect(clean.flaggedCount).toBe(0);
  });

  it('counts only the flagged subset of a user\u2019s runs', () => {
    const entry = rankByArea(
      [run('u1', A), run('u1', B, 'mty', true), run('u1', A_AGAIN, 'mty', true)],
      null,
    )[0];
    expect(entry.runCount).toBe(3);
    expect(entry.flaggedCount).toBe(2);
  });
});

describe('regionsWithRuns', () => {
  it('lists distinct tagged regions, sorted', () => {
    expect(regionsWithRuns([run('u1', A, 'mty'), run('u2', B, 'cdmx'), run('u3', A, 'mty')])).toEqual(
      ['cdmx', 'mty'],
    );
  });

  it('ignores untagged runs', () => {
    expect(regionsWithRuns([run('u1', A, null)])).toEqual([]);
  });
});

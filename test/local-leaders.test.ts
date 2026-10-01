// Local Leaders as a map. The contract that matters: a runner's shape on the
// map holds exactly as many cells as their row on the card says.
import { cellToBoundary, latLngToCell } from 'h3-js';
import { describe, expect, it } from 'vitest';

import { districtOf } from '../src/lib/district';
import { cellsBounds, daysPresent, frameOf, mayorHoldings, runnerTotals } from '../src/lib/local-leaders';
import { rankMayors, type TileVisitRow } from '../src/lib/mayorship';

const MTY = { lat: 25.6866, lng: -100.3161 };
const FAR = { lat: 25.6866, lng: -100.5161 };
const cell = (dLat: number, dLng = 0) => latLngToCell(MTY.lat + dLat, MTY.lng + dLng, 12);
const A = cell(0);
const B = cell(0.0004);
const C = cell(0.0008);
const CELL_FAR = latLngToCell(FAR.lat, FAR.lng, 12);
const DISTRICT = districtOf(MTY);

const NOW = Date.parse('2026-09-08T12:00:00.000Z');
const daysAgo = (n: number, hour = 12) =>
  new Date(NOW - n * 86_400_000 + (hour - 12) * 3_600_000).toISOString();

const v = (h3: string, userId: string, visitedAt: string): TileVisitRow => ({
  h3,
  userId,
  displayName: userId,
  visitedAt,
});

const VISITS: TileVisitRow[] = [
  // laura: A on 3 days, B on 1
  v(A, 'laura', daysAgo(1)),
  v(A, 'laura', daysAgo(2)),
  v(A, 'laura', daysAgo(3)),
  v(B, 'laura', daysAgo(3)),
  // pedro: A on 2 days (loses A), B on 2 days (wins B), C on 1
  v(A, 'pedro', daysAgo(1)),
  v(A, 'pedro', daysAgo(4)),
  v(B, 'pedro', daysAgo(1)),
  v(B, 'pedro', daysAgo(5)),
  v(C, 'pedro', daysAgo(5)),
  // pedro, elsewhere — must not count here
  v(CELL_FAR, 'pedro', daysAgo(6)),
  // outside the window
  v(C, 'laura', daysAgo(40)),
];

describe('mayorHoldings', () => {
  it('groups mayor cells per runner', () => {
    const held = mayorHoldings(VISITS, DISTRICT, NOW);
    expect(held.get('laura')).toEqual([A]);
    expect(new Set(held.get('pedro'))).toEqual(new Set([B, C]));
  });

  it('agrees with rankMayors cell counts for every runner', () => {
    const held = mayorHoldings(VISITS, DISTRICT, NOW);
    const board = rankMayors(VISITS, DISTRICT, NOW);
    expect(board.length).toBe(held.size);
    for (const row of board) expect(held.get(row.userId)?.length).toBe(row.cellsHeld);
  });

  it('ignores cells outside the arena', () => {
    const all = [...mayorHoldings(VISITS, DISTRICT, NOW).values()].flat();
    expect(all).not.toContain(CELL_FAR);
  });

  it('includes the far cell when unscoped', () => {
    expect(mayorHoldings(VISITS, null, NOW).get('pedro')).toContain(CELL_FAR);
  });
});

describe('daysPresent', () => {
  it('counts distinct days in the arena inside the window', () => {
    const days = daysPresent(VISITS, DISTRICT, NOW);
    expect(days.get('laura')).toBe(3); // day 40 is outside the window
    expect(days.get('pedro')).toBe(3); // days 1, 4, 5; day 6 was elsewhere
  });

  it('counts two visits on one UTC day once', () => {
    const days = daysPresent([v(A, 'x', daysAgo(1, 9)), v(B, 'x', daysAgo(1, 15))], DISTRICT, NOW);
    expect(days.get('x')).toBe(1);
  });

  it('drops unparseable timestamps instead of throwing', () => {
    expect(daysPresent([v(A, 'x', 'not a date')], DISTRICT, NOW).size).toBe(0);
  });

  it('drops visits from the future', () => {
    expect(daysPresent([v(A, 'x', daysAgo(-1))], DISTRICT, NOW).size).toBe(0);
  });
});

describe('cellsBounds', () => {
  it('returns null for no cells', () => {
    expect(cellsBounds([])).toBeNull();
  });

  it('skips malformed cells', () => {
    expect(cellsBounds(['nope'])).toBeNull();
    expect(cellsBounds(['nope', A])).not.toBeNull();
  });

  it('contains every vertex of every cell', () => {
    const b = cellsBounds([A, C])!;
    for (const [lat, lng] of [...cellToBoundary(A), ...cellToBoundary(C)]) {
      expect(lat).toBeGreaterThanOrEqual(b.minLat);
      expect(lat).toBeLessThanOrEqual(b.maxLat);
      expect(lng).toBeGreaterThanOrEqual(b.minLng);
      expect(lng).toBeLessThanOrEqual(b.maxLng);
    }
  });
});

describe('frameOf', () => {
  it('frames held ground in full mode', () => {
    expect(frameOf(cellsBounds([DISTRICT]), [{ cells: [A] }], true)).toEqual(cellsBounds([A]));
  });

  it('falls back to the arena when nobody holds anything', () => {
    expect(frameOf(cellsBounds([DISTRICT]), [{ cells: [] }], true)).toEqual(cellsBounds([DISTRICT]));
  });

  it('always frames the arena in card mode', () => {
    expect(frameOf(cellsBounds([DISTRICT]), [{ cells: [A] }], false)).toEqual(cellsBounds([DISTRICT]));
  });
});

describe('effort tiebreakers (days, then laps, then distance, then incumbent)', () => {
  const rv = (h3: string, userId: string, visitedAt: string, runId: string): TileVisitRow => ({
    h3,
    userId,
    displayName: userId,
    visitedAt,
    runId,
  });
  // Both on A for 2 days; laura arrived first (the incumbent).
  const tied = [
    rv(A, 'laura', daysAgo(5), 'l1'),
    rv(A, 'laura', daysAgo(2), 'l2'),
    rv(A, 'david', daysAgo(4), 'd1'),
    rv(A, 'david', daysAgo(1), 'd2'),
  ];
  const stat = (distanceM: number, laps: number, durationS = 1800) => ({ distanceM, durationS, laps });

  it('keeps the incumbent with no stats', () => {
    expect(mayorHoldings(tied, DISTRICT, NOW).get('laura')).toEqual([A]);
  });

  it('gives an equal-days cell to more laps', () => {
    const stats = new Map([
      ['l1', stat(5000, 0)],
      ['l2', stat(5000, 0)],
      ['d1', stat(3000, 4)],
      ['d2', stat(3000, 0)],
    ]);
    expect(mayorHoldings(tied, DISTRICT, NOW, stats).get('david')).toEqual([A]);
  });

  it('then to more distance when laps are equal', () => {
    const stats = new Map([
      ['l1', stat(4000, 2)],
      ['l2', stat(4000, 0)],
      ['d1', stat(9000, 1)],
      ['d2', stat(1000, 1)],
    ]);
    expect(mayorHoldings(tied, DISTRICT, NOW, stats).get('david')).toEqual([A]);
  });

  it('never lets effort beat an extra day', () => {
    const moreDays = [...tied, rv(A, 'laura', daysAgo(3), 'l3')];
    const stats = new Map([
      ['l1', stat(100, 0)],
      ['l2', stat(100, 0)],
      ['l3', stat(100, 0)],
      ['d1', stat(40_000, 50)],
      ['d2', stat(40_000, 50)],
    ]);
    expect(mayorHoldings(moreDays, DISTRICT, NOW, stats).get('laura')).toEqual([A]);
  });

  it('agrees with rankMayors under stats', () => {
    const stats = new Map([
      ['l1', stat(5000, 0)],
      ['l2', stat(5000, 0)],
      ['d1', stat(3000, 4)],
      ['d2', stat(3000, 0)],
    ]);
    const held = mayorHoldings(tied, DISTRICT, NOW, stats);
    for (const row of rankMayors(tied, DISTRICT, NOW, stats)) {
      expect(held.get(row.userId)?.length).toBe(row.cellsHeld);
    }
  });
});

describe('runnerTotals', () => {
  const rv = (h3: string, userId: string, visitedAt: string, runId?: string): TileVisitRow => ({
    h3,
    userId,
    displayName: userId,
    visitedAt,
    runId,
  });

  it('counts each run once, however many of its cells are here', () => {
    const visits = [rv(A, 'x', daysAgo(1), 'r1'), rv(B, 'x', daysAgo(1), 'r1'), rv(C, 'x', daysAgo(2), 'r2')];
    const stats = new Map([
      ['r1', { distanceM: 5000, durationS: 1500, laps: 2 }],
      ['r2', { distanceM: 3000, durationS: 1000, laps: 0 }],
    ]);
    expect(runnerTotals(visits, DISTRICT, stats, NOW).get('x')).toEqual({
      distanceM: 8000,
      durationS: 2500,
      laps: 2,
      runs: 2,
    });
  });

  it('leaves out runs with no stats, runs elsewhere, and runs outside the window', () => {
    const visits = [
      rv(A, 'x', daysAgo(1), 'flagged'),
      rv(CELL_FAR, 'x', daysAgo(1), 'far'),
      rv(A, 'x', daysAgo(40), 'old'),
      rv(A, 'x', daysAgo(1)),
    ];
    const stats = new Map([
      ['far', { distanceM: 1, durationS: 1, laps: 0 }],
      ['old', { distanceM: 1, durationS: 1, laps: 0 }],
    ]);
    expect(runnerTotals(visits, DISTRICT, stats, NOW).has('x')).toBe(false);
  });
});

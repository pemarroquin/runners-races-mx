// Local Leaders as a map. The contract that matters: a runner's shape on the
// map holds exactly as many cells as their row on the card says.
import { cellToBoundary, latLngToCell } from 'h3-js';
import { describe, expect, it } from 'vitest';

import { districtOf } from '../src/lib/district';
import { cellsBounds, daysPresent, frameOf, mayorHoldings } from '../src/lib/local-leaders';
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
    expect(frameOf(DISTRICT, [{ cells: [A] }], true)).toEqual(cellsBounds([A]));
  });

  it('falls back to the arena when nobody holds anything', () => {
    expect(frameOf(DISTRICT, [{ cells: [] }], true)).toEqual(cellsBounds([DISTRICT]));
  });

  it('always frames the arena in card mode', () => {
    expect(frameOf(DISTRICT, [{ cells: [A] }], false)).toEqual(cellsBounds([DISTRICT]));
  });
});

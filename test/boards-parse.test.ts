// The two shapes Local Leaders' RPCs return (20261023120000), parsed on the
// device. A malformed answer must fail the board, never shrink it.
import { describe, expect, it } from 'vitest';

import { parseMayorCells, parseRunnerRows } from '../src/lib/boards';

describe('parseMayorCells', () => {
  it('keeps only the cells inside the arena', () => {
    const raw = [
      ['8c48a2a1a1a1a1f', 'u1', 3],
      ['8c48a2a1a1a1a11', 'u2', 1],
    ];
    const out = parseMayorCells(raw, (h3) => h3.endsWith('f'));
    expect([...out]).toEqual([['8c48a2a1a1a1a1f', { userId: 'u1', days: 3 }]]);
  });

  it('throws on anything that is not the agreed shape', () => {
    expect(() => parseMayorCells(null, () => true)).toThrow();
    expect(() => parseMayorCells([['8c48a2a1a1a1a1f', 'u1', '3']], () => true)).toThrow();
    expect(() => parseMayorCells([{ h3: 'x' }], () => true)).toThrow();
  });
});

describe('parseRunnerRows', () => {
  it('gives days to every mayor and totals only to those with a countable session', () => {
    const { days, totals } = parseRunnerRows([
      { user_id: 'u1', days: 4, runs: 2, distance_m: 8000.5, duration_s: 2400, laps: 1 },
      { user_id: 'u2', days: 1, runs: 0, distance_m: 0, duration_s: 0, laps: 0 },
    ]);
    expect([...days]).toEqual([
      ['u1', 4],
      ['u2', 1],
    ]);
    expect([...totals]).toEqual([['u1', { distanceM: 8000.5, durationS: 2400, laps: 1, runs: 2 }]]);
  });

  it('throws on a malformed row', () => {
    expect(() => parseRunnerRows({})).toThrow();
    expect(() => parseRunnerRows([{ days: 1 }])).toThrow();
  });
});

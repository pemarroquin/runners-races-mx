import { cellToChildren, latLngToCell } from 'h3-js';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/supabase', () => ({ supabase: {} }));

import { districtOfCell } from '../src/lib/district';
import {
  LIVE_MIN_INTERVAL_MS,
  MAX_ANNOUNCED_DISTRICTS,
  claimDistricts,
  refetchDelay,
  touchesArena,
} from '../src/lib/live-territory';

const A = latLngToCell(25.6696, -100.3097, 12);
const B = latLngToCell(25.6538, -100.4033, 12);
const DA = districtOfCell(A)!;
const DB = districtOfCell(B)!;

describe('claimDistricts', () => {
  it('names each touched district once', () => {
    const cells = [...cellToChildren(latLngToCell(25.6696, -100.3097, 10), 12), B];
    expect(new Set(claimDistricts(cells))).toEqual(new Set([DA, DB]));
  });

  it('skips cells not at the tile resolution', () => {
    expect(claimDistricts([latLngToCell(25.6696, -100.3097, 11)])).toEqual([]);
  });
});

describe('touchesArena', () => {
  it('matches a claim overlapping the arena', () => {
    expect(touchesArena({ districts: [DB, DA] }, [DA])).toBe(true);
  });

  it('ignores a claim elsewhere', () => {
    expect(touchesArena({ districts: [DB] }, [DA])).toBe(false);
  });

  it('ignores junk payloads', () => {
    expect(touchesArena(null, [DA])).toBe(false);
    expect(touchesArena({ districts: DA }, [DA])).toBe(false);
    expect(touchesArena({ districts: [42, { d: DA }] }, [DA])).toBe(false);
    expect(touchesArena({ districts: Array(MAX_ANNOUNCED_DISTRICTS + 1).fill(DA) }, [DA])).toBe(false);
  });
});

describe('refetchDelay', () => {
  it('refetches at once the first time', () => {
    expect(refetchDelay(null, 1000)).toBe(0);
  });

  it('spaces refetches by the minimum interval', () => {
    expect(refetchDelay(1000, 1000 + 5000)).toBe(LIVE_MIN_INTERVAL_MS - 5000);
    expect(refetchDelay(1000, 1000 + LIVE_MIN_INTERVAL_MS + 1)).toBe(0);
  });
});

describe('announceClaim', () => {
  it('never throws, even when the realtime client is missing', async () => {
    const { announceClaim } = await import('../src/lib/live-territory');
    expect(() => announceClaim([A, B])).not.toThrow();
  });
});

import { describe, expect, it } from 'vitest';

import { SHARE_STATS, columnXs, parseStoredStats, toggleStat } from '../src/lib/share-stats';

describe('toggleStat', () => {
  it('removes and adds, keeping sticker order', () => {
    expect(toggleStat(SHARE_STATS, 'pace')).toEqual(['distance', 'time', 'tiles']);
    expect(toggleStat(['tiles'], 'distance')).toEqual(['distance', 'tiles']);
  });

  it('never leaves the sticker empty', () => {
    expect(toggleStat(['time'], 'time')).toEqual(['time']);
  });
});

describe('columnXs', () => {
  it("matches the sticker's original four-column layout", () => {
    expect(columnXs(4, 300)).toEqual([37.5, 112.5, 187.5, 262.5]);
  });

  it('centres fewer columns evenly', () => {
    expect(columnXs(1, 300)).toEqual([150]);
    expect(columnXs(2, 300)).toEqual([75, 225]);
  });
});

describe('parseStoredStats', () => {
  it('restores a valid selection in sticker order', () => {
    expect(parseStoredStats('["tiles","distance"]')).toEqual(['distance', 'tiles']);
  });

  it('falls back to everything for anything unusable', () => {
    for (const raw of [null, '', 'nope', '{}', '[]', '["speed"]']) {
      expect(parseStoredStats(raw)).toEqual([...SHARE_STATS]);
    }
  });
});

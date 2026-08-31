// run-checkpoint.ts — the in-progress-run equivalent of upload-queue.ts's
// durability guarantees (see that file's test header). This one protects a
// run that hasn't even finished yet: iOS Safari can evict a backgrounded tab
// mid-run, so what's tested here is "does the recorded route survive a
// reload", not tidiness.
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { setPref } from '../src/lib/db';
import {
  clearCheckpoint,
  loadCheckpoint,
  MAX_AGE_MS,
  MAX_POINTS,
  saveCheckpoint,
  type RunCheckpoint,
} from '../src/lib/run-checkpoint';

const PREF_KEY = 'run.checkpoint.v1';

function makeCheckpoint(overrides: Partial<RunCheckpoint> = {}): RunCheckpoint {
  return {
    startedAt: 1000,
    points: [
      { lat: 25.68, lng: -100.31, ts: 1000 },
      { lat: 25.681, lng: -100.311, ts: 2000 },
    ],
    distanceM: 150,
    accumulatedMs: 2000,
    savedAt: Date.now(),
    ...overrides,
  };
}

beforeEach(() => {
  setPref(PREF_KEY, '');
});

describe('saveCheckpoint / loadCheckpoint', () => {
  it('round-trips a checkpoint', () => {
    const cp = makeCheckpoint();
    expect(saveCheckpoint(cp)).toBe(true);
    expect(loadCheckpoint()).toEqual(cp);
  });

  it('returns null when nothing has been saved', () => {
    expect(loadCheckpoint()).toBeNull();
  });

  it('trims to the newest MAX_POINTS, never the oldest', () => {
    const points = Array.from({ length: MAX_POINTS + 50 }, (_, i) => ({
      lat: 25.68,
      lng: -100.31 + i * 0.0001,
      ts: 1000 + i,
    }));
    saveCheckpoint(makeCheckpoint({ points }));
    const loaded = loadCheckpoint();
    expect(loaded?.points).toHaveLength(MAX_POINTS);
    // The newest point survives; the oldest 50 are the ones dropped.
    expect(loaded?.points.at(-1)?.ts).toBe(points.at(-1)?.ts);
    expect(loaded?.points[0].ts).toBe(points[50].ts);
  });
});

describe('loadCheckpoint staleness', () => {
  it('returns a checkpoint saved just now', () => {
    saveCheckpoint(makeCheckpoint({ savedAt: Date.now() }));
    expect(loadCheckpoint()).not.toBeNull();
  });

  it('discards a checkpoint older than MAX_AGE_MS — a leftover, not a live run', () => {
    vi.useFakeTimers();
    try {
      saveCheckpoint(makeCheckpoint({ savedAt: Date.now() }));
      vi.advanceTimersByTime(MAX_AGE_MS + 1000);
      expect(loadCheckpoint()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('loadCheckpoint defensive parsing', () => {
  it('survives a corrupted store instead of throwing', () => {
    setPref(PREF_KEY, 'not json at all');
    expect(loadCheckpoint()).toBeNull();
  });

  it('rejects a malformed checkpoint that would crash a resume', () => {
    setPref(PREF_KEY, JSON.stringify({ startedAt: 1000, points: 'nonsense' }));
    expect(loadCheckpoint()).toBeNull();
  });

  it('rejects a checkpoint whose points are not real coordinates', () => {
    setPref(
      PREF_KEY,
      JSON.stringify({
        startedAt: 1000,
        points: [{ lat: 'x', lng: -100.31, ts: 1000 }],
        distanceM: 0,
        accumulatedMs: 0,
        savedAt: Date.now(),
      }),
    );
    expect(loadCheckpoint()).toBeNull();
  });
});

describe('clearCheckpoint', () => {
  it('removes the checkpoint so a later load finds nothing', () => {
    saveCheckpoint(makeCheckpoint());
    expect(loadCheckpoint()).not.toBeNull();
    expect(clearCheckpoint()).toBe(true);
    expect(loadCheckpoint()).toBeNull();
  });
});

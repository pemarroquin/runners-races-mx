// last-run-debug.ts — the diagnostic escape hatch that turns a suspicious
// area report into a re-runnable buildFence() fixture. Tests are about the
// round-trip and defensive parsing, same shape as run-checkpoint.test.ts.
import { beforeEach, describe, expect, it } from 'vitest';

import { setPref } from '../src/lib/db';
import {
  lastRunDebugToJSON,
  loadLastRunDebug,
  saveLastRunDebug,
  type LastRunDebug,
} from '../src/lib/last-run-debug';

const PREF_KEY = 'debug.lastRun.v1';

function makeDebug(overrides: Partial<LastRunDebug> = {}): LastRunDebug {
  return {
    points: [
      { lat: 25.68, lng: -100.31, ts: 1000 },
      { lat: 25.681, lng: -100.311, ts: 2000 },
    ],
    distanceM: 8250,
    areaM2: 151714,
    startedAt: 1000,
    endedAt: 500_000,
    ...overrides,
  };
}

beforeEach(() => {
  setPref(PREF_KEY, '');
});

describe('saveLastRunDebug / loadLastRunDebug', () => {
  it('round-trips a debug record', () => {
    const d = makeDebug();
    expect(saveLastRunDebug(d)).toBe(true);
    expect(loadLastRunDebug()).toEqual(d);
  });

  it('returns null when nothing has been saved', () => {
    expect(loadLastRunDebug()).toBeNull();
  });

  it('overwrites the previous run rather than accumulating a history', () => {
    saveLastRunDebug(makeDebug({ startedAt: 1000 }));
    saveLastRunDebug(makeDebug({ startedAt: 2000 }));
    expect(loadLastRunDebug()?.startedAt).toBe(2000);
  });

  it('preserves a null areaM2 (no fence formed)', () => {
    saveLastRunDebug(makeDebug({ areaM2: null }));
    expect(loadLastRunDebug()?.areaM2).toBeNull();
  });
});

describe('loadLastRunDebug defensive parsing', () => {
  it('survives a corrupted store instead of throwing', () => {
    setPref(PREF_KEY, 'not json at all');
    expect(loadLastRunDebug()).toBeNull();
  });

  it('rejects a malformed record', () => {
    setPref(PREF_KEY, JSON.stringify({ points: 'nonsense' }));
    expect(loadLastRunDebug()).toBeNull();
  });

  it('rejects points that are not real coordinates', () => {
    setPref(
      PREF_KEY,
      JSON.stringify({
        points: [{ lat: 'x', lng: -100.31, ts: 1000 }],
        distanceM: 0,
        areaM2: null,
        startedAt: 0,
        endedAt: 0,
      }),
    );
    expect(loadLastRunDebug()).toBeNull();
  });
});

describe('lastRunDebugToJSON', () => {
  it('produces JSON that reconstructs the same record', () => {
    const d = makeDebug();
    expect(JSON.parse(lastRunDebugToJSON(d))).toEqual(d);
  });
});

// pilot-instrumentation.ts — the durable counters behind the "pilot
// instrumentation" backlog item. Same pref-store pattern as
// run-checkpoint.ts (see that file's test header): what matters here is that
// increments accumulate correctly per key, other keys stay untouched, and
// malformed/missing storage never throws — this is instrumentation riding
// alongside real decision points, so it must degrade quietly rather than
// affect the run it's observing.
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as db from '../src/lib/db';
import { setPref } from '../src/lib/db';
import { getPilotCounters, incrementPilotCounter } from '../src/lib/pilot-instrumentation';

const PREF_KEY = 'pilot.counters.v1';

beforeEach(() => {
  setPref(PREF_KEY, '');
});

describe('getPilotCounters', () => {
  it('defaults to all zeros when nothing has been saved', () => {
    expect(getPilotCounters()).toEqual({
      backgroundEvents: 0,
      watchRestarts: 0,
      runsRecovered: 0,
      runsLost: 0,
      runsPaceGuarded: 0,
    });
  });

  it('defaults to all zeros instead of throwing on corrupted JSON', () => {
    setPref(PREF_KEY, 'not json at all');
    expect(getPilotCounters()).toEqual({
      backgroundEvents: 0,
      watchRestarts: 0,
      runsRecovered: 0,
      runsLost: 0,
      runsPaceGuarded: 0,
    });
  });

  it('defaults to all zeros instead of throwing on a malformed shape', () => {
    setPref(PREF_KEY, JSON.stringify({ backgroundEvents: 'nonsense' }));
    expect(getPilotCounters()).toEqual({
      backgroundEvents: 0,
      watchRestarts: 0,
      runsRecovered: 0,
      runsLost: 0,
      runsPaceGuarded: 0,
    });
  });

  it('defaults to all zeros when the stored value is not an object', () => {
    setPref(PREF_KEY, JSON.stringify(42));
    expect(getPilotCounters()).toEqual({
      backgroundEvents: 0,
      watchRestarts: 0,
      runsRecovered: 0,
      runsLost: 0,
      runsPaceGuarded: 0,
    });
  });
});

describe('incrementPilotCounter', () => {
  it('increments a single key from zero', () => {
    incrementPilotCounter('backgroundEvents');
    expect(getPilotCounters().backgroundEvents).toBe(1);
  });

  it('accumulates repeated increments on the same key', () => {
    incrementPilotCounter('watchRestarts');
    incrementPilotCounter('watchRestarts');
    incrementPilotCounter('watchRestarts');
    expect(getPilotCounters().watchRestarts).toBe(3);
  });

  it('leaves other keys untouched', () => {
    incrementPilotCounter('runsRecovered');
    incrementPilotCounter('runsRecovered');
    incrementPilotCounter('runsLost');
    expect(getPilotCounters()).toEqual({
      backgroundEvents: 0,
      watchRestarts: 0,
      runsRecovered: 2,
      runsLost: 1,
      runsPaceGuarded: 0,
    });
  });

  it('increments every key independently across the full set', () => {
    incrementPilotCounter('backgroundEvents');
    incrementPilotCounter('watchRestarts');
    incrementPilotCounter('watchRestarts');
    incrementPilotCounter('runsRecovered');
    incrementPilotCounter('runsRecovered');
    incrementPilotCounter('runsRecovered');
    incrementPilotCounter('runsLost');
    incrementPilotCounter('runsLost');
    incrementPilotCounter('runsLost');
    incrementPilotCounter('runsLost');
    incrementPilotCounter('runsPaceGuarded');
    incrementPilotCounter('runsPaceGuarded');
    incrementPilotCounter('runsPaceGuarded');
    incrementPilotCounter('runsPaceGuarded');
    incrementPilotCounter('runsPaceGuarded');
    expect(getPilotCounters()).toEqual({
      backgroundEvents: 1,
      watchRestarts: 2,
      runsRecovered: 3,
      runsLost: 4,
      runsPaceGuarded: 5,
    });
  });

  it('recovers a corrupted counters value instead of throwing, then counts from zero', () => {
    setPref(PREF_KEY, 'not json at all');
    expect(() => incrementPilotCounter('runsLost')).not.toThrow();
    expect(getPilotCounters().runsLost).toBe(1);
  });

  it('never throws even if the underlying store rejects the write', () => {
    const spy = vi.spyOn(db, 'setPref').mockReturnValue(false);
    try {
      expect(() => incrementPilotCounter('backgroundEvents')).not.toThrow();
    } finally {
      spy.mockRestore();
    }
  });
});

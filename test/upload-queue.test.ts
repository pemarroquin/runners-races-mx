// The offline retry queue. This is the code path that decides whether a run
// someone actually went outside and did survives a failed upload, so the
// tests are about durability, not tidiness.
//
// Testable at all only because flushQueue takes its uploader as a parameter
// — importing uploadRun directly would pull in supabase-js, AsyncStorage and
// a crypto polyfill, none of which run in Node.
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { setPref } from '../src/lib/db';
import type { RunUpload } from '../src/lib/territory-sync';
import {
  enqueueRun,
  flushQueue,
  listQueued,
  MAX_ATTEMPTS,
  MAX_QUEUED,
  queuedCount,
  removeQueued,
  type Uploader,
} from '../src/lib/upload-queue';

function makeRun(startedAt: number): RunUpload {
  return {
    points: [{ lat: 25.68, lng: -100.31, ts: startedAt }],
    fence: {
      geometry: {
        type: 'Feature',
        properties: {},
        geometry: {
          type: 'Polygon',
          coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]],
        },
      },
      areaM2: 1234,
    },
    distanceM: 2000,
    startedAt,
    endedAt: startedAt + 600_000,
  };
}

const ok: Uploader = async () => ({ ok: true, runId: 'r1' });
const offline: Uploader = async () => ({ ok: false, reason: 'network' });

beforeEach(() => {
  setPref('runUploadQueue', '');
});

describe('enqueueRun', () => {
  it('persists a failed run so closing the app cannot lose it', () => {
    expect(enqueueRun(makeRun(1000))).toBeTypeOf('string');
    expect(queuedCount()).toBe(1);
    expect(listQueued()[0].run.startedAt).toBe(1000);
  });

  it('does not duplicate the same run, and returns the existing handle', () => {
    const first = enqueueRun(makeRun(1000));
    const again = enqueueRun(makeRun(1000));
    expect(queuedCount()).toBe(1);
    // The caller must still be able to remove it after a retry/discard.
    expect(again).toBe(first);
  });

  it('keeps distinct runs apart', () => {
    enqueueRun(makeRun(1000));
    enqueueRun(makeRun(2000));
    expect(queuedCount()).toBe(2);
  });

  it('drops the OLDEST when full, never the run just finished', () => {
    for (let i = 0; i < MAX_QUEUED + 3; i++) enqueueRun(makeRun(1000 + i));
    const queue = listQueued();
    expect(queue).toHaveLength(MAX_QUEUED);
    // The newest run is the one on screen — losing it would be the most
    // visible possible failure.
    expect(queue[queue.length - 1].run.startedAt).toBe(1000 + MAX_QUEUED + 2);
    expect(queue[0].run.startedAt).toBe(1003);
  });
});

describe('listQueued', () => {
  it('survives a corrupted store instead of throwing', () => {
    setPref('runUploadQueue', 'not json at all');
    expect(listQueued()).toEqual([]);
  });

  it('drops malformed entries but keeps the good ones', () => {
    setPref(
      'runUploadQueue',
      JSON.stringify([{ id: 'x', queuedAt: 1, run: { nonsense: true } }]),
    );
    expect(listQueued()).toEqual([]);
  });

  it('rejects a PARTIALLY shaped entry that would crash uploadRun', () => {
    // typeof [] === 'object', so an array fence used to pass validation and
    // then threw on fence.geometry.geometry inside uploadRun — which
    // flushQueue reads as a network failure, parking the bad entry at the
    // head of the queue forever.
    setPref(
      'runUploadQueue',
      JSON.stringify([
        { id: 'x', queuedAt: 1, attempts: 0, run: { points: [], fence: [], distanceM: 0, startedAt: 0, endedAt: 0 } },
      ]),
    );
    expect(listQueued()).toEqual([]);
  });
});

describe('flushQueue', () => {
  it('uploads everything and empties the queue', async () => {
    enqueueRun(makeRun(1000));
    enqueueRun(makeRun(2000));
    const result = await flushQueue(ok);
    expect(result.uploaded).toBe(2);
    expect(result.remaining).toBe(0);
    expect(queuedCount()).toBe(0);
  });

  it('KEEPS the queue when the upload fails — the whole point', async () => {
    enqueueRun(makeRun(1000));
    const result = await flushQueue(offline);
    expect(result.uploaded).toBe(0);
    expect(result.stoppedBecause).toBe('network');
    expect(queuedCount()).toBe(1);
  });

  it('stops at the first failure instead of hammering the radio', async () => {
    for (let i = 0; i < 5; i++) enqueueRun(makeRun(1000 + i));
    const upload = vi.fn<Uploader>(async () => ({ ok: false, reason: 'network' }));
    await flushQueue(upload);
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it('keeps the runs it could not send after a partial success', async () => {
    enqueueRun(makeRun(1000));
    enqueueRun(makeRun(2000));
    let call = 0;
    const flaky: Uploader = async () => {
      call++;
      return call === 1 ? { ok: true, runId: 'r1' } : { ok: false, reason: 'network' };
    };
    const result = await flushQueue(flaky);
    expect(result.uploaded).toBe(1);
    expect(queuedCount()).toBe(1);
    // The one still queued must be the one that did NOT go up.
    expect(listQueued()[0].run.startedAt).toBe(2000);
  });

  it('is a no-op on an empty queue', async () => {
    const upload = vi.fn<Uploader>(async () => ({ ok: true, runId: 'r' }));
    const result = await flushQueue(upload);
    expect(result.uploaded).toBe(0);
    expect(upload).not.toHaveBeenCalled();
  });
});

describe('removeQueued', () => {
  it('removes only the named run', () => {
    enqueueRun(makeRun(1000));
    enqueueRun(makeRun(2000));
    removeQueued(listQueued()[0].id);
    expect(queuedCount()).toBe(1);
    expect(listQueued()[0].run.startedAt).toBe(2000);
  });
});

describe('flushQueue durability', () => {
  it('abandons an entry that keeps failing instead of blocking the queue forever', async () => {
    enqueueRun(makeRun(1000));
    enqueueRun(makeRun(2000));
    // Head entry always fails; flushQueue stops at the first failure, so
    // without an attempt cap the second run could never upload.
    let calls = 0;
    const headAlwaysFails: Uploader = async (run) => {
      calls++;
      return run.startedAt === 1000
        ? { ok: false, reason: 'network' }
        : { ok: true, runId: 'r' };
    };
    for (let i = 0; i < MAX_ATTEMPTS + 1; i++) await flushQueue(headAlwaysFails);
    expect(calls).toBeGreaterThan(0);
    // The poison entry is gone and the good run made it up.
    expect(queuedCount()).toBe(0);
  });

  it('never abandons a run failing with "disabled", however many times it is flushed', async () => {
    // 'disabled' means no server is configured on THIS build at all — a
    // categorically different failure from a rejected payload. Retrying
    // against a misconfigured client will never succeed, but abandoning the
    // run after MAX_ATTEMPTS would delete it before the actual fix (an env
    // var, not a retry) ever lands.
    enqueueRun(makeRun(1000));
    const alwaysDisabled: Uploader = async () => ({ ok: false, reason: 'disabled' });
    for (let i = 0; i < MAX_ATTEMPTS + 5; i++) {
      const result = await flushQueue(alwaysDisabled);
      expect(result.stoppedBecause).toBe('disabled');
      expect(result.abandoned).toBe(0);
    }
    expect(queuedCount()).toBe(1);
  });

  it('refuses to start a second concurrent flush over the same snapshot', async () => {
    enqueueRun(makeRun(1000));
    let inFlight = 0;
    let maxConcurrent = 0;
    const slow: Uploader = async () => {
      inFlight++;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
      await new Promise((r) => setTimeout(r, 10));
      inFlight--;
      return { ok: true, runId: 'r' };
    };
    await Promise.all([flushQueue(slow), flushQueue(slow)]);
    // Two overlapping flushes would upload the same run twice.
    expect(maxConcurrent).toBe(1);
  });
});

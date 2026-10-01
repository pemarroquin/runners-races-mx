// Tile claims that failed after their run saved are retried, never lost to
// a signal blip, and dropped only on the server's final answer.
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { setPref } from '../src/lib/db';
import { enqueueClaim, flushClaims, listClaims, type ClaimRetryOutcome } from '../src/lib/claim-queue';
import { MAX_ATTEMPTS, SLOW_RETRY_MS } from '../src/lib/upload-queue';

const claim = (runId: string) => ({ runId, visited: ['a'], enclosed: ['b'], region: 'mty' });

beforeEach(() => {
  setPref('tileClaimQueue', '[]');
});

describe('claim queue', () => {
  it('keeps one pending claim per run', () => {
    enqueueClaim(claim('r1'));
    enqueueClaim(claim('r1'));
    expect(listClaims()).toHaveLength(1);
  });

  it('drops a claim once it lands', async () => {
    enqueueClaim(claim('r1'));
    const res = await flushClaims(async () => ({ ok: true }));
    expect(res.claimed).toBe(1);
    expect(listClaims()).toHaveLength(0);
  });

  it("drops a claim on the server's final answer, and only then", async () => {
    enqueueClaim(claim('old'));
    enqueueClaim(claim('bad'));
    const final = async (c: { runId: string }): Promise<ClaimRetryOutcome> =>
      c.runId === 'old' ? { ok: false, reason: 'tooOld' } : { ok: false, reason: 'rejected' };
    await flushClaims(final);
    expect(listClaims()).toHaveLength(0);
  });

  it('keeps a claim that failed on the network, and stops (radio rule)', async () => {
    enqueueClaim(claim('r1'));
    enqueueClaim(claim('r2'));
    const fn = vi.fn(async (): Promise<ClaimRetryOutcome> => ({ ok: false, reason: 'network' }));
    await flushClaims(fn, 0);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(listClaims()).toHaveLength(2);
  });

  it('never abandons a failing claim; drops to one retry a day', async () => {
    enqueueClaim(claim('r1'));
    const fn = vi.fn(async (): Promise<ClaimRetryOutcome> => ({ ok: false, reason: 'network' }));
    for (let i = 0; i < MAX_ATTEMPTS; i++) await flushClaims(fn, 10 + i);
    await flushClaims(fn, 10 + MAX_ATTEMPTS);
    expect(fn).toHaveBeenCalledTimes(MAX_ATTEMPTS);
    await flushClaims(fn, 10 + MAX_ATTEMPTS + SLOW_RETRY_MS);
    expect(fn).toHaveBeenCalledTimes(MAX_ATTEMPTS + 1);
    expect(listClaims()).toHaveLength(1);
  });

  it('never counts "disabled" as an attempt', async () => {
    enqueueClaim(claim('r1'));
    for (let i = 0; i < MAX_ATTEMPTS + 3; i++) await flushClaims(async () => ({ ok: false, reason: 'disabled' }), i);
    expect(listClaims()[0].attempts).toBe(0);
  });
});

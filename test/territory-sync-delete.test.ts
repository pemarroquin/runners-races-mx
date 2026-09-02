// deleteRun's specific contract (Task 2 of the auto-save/delete change):
// zero rows returned from the delete must be reported as a FAILURE, never
// as success — this is the exact silent-no-op trap `runs` has no delete RLS
// policy for yet (see supabase/migrations/*_runs_delete_own.sql, unapplied).
//
// Separate file from territory-sync.test.ts, which mocks '@/lib/supabase'
// with TERRITORY_ENABLED: false and a bare `supabase: {}` — enough for
// parseRawPath (a pure function) but not for deleteRun, which needs a real
// session and a chainable `.from().delete().eq().eq().select()` to exercise.
// Importing '@/lib/territory-sync' for real pulls in @supabase/supabase-js,
// which schedules an internal timer that throws under Node — so this mocks
// '@/lib/supabase' completely, same reasoning as territory-sync.test.ts's
// header.
import { describe, expect, it, vi } from 'vitest';

type Result = { data: unknown; error: unknown };

let nextResult: Result = { data: null, error: null };

// A minimal stand-in for supabase-js's PostgrestFilterBuilder: `.delete()`
// and `.eq()` return the same chainable object (so call order/count don't
// matter), and `.select()` is the terminal call that resolves to whatever
// this test set up via `nextResult` — matching deleteRun's own
// `.from('runs').delete().eq('id', ...).eq('user_id', ...).select('id')`
// shape exactly.
function makeChain(): Record<string, unknown> {
  const chain: Record<string, unknown> = {
    delete: () => chain,
    eq: () => chain,
    select: () => Promise.resolve(nextResult),
  };
  return chain;
}

vi.mock('@/lib/supabase', () => ({
  supabase: { from: () => makeChain() },
  ensureSession: async () => ({ user: { id: 'user-1' } }),
  TERRITORY_ENABLED: true,
}));

const { deleteRun } = await import('@/lib/territory-sync');

describe('deleteRun', () => {
  it('reports failure when the delete matches zero rows, even with no error', () => {
    // The exact shape RLS returns for a DELETE that matches no policy: no
    // error, an empty array. A naive `.delete().eq(...)` (no `.select()`)
    // can't even observe this — this is precisely why deleteRun chains one.
    nextResult = { data: [], error: null };
    return deleteRun('run-1').then((outcome) => {
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.reason).toBe('network');
    });
  });

  it('reports failure when data comes back null, even with no error', () => {
    nextResult = { data: null, error: null };
    return deleteRun('run-1').then((outcome) => {
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.reason).toBe('network');
    });
  });

  it('reports failure when Postgres returns an error', () => {
    nextResult = { data: null, error: { message: 'boom' } };
    return deleteRun('run-1').then((outcome) => {
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.reason).toBe('network');
    });
  });

  it('reports success only when a row actually came back', () => {
    nextResult = { data: [{ id: 'run-1' }], error: null };
    return deleteRun('run-1').then((outcome) => {
      expect(outcome).toEqual({ ok: true });
    });
  });
});

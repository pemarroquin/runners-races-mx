// Migration filenames. The Supabase CLI keys a migration by its numeric
// prefix and matches local files to the remote history table by that
// string, so the prefix is an identity, not a label.
//
// Two early files carry a date-only prefix. They are WRONG and they STAY:
// both are applied in production under exactly those versions (verified
// 2026-09-02, `supabase migration list --linked`). Renaming one to its
// 14-digit form makes the CLI see a brand-new, never-applied migration, and
// `db push` re-runs it — which aborts on its first `create policy` (no IF
// NOT EXISTS), the drift trap BACKLOG.md and memory both record. A real
// rename is a file move PLUS `supabase migration repair` on the remote
// history (old version reverted, new version applied), done together.
//
// They still sort correctly: the CLI orders versions as strings, and
// "20260827" < "20260827010000", "20260901" < "20260902222537".
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const DIR = path.resolve(__dirname, '../supabase/migrations');
const GRANDFATHERED = new Set(['20260827_anti_cheat_flag.sql', '20260901_fence_path_forgery_guard.sql']);
const NAME = /^(\d{14})_[a-z0-9_]+\.sql$/;

const files = readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();

describe('supabase migration filenames', () => {
  it('use a 14-digit timestamp prefix, except the two already applied without one', () => {
    const bad = files.filter((f) => !GRANDFATHERED.has(f) && !NAME.test(f));
    expect(bad).toEqual([]);
  });

  it('still contain both grandfathered files under their applied names', () => {
    // If one disappears it was renamed — check the remote history was
    // repaired in the same change before deleting it from this list.
    for (const f of GRANDFATHERED) expect(files).toContain(f);
  });

  it('never reuse a version', () => {
    const versions = files.map((f) => f.split('_')[0]);
    expect(new Set(versions).size).toBe(versions.length);
  });

  it('replay in timestamp order, except one known, harmless inversion', () => {
    // A fresh replay (db reset, a branch database) applies files in byte
    // order of their NAMES, and '_' (0x5F) sorts after every digit — so
    // 20260827_anti_cheat_flag runs AFTER 20260827010000 and 20260827020000,
    // though its version compares before them. Checked 2026-10-23: it only
    // adds runs.flagged/flag_reason and its own trigger, and neither of the
    // other two touches those, so the order between them doesn't matter.
    // Any OTHER inversion fails here.
    const byName = [...files].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const byTime = [...files].sort((a, b) => {
      const ta = a.split('_')[0].padEnd(14, '0');
      const tb = b.split('_')[0].padEnd(14, '0');
      return ta < tb ? -1 : ta > tb ? 1 : 0;
    });
    const known = '20260827_anti_cheat_flag.sql';
    expect(byName.filter((f) => f !== known)).toEqual(byTime.filter((f) => f !== known));
    expect(byName.indexOf(known)).toBe(byName.indexOf('20260827020000_phase3_overlap.sql') + 1);
  });
});

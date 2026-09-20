# supabase/backfills/

SQL that **rewrites existing rows**. Not migrations, and deliberately not in
`supabase/migrations/`.

A migration changes how the database behaves from now on. A backfill changes
data that is already there. Bundling the two means one paste into the SQL
editor decides both, and there is then no way to keep the fix and undo the
rewrite. Every file here is applied separately, after its migration, as its
own decision.

Nothing in this repo runs either kind automatically. `supabase migration list`
does not know about hand-applied files and will lie about what is installed —
never use it as evidence.

Each file carries its own BEFORE queries, transaction, AFTER queries and
rollback. Read the whole file before pasting any of it.

---

## Apply-and-verify: `claim_run_id` provenance (2026-09-20)

Two files, in this order. Do not reorder them and do not merge the pastes.

- `supabase/migrations/20260920140000_claim_run_id_provenance.sql`
- `supabase/backfills/20260920_claim_run_id_provenance.sql`

**Why the order is not negotiable:** the backfill rewrites provenance from
`first_claimed_at`. If the old function is still installed, the next run
uploaded re-stamps `claim_run_id` on every tile it crosses and undoes the
repair for that ground. Fix the writer, then fix the data.

### 1. Apply the migration

Paste the whole file into the Supabase SQL editor and run it. It is a
`create or replace function` — no drop, no downtime, the signature is
unchanged.

Expected: `Success. No rows returned.`

**This proves nothing yet.** plpgsql plans a function body lazily: a broken
body installs perfectly cleanly and only fails on the first real call. This
repo has been bitten by exactly that. Step 2 is the actual test.

### 2. Prove the function works — record a real run

On the phone (or the web build), record a short run **over ground you already
own** and let it finish and upload. That path is the whole point: it is the
case the old function got wrong.

- **PASS** — the run saves, the summary screen shows its stats, and the
  conquest banner reads a small "claimed"/"taken" count with no error toast.
- **STOP** — any upload error, or a summary that reports 0 tiles for a run
  that clearly covered ground. Re-apply
  `supabase/migrations/20260915120000_conquest_taken_cells.sql` verbatim to
  restore the previous function (it drops and recreates; that is fine and is
  the documented rollback), then report what the error said.

Then check the counts add up, replacing `<run-id>` with the run you just
recorded:

```sql
select
  (select count(*) from territory_tiles where claim_run_id = '<run-id>') as tagged_to_this_run,
  (select count(*) from tile_visits      where run_id       = '<run-id>') as visited_by_this_run;
```

- **PASS** — `tagged_to_this_run` is SMALL: only the cells this run genuinely
  won. On ground you already owned it may legitimately be 0 or 1. That is the
  fix working.
- **STOP** — `tagged_to_this_run` is in the hundreds or thousands after a
  re-run over owned ground. That is the old behaviour; the migration did not
  take.

### 3. Confirm nothing else regressed

`auth.uid()` is null in the SQL editor (it runs as `postgres`, not as a
signed-in user), so these take the owner id literally —
`30ef31c5-c6f0-4efa-b90c-d283f087831b` is the one measured on 2026-09-20.

```sql
-- Your ground did not move. Compare to what you held before the run.
select count(*) from territory_tiles
where owner_id = '30ef31c5-c6f0-4efa-b90c-d283f087831b';

-- last_visited_at still bumps on every tile the run touched, won or not.
select count(*) from territory_tiles
where owner_id = '30ef31c5-c6f0-4efa-b90c-d283f087831b'
  and last_visited_at > now() - interval '1 hour';

-- region_id backfill still fires: this should not grow.
select count(*) from territory_tiles where region_id is null;
```

The first must be unchanged or slightly higher, never lower. The second must
be roughly the size of the run's footprint, not 0. The third must be the same
or lower than before.

### 4. Only now, the backfill

Run `supabase/backfills/20260920_claim_run_id_provenance.sql` section by
section — §1 (save the output), §2 (one paste), §3 (compare). Every query in
it states its own PASS and STOP conditions.

Two things to watch for specifically:

- §2 is one transaction that **disables the immutability trigger** and
  re-enables it. A failure anywhere rolls the disable back with everything
  else, and §2.6 asserts the trigger is on before committing. Run §3 query
  3.6 afterwards anyway. If it ever reads `D`, run
  `alter table territory_tiles enable trigger territory_tiles_immutable;`
  immediately — until you do, anyone holding the anon key can reassign any
  tile to themselves.
- §3 query 3.3 must return **0**. That single number is the success
  condition.

### 5. Check the app

Open My Achievements. Expect distinct territory components in **different
colours** instead of one blob, and per-run tile counts in the detail bubble
that match the run that actually won the ground.

If a territory the map used to draw has disappeared, that is the one
regression shape worth reverting for: run §4's rollback and report it.

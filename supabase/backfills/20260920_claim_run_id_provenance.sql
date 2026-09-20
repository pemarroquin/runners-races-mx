-- BACKFILL — reconstruct territory_tiles.claim_run_id from first_claimed_at.
--
-- THIS IS NOT A MIGRATION AND MUST NOT BE RUN AS ONE. It lives in
-- supabase/backfills/ precisely so that "fix the function" and "rewrite
-- 6,049 rows of live data" stay two separate, independently-reversible
-- decisions. Apply
-- supabase/migrations/20260920140000_claim_run_id_provenance.sql FIRST and
-- verify it, then decide about this file. Running this while the OLD
-- function is still installed is pointless: the next run uploaded would
-- immediately re-corrupt every tile it crosses.
--
-- WHAT IT REPAIRS. The old claim_run_tiles re-stamped claim_run_id onto the
-- newest run on EVERY re-visit, so claim_run_id today means "the last run
-- that stepped here". first_claimed_at was never in that SET list, so it is
-- intact, and on INSERT it is written as the claiming run's `ended_at`
-- (`select unnest(all_cells), r.user_id, r.ended_at, r.id, r.ended_at, ...`).
-- That makes the reconstruction EXACT for the common case: the tile belongs
-- to the run of its current owner whose ended_at equals its first_claimed_at.
--
-- HOW TO RUN IT. Supabase SQL editor, by hand, section by section:
--   §1 BEFORE queries — run them and SAVE the output. They are the only
--      evidence you will have that anything changed.
--   §2 the transaction — one paste, one run. It is a single transaction: if
--      any assertion inside fails, EVERYTHING rolls back, including the
--      trigger disable in step 2.3.
--   §3 AFTER queries — run them and compare against §1's expectations.
--
-- IDEMPOTENCY: the UPDATE itself is idempotent (it derives its answer from
-- first_claimed_at, which nothing ever rewrites, and skips rows already
-- correct). The BACKUP is not, deliberately: `create table ... as` on a
-- second run fails with 42P07 duplicate_table and aborts the whole
-- transaction before touching a single row. That is the intended guard — a
-- second run is refused loudly rather than silently overwriting the only
-- copy of the pre-backfill state. If you genuinely need to re-run it, rename
-- the backup table in step 2.1 to a new date; never drop the first one.
--
-- ============================================================================
-- THE THREE CASES WHERE THE RECONSTRUCTION IS NOT EXACT
-- ============================================================================
--
-- 1. RETRO-ENCLOSED CELLS — LEFT ALONE, DELIBERATELY.
--    412 rows were inserted by hand on 2026-09-20 (retro-enclose.sql, see
--    Design Decisions.md) with first_claimed_at = '2026-09-20T06:28:34.101Z',
--    the insert's own clock. No run has that ended_at, so nothing matches and
--    the join below simply does not touch them. They keep their current
--    claim_run_id, ebf11064-67ac-4bd0-a1a8-848cc4d89073, which was a guess at
--    the time and still is.
--    Why not NULL them to be honest about it: fetchMyClaimedCells groups by
--    claim_run_id and achievements-view.tsx then looks each group up against
--    the runner's own fences (`cellsByRun.get(f.id)`), so cells under a
--    claim_run_id that is not one of their runs are DROPPED from the map
--    entirely. NULLing would erase 412 cells of real, owned territory from
--    My Achievements to make a column tidier. A wrong-but-plausible pointer
--    to a real run of the right owner is the lesser evil here, and §3's
--    query 5 keeps it visible rather than letting it disappear into the
--    general population. If the true winning run is ever established, patch
--    those 412 rows on their own, with their own backup.
--
-- 2. CONQUERED TILES — LEFT ALONE, DELIBERATELY.
--    first_claimed_at belongs to the ORIGINAL claimer and is never updated,
--    but owner_id is now the taker's. The join is on
--    `r.user_id = t.owner_id AND r.ended_at = t.first_claimed_at`, so these
--    resolve to nothing and are not touched — which is correct, because
--    resolving them on first_claimed_at ALONE would attribute the tile to a
--    rival's run and then every consumer would read it as territory held by
--    somebody else's run. Which of the taker's runs actually won it is not
--    recoverable from this table: the winning event was never recorded per
--    tile (territory_events records fence-area loss between runs, not cells).
--    What they keep is the taker's most recent run over that ground — the
--    right USER, possibly the wrong run of that user. That is strictly
--    better than the alternatives available offline.
--    §3's query 4 counts them so the size of this bucket is known rather
--    than assumed; on a single-runner production database it is expected to
--    be 0, and a non-zero count there is a real finding, not noise.
--
-- 3. TIES — REFUSED LOUDLY.
--    Two runs of the SAME user with an identical ended_at would make the
--    join produce two candidate rows for one tile, and Postgres would pick
--    one arbitrarily and non-deterministically. Step 2.2 raises before the
--    UPDATE runs and the transaction rolls back. Do not "resolve" a tie by
--    picking the smaller id — if this ever fires, look at the two runs
--    first; two runs ending at the same instant is itself suspicious.
--
-- ============================================================================
-- THE IMMUTABILITY TRIGGER HAS TO COME OFF FOR THIS, AND THAT IS THE RISK
-- ============================================================================
-- enforce_territory_tiles_immutable() (20260908010000) raises whenever
-- claim_run_id changes without claimed_at strictly increasing. This backfill
-- changes claim_run_id and deliberately does NOT touch claimed_at (see the
-- migration's header: claimed_at is the conquest clock, not provenance), so
-- every single row would be rejected with the trigger attached.
--
-- It is disabled and re-enabled inside ONE transaction. ALTER TABLE is
-- transactional in Postgres, so a failure at any point rolls the disable
-- back with everything else — there is no path through this file that
-- commits with the trigger off. Step 2.6 asserts it is back on before the
-- commit, and §3's query 6 asserts it again afterwards from the outside.
-- CHECK THAT QUERY. While this trigger is off, anyone holding the anon key
-- — which ships in the web bundle — can reassign any tile to themselves with
-- a plain PostgREST UPDATE.
--
-- `alter table ... disable trigger` requires table ownership; the SQL editor
-- runs as `postgres`, which owns every table in `public`. If it is somehow
-- refused, do NOT reach for `set session_replication_role = 'replica'` as a
-- workaround without understanding that it disables EVERY trigger on EVERY
-- table for the session, including the anti-cheat and plausibility guards.


-- ============================================================================
-- §1 — BEFORE. Run these first and keep the output.
-- ============================================================================

-- 1.1  Provenance distribution. THIS IS THE HEADLINE QUERY; §3 runs it again.
--      Expected BEFORE (production, 2026-09-20, owner 30ef31c5, 6,049 tiles):
--        070cb7d6…  2551 cells, oldest first_claimed_at 2026-09-03
--        b0982352…  2186 cells, oldest first_claimed_at 2026-09-02
--        11acc3bd…   474 cells, oldest first_claimed_at 2026-09-04
--        holds_tiles_predating_its_own_run = true for all three.
--      Expected AFTER: many more rows, each much smaller, and
--        holds_tiles_predating_its_own_run false (or null) for every row
--        except the two documented unresolved buckets (§3 queries 4 and 5).
--        11acc3bd in particular should hold ONE cell.
select
  t.claim_run_id,
  count(*)                    as cells,
  min(t.first_claimed_at)     as oldest_first_claim,
  r.started_at                as run_started_at,
  r.ended_at                  as run_ended_at,
  (min(t.first_claimed_at) < r.started_at) as holds_tiles_predating_its_own_run
from territory_tiles t
left join runs r on r.id = t.claim_run_id
group by t.claim_run_id, r.started_at, r.ended_at
order by cells desc;

-- 1.2  How many rows this backfill CANNOT resolve, and why.
--      This number must be IDENTICAL before and after — the backfill changes
--      no owner_id and no first_claimed_at, so it cannot move.
select
  count(*) filter (
    where not exists (
      select 1 from runs r
      where r.user_id = t.owner_id and r.ended_at = t.first_claimed_at
    )
  ) as unresolvable,
  count(*) filter (where t.claim_run_id is null) as null_provenance,
  count(*)                                       as total_rows
from territory_tiles t;

-- 1.3  Tie check. MUST RETURN ZERO ROWS. If it returns anything, STOP —
--      step 2.2 will refuse anyway, but know about it before you paste.
select user_id, ended_at, count(*) as runs_ending_at_the_same_instant
from runs
group by user_id, ended_at
having count(*) > 1;

-- 1.4  The 412 retro-enclosed rows, so the same query in §3 can prove they
--      were not touched. Expected: one row, ebf11064-67ac-4bd0-a1a8-848cc4d89073,
--      count 412.
select claim_run_id, count(*) as cells
from territory_tiles
where first_claimed_at = '2026-09-20T06:28:34.101Z'
group by claim_run_id;

-- 1.5  How many rows the UPDATE will actually rewrite. Compare against the
--      "UPDATE n" the editor reports in §2.
select count(*) as rows_to_change
from territory_tiles t
join runs r on r.user_id = t.owner_id and r.ended_at = t.first_claimed_at
where t.claim_run_id is distinct from r.id;


-- ============================================================================
-- §2 — THE TRANSACTION. One paste, one run.
-- ============================================================================

begin;

-- 2.1  Undo. 6,049 rows is nothing; there is no excuse for not having this.
--      Fails with 42P07 on a second run, which aborts everything — intended.
create table territory_tiles_backup_20260920 as select * from territory_tiles;

-- 2.2  Refuse on a tie rather than pick arbitrarily (case 3 above).
do $$
declare n integer;
begin
  select count(*) into n from (
    select user_id, ended_at from runs group by user_id, ended_at having count(*) > 1
  ) ties;
  if n > 0 then
    raise exception
      'BACKFILL ABORTED: % (user_id, ended_at) pair(s) are shared by more than one run. '
      'The h3 -> run match would be non-deterministic. Inspect those runs by hand first.', n;
  end if;
end $$;

-- 2.3  Off it comes. See the header for what this exposes while it is off.
alter table territory_tiles disable trigger territory_tiles_immutable;

-- 2.4  The repair. Exact for every tile still held by its original claimer;
--      touches nothing else (cases 1 and 2 above fall out of the join).
update territory_tiles t
set claim_run_id = w.run_id
from (
  select tt.h3, r.id as run_id
  from territory_tiles tt
  join runs r
    on r.user_id  = tt.owner_id
   and r.ended_at = tt.first_claimed_at
) w
where w.h3 = t.h3
  and t.claim_run_id is distinct from w.run_id;

-- 2.5  Back on.
alter table territory_tiles enable trigger territory_tiles_immutable;

-- 2.6  Assertions. Any raise here rolls back the whole transaction,
--      trigger state included.
do $$
declare
  n   integer;
  tg  "char";
begin
  -- Nothing was created or destroyed.
  select count(*) into n from territory_tiles;
  if n <> (select count(*) from territory_tiles_backup_20260920) then
    raise exception 'BACKFILL ABORTED: row count changed (% now)', n;
  end if;

  -- claim_run_id is the ONLY column that may differ from the backup.
  select count(*) into n
  from territory_tiles t
  join territory_tiles_backup_20260920 b on b.h3 = t.h3
  where t.owner_id         is distinct from b.owner_id
     or t.first_claimed_at is distinct from b.first_claimed_at
     or t.claimed_at       is distinct from b.claimed_at
     or t.last_visited_at  is distinct from b.last_visited_at
     or t.region_id        is distinct from b.region_id;
  if n > 0 then
    raise exception 'BACKFILL ABORTED: % row(s) changed a column other than claim_run_id', n;
  end if;

  -- No tile may point at a run belonging to a different user.
  select count(*) into n
  from territory_tiles t
  join runs r on r.id = t.claim_run_id
  where r.user_id <> t.owner_id;
  if n > 0 then
    raise exception 'BACKFILL ABORTED: % tile(s) attributed to another user''s run', n;
  end if;

  -- Every row the join could resolve now points at that run.
  select count(*) into n
  from territory_tiles t
  join runs r on r.user_id = t.owner_id and r.ended_at = t.first_claimed_at
  where t.claim_run_id is distinct from r.id;
  if n > 0 then
    raise exception 'BACKFILL ABORTED: % resolvable row(s) did not take the repair', n;
  end if;

  -- The guard is back on. 'O' = enabled (origin).
  select tgenabled into tg from pg_trigger
  where tgrelid = 'territory_tiles'::regclass and tgname = 'territory_tiles_immutable';
  if tg is distinct from 'O' then
    raise exception 'BACKFILL ABORTED: territory_tiles_immutable is not enabled (tgenabled=%)', tg;
  end if;
end $$;

commit;


-- ============================================================================
-- §3 — AFTER. Run these and compare against §1.
-- ============================================================================

-- 3.1  The headline query again (identical to 1.1).
--      PASS: no run holds tiles that predate its own start —
--            holds_tiles_predating_its_own_run is false or null on every row
--            EXCEPT rows whose claim_run_id is one of the unresolved buckets
--            below. Row count is much higher, per-run counts much lower,
--            11acc3bd holds 1 cell.
--      STOP: any run still holding thousands of cells reaching back days.
--            That means the UPDATE did not run (check §2 for an aborted
--            transaction) — roll back per the checklist.
select
  t.claim_run_id,
  count(*)                    as cells,
  min(t.first_claimed_at)     as oldest_first_claim,
  r.started_at                as run_started_at,
  r.ended_at                  as run_ended_at,
  (min(t.first_claimed_at) < r.started_at) as holds_tiles_predating_its_own_run
from territory_tiles t
left join runs r on r.id = t.claim_run_id
group by t.claim_run_id, r.started_at, r.ended_at
order by cells desc;

-- 3.2  Unresolvable / null / total (identical to 1.2).
--      PASS: all three numbers EXACTLY as in §1. This backfill cannot change
--            any of them.
--      STOP: any difference — it means owner_id or first_claimed_at moved,
--            which nothing here is allowed to do.
select
  count(*) filter (
    where not exists (
      select 1 from runs r
      where r.user_id = t.owner_id and r.ended_at = t.first_claimed_at
    )
  ) as unresolvable,
  count(*) filter (where t.claim_run_id is null) as null_provenance,
  count(*)                                       as total_rows
from territory_tiles t;

-- 3.3  The real success condition, stated as a single number.
--      PASS: 0.
--      STOP: anything else.
select count(*) as resolvable_rows_still_wrong
from territory_tiles t
join runs r on r.user_id = t.owner_id and r.ended_at = t.first_claimed_at
where t.claim_run_id is distinct from r.id;

-- 3.4  Case 2 — conquered tiles, deliberately untouched. This is the bucket
--      whose size was previously unknown.
--      PASS: whatever it is, it matches §1's `unresolvable` minus the 412 of
--            query 3.5. On a single-runner database, expected 0.
select count(*) as conquered_or_otherwise_unresolvable
from territory_tiles t
where not exists (
  select 1 from runs r
  where r.user_id = t.owner_id and r.ended_at = t.first_claimed_at
)
and t.first_claimed_at <> '2026-09-20T06:28:34.101Z';

-- 3.5  Case 1 — the 412 retro-enclosed rows (identical to 1.4).
--      PASS: byte-for-byte the same result as §1 — one row,
--            ebf11064-67ac-4bd0-a1a8-848cc4d89073, 412.
select claim_run_id, count(*) as cells
from territory_tiles
where first_claimed_at = '2026-09-20T06:28:34.101Z'
group by claim_run_id;

-- 3.6  The guard, asserted again from outside the transaction.
--      PASS: exactly one row, territory_tiles_immutable, tgenabled = 'O'.
--      STOP: anything else, including 'D' (disabled). If it reads 'D', run
--            `alter table territory_tiles enable trigger territory_tiles_immutable;`
--            IMMEDIATELY — ownership is rewritable by anyone with the anon
--            key until you do.
select tgname, tgenabled
from pg_trigger
where tgrelid = 'territory_tiles'::regclass and not tgisinternal;


-- ============================================================================
-- §4 — ROLLBACK, if §3 says stop.
-- ============================================================================
-- The backup holds the exact pre-backfill claim_run_id for every row. Nothing
-- else needs restoring: no other column was touched, and no row was added or
-- removed (§2.6 asserts both).
--
-- begin;
-- alter table territory_tiles disable trigger territory_tiles_immutable;
-- update territory_tiles t
--   set claim_run_id = b.claim_run_id
--   from territory_tiles_backup_20260920 b
--  where b.h3 = t.h3
--    and t.claim_run_id is distinct from b.claim_run_id;
-- alter table territory_tiles enable trigger territory_tiles_immutable;
-- commit;
--
-- Then re-run §3 query 3.6 and confirm tgenabled = 'O'.
--
-- KEEP THE BACKUP TABLE. Dropping it is a separate, deliberate decision once
-- the app has been used against the repaired data for a while. It is 6,049
-- rows of one person's tile ownership; it is not costing anything.

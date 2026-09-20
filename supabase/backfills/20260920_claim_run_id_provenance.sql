-- BACKFILL — reconstruct territory_tiles.claim_run_id from first_claimed_at.
--
-- WHAT IT WILL AND WILL NOT ACHIEVE — read this before running anything, so
-- a correct run is not mistaken for a partial failure. Measured against
-- production 2026-09-20, whole table, all owners:
--
--   total rows                                                6,244
--   resolvable (a run of the owner ended at first_claimed_at) 4,807  (77%)
--   unresolvable                                              1,437  (23%)
--     of which four hand-inserted batches                     1,389
--     of which genuine conquest                                  48
--   rows with a null claim_run_id                                 0
--
-- So this backfill gives honest provenance to 4,807 of 6,244 rows. The
-- remaining ~1,389 stay grouped under a handful of runs because NO RUN
-- EXISTS that could own them — they were written by hand-run SQL, not by a
-- claim. My Achievements will break up substantially but not completely.
-- THAT IS THE CORRECT OUTCOME, not a partial failure, and §3.4 below is
-- where it shows up. Do not roll back over it.
--
-- THIS IS NOT A MIGRATION AND MUST NOT BE RUN AS ONE. It lives in
-- supabase/backfills/ precisely so that "fix the function" and "rewrite
-- 6,244 rows of live data" stay two separate, independently-reversible
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
-- 1. HAND-INSERTED CELLS — LEFT ALONE, DELIBERATELY. ~1,389 ROWS, NOT 412.
--    This file first said "412 rows, one batch, retro-enclose.sql". Measured
--    against production 2026-09-20 and that was wrong twice over: that batch
--    is 417 rows as it sits in the table (412 was what the hand-run INSERT
--    reported), and it is one of FOUR such batches, not the only one.
--
--      owner     first_claimed_at                cells   some_run_ended_then
--      30ef31c5  2026-09-06 19:08:12.61127+00      576   false
--      30ef31c5  2026-09-20 06:28:34.101+00        417   false
--      30ef31c5  2026-09-05 01:05:38.378935+00     230   false
--      30ef31c5  2026-09-08 01:26:32.669213+00     148   false
--      30025706  2026-09-05 01:05:38.378935+00      10   false
--      30025706  2026-09-06 19:08:12.61127+00        8   false
--                                          total 1,389
--
--    `some_run_ended_then = false` means NO run in `runs` has that ended_at
--    at all, for anybody — so these cannot be conquest. The microsecond
--    precision (.61127, .378935, .669213) against the millisecond precision
--    of client-written rows (.399, .776, .204) says they were written by
--    hand-run SQL: earlier retro-enclosure passes, or convert-tile-res.ts,
--    whose generated INSERT does not set claimed_at or a real claim clock.
--    Each timestamp is one INSERT's own wall clock, shared by every row it
--    wrote, which is why they cluster this exactly.
--
--    None of them can be resolved: there is no run that could have won them.
--    The join below does not touch them and they keep their current
--    claim_run_id — verified to point at a real run of the RIGHT OWNER in
--    every case, just not the one that won the cell.
--
--    Why not NULL them to be honest about it: fetchMyClaimedCells groups by
--    claim_run_id and achievements-view.tsx then looks each group up against
--    the runner's own fences (`cellsByRun.get(f.id)`), so cells under a
--    claim_run_id that is not one of their runs are DROPPED from the map
--    entirely. NULLing would erase 1,389 cells of real, owned territory from
--    My Achievements to make a column tidier. A wrong-but-plausible pointer
--    to a real run of the right owner is the lesser evil here, and §3's
--    queries 3.4 and 3.5 keep the bucket visible rather than letting it
--    disappear into the general population. If the true winning runs are
--    ever established, patch these rows on their own, with their own backup.
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
--    Measured 2026-09-20: genuine conquest is about 48 rows — the ones where
--    `some_run_ended_then` is TRUE (a run does exist with that ended_at, it
--    just belongs to the other owner). It is a rounding error next to case 1's
--    1,389, and §3's query 3.4 reports the two separately so they are never
--    confused for each other.
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
-- THE IMMUTABILITY TRIGGER HAS TO COME OFF FOR THIS
-- ============================================================================
-- enforce_territory_tiles_immutable() (20260908010000) raises whenever
-- claim_run_id changes without claimed_at strictly increasing. This backfill
-- changes claim_run_id and deliberately does NOT touch claimed_at (see the
-- migration's header: claimed_at is the conquest clock, not provenance), so
-- every single row would be rejected with the trigger attached.
--
-- It is disabled and re-enabled inside ONE transaction, and the window that
-- opens is narrower than it first sounds. `alter table ... disable trigger`
-- takes a SHARE ROW EXCLUSIVE lock, which conflicts with the ROW EXCLUSIVE
-- that any writer needs — so a concurrent upload BLOCKS for the duration of
-- the transaction rather than slipping through unguarded. And ALTER TABLE is
-- transactional in Postgres, so a failure at any point rolls the disable back
-- with everything else: there is no path through this file that commits with
-- the trigger off.
--
-- Step 2.6 still asserts it is back on before the commit, and §3's query 6
-- asserts it again afterwards from the outside. Run that query anyway. A
-- trigger left disabled by some half-applied variant of this file would be
-- silent, and it is the only thing standing between a permissive RLS update
-- policy and anyone reassigning any tile to themselves.
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
--      The query is table-wide (6,244 rows, two owners). The three rows
--      below are owner 30ef31c5's, whose 6,049 tiles are almost all of it.
--      Expected BEFORE (production, 2026-09-20):
--        070cb7d6…  2551 cells, oldest first_claimed_at 2026-09-03
--        b0982352…  2186 cells, oldest first_claimed_at 2026-09-02
--        11acc3bd…   474 cells, oldest first_claimed_at 2026-09-04
--        holds_tiles_predating_its_own_run = true for all three.
--      Expected AFTER: many more rows, each much smaller, and
--        holds_tiles_predating_its_own_run false (or null) for every row
--        except the two documented unresolved buckets (§3 queries 3.4 and
--        3.5). 11acc3bd in particular should hold ONE cell.
--        A HANDFUL OF LARGE ROWS SURVIVE AND THAT IS CORRECT: the ~1,389
--        hand-inserted cells stay pooled under whichever runs they currently
--        point at, because no run exists that could own them. Expect roughly
--        4,807 of 6,244 rows (77%) to move to honest provenance, not all of
--        them. Judge this query by 3.3, not by eyeballing the top row.
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
--      Expected BEFORE and AFTER, measured 2026-09-20:
--        unresolvable     1437
--        null_provenance     0
--        total_rows       6244
--      These must be IDENTICAL before and after — the backfill changes no
--      owner_id and no first_claimed_at, so they cannot move.
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

-- 1.3  Tie check. MUST RETURN ZERO ROWS (verified 2026-09-20: zero). If it
--      returns anything, STOP — step 2.2 will refuse anyway, but know about
--      it before you paste.
select user_id, ended_at, count(*) as runs_ending_at_the_same_instant
from runs
group by user_id, ended_at
having count(*) > 1;

-- 1.4  The four hand-inserted batches (case 1), so the same query in §3 can
--      prove they were not touched. Grouped by the timestamp AND the pointer,
--      because they are several batches by two owners, not one batch.
--      Expected, measured 2026-09-20 — 1,389 cells across these four
--      first_claimed_at values, the 2026-09-20 one being 417 (NOT 412: that
--      was what the hand-run INSERT reported, not what landed):
--        2026-09-06 19:08:12.61127   576 + 8
--        2026-09-20 06:28:34.101     417
--        2026-09-05 01:05:38.378935  230 + 10
--        2026-09-08 01:26:32.669213  148
select first_claimed_at, owner_id, claim_run_id, count(*) as cells
from territory_tiles
where first_claimed_at in (
  '2026-09-05 01:05:38.378935+00',
  '2026-09-06 19:08:12.61127+00',
  '2026-09-08 01:26:32.669213+00',
  '2026-09-20 06:28:34.101+00'
)
group by first_claimed_at, owner_id, claim_run_id
order by first_claimed_at, cells desc;

-- 1.5  How many rows the UPDATE will actually rewrite. Compare against the
--      "UPDATE n" the editor reports in §2. Upper bound is 1.2's
--      total_rows - unresolvable = 4807; the real figure is that minus
--      however many already happen to point at the right run.
select count(*) as rows_to_change
from territory_tiles t
join runs r on r.user_id = t.owner_id and r.ended_at = t.first_claimed_at
where t.claim_run_id is distinct from r.id;


-- ============================================================================
-- §2 — THE TRANSACTION. One paste, one run.
-- ============================================================================

begin;

-- 2.1  Undo. 6,244 rows is nothing; there is no excuse for not having this.
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
--      PASS: many more rows than before, each far smaller, 11acc3bd holding
--            1 cell, and holds_tiles_predating_its_own_run false or null on
--            every row EXCEPT the unresolved buckets of 3.4 and 3.5.
--            A few rows still holding several hundred cells is EXPECTED, not
--            a failure: those are the ~1,389 hand-inserted cells of case 1,
--            which no run can own. Do not roll back over them. 3.3 is the
--            query that decides pass/fail; this one is for the shape.
--      STOP: the same three rows as §1, still holding 2551 / 2186 / 474.
--            That means the UPDATE did not run (check §2 for an aborted
--            transaction) — nothing changed, so there is nothing to roll back.
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
--      PASS: all three numbers EXACTLY as in §1 — 1437 / 0 / 6244 as measured
--            2026-09-20. This backfill cannot change any of them.
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

-- 3.4  The whole unresolved population, split by WHY it is unresolved. This
--      is the query that stops a correct run being read as a failure.
--
--      `some_run_ended_then` asks whether ANY run — anyone's — ended at this
--      first_claimed_at. It is the difference between the two cases:
--        false = case 1, hand-inserted SQL. No run could ever own these.
--        true  = case 2, genuine conquest: a run does exist with that
--                ended_at, it just belongs to the previous owner.
--
--      EXPECTED, measured on production 2026-09-20, BEFORE and AFTER
--      IDENTICALLY (this backfill cannot move a single row of it):
--
--        owner     first_claimed_at                cells  some_run_ended_then
--        30ef31c5  2026-09-06 19:08:12.61127+00      576  false
--        30ef31c5  2026-09-20 06:28:34.101+00        417  false
--        30ef31c5  2026-09-05 01:05:38.378935+00     230  false
--        30ef31c5  2026-09-08 01:26:32.669213+00     148  false
--        30025706  2026-09-05 01:05:38.378935+00      10  false
--        30025706  2026-09-06 19:08:12.61127+00        8  false
--        …small remainder, ~48 rows, all some_run_ended_then = true
--                                          total 1,437
--
--      THIS IS PRE-EXISTING DATA, NOT A FAILURE OF THE BACKFILL, AND IT MUST
--      NOT TRIGGER A ROLLBACK. ~1,389 of these rows (97%) were written by
--      hand-run SQL that never recorded which run won the cell; the
--      information does not exist to recover. They keep pointing at a real
--      run of the right owner, which is what keeps them drawn on the map.
--      PASS: totals match §1 exactly.
--      STOP: a total that differs from §1's `unresolvable` — that would mean
--            owner_id or first_claimed_at moved, which nothing here may do.
select
  t.owner_id,
  t.first_claimed_at,
  count(*) as cells,
  exists (select 1 from runs r where r.ended_at = t.first_claimed_at) as some_run_ended_then
from territory_tiles t
where not exists (
  select 1 from runs r
  where r.user_id = t.owner_id and r.ended_at = t.first_claimed_at
)
group by t.owner_id, t.first_claimed_at
order by cells desc;

-- 3.5  Case 1 — the four hand-inserted batches (identical to 1.4).
--      PASS: byte-for-byte the same result as §1 — same timestamps, same
--            owners, same claim_run_id pointers, same counts (576+8, 417,
--            230+10, 148; 1,389 total). Nothing here may change.
--      STOP: any count or pointer that moved. The join was never supposed to
--            reach these rows.
select first_claimed_at, owner_id, claim_run_id, count(*) as cells
from territory_tiles
where first_claimed_at in (
  '2026-09-05 01:05:38.378935+00',
  '2026-09-06 19:08:12.61127+00',
  '2026-09-08 01:26:32.669213+00',
  '2026-09-20 06:28:34.101+00'
)
group by first_claimed_at, owner_id, claim_run_id
order by first_claimed_at, cells desc;

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
-- ONLY 3.2, 3.3, 3.5 and 3.6 can say stop. A large surviving row in 3.1 and
-- a 1,437-row count in 3.4 are the expected, measured state of this database
-- and are not grounds for rolling anything back.
--
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
-- the app has been used against the repaired data for a while. It is 6,244
-- rows of two runners' tile ownership; it is not costing anything.

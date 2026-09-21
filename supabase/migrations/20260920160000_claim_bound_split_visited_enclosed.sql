-- The claim plausibility bound is ONE number derived from ONE run's distance,
-- applied to `p_visited ∪ p_enclosed`. That is the right shape for per-run
-- enclosure and the wrong shape for UNION enclosure. This splits it in two.
--
-- ============================================================================
-- THE BOUND TODAY, AND WHY IT IS THE WRONG SHAPE
-- ============================================================================
-- 20260908010000 introduced, and every version since has carried verbatim:
--
--   max_claimable := greatest(
--     64,
--     ceil((r.distance_m * r.distance_m) / (4 * pi() * tile_area_m2) * 1.5)::integer
--       + ceil(r.distance_m / 10.8)::integer
--   );
--   if array_length(all_cells, 1) > max_claimable then raise ... end if;
--
-- where all_cells is `distinct unnest(p_visited || p_enclosed)`. The first
-- term is "the area a closed loop of this length can enclose" (isoperimetric,
-- P²/4π, in tiles, with 1.5x slack); the second is "the ground the path
-- itself covers". Evaluated:
--
--   300 m -> 64      500 m -> 145     1 km -> 482     2 km -> 1,741
--   3 km  -> 3,777   5 km -> 10,181   10 km -> 39,795
--
-- That derivation is sound for PER-RUN enclosure: the interior a single loop
-- closes really is bounded by the length of the loop that closed it.
--
-- It is not sound for UNION enclosure, which fills holes in the union of this
-- run's cells with the runner's ENTIRE historical territory
-- (territory-sync.ts's `unionNewEnclosed`). A runner who has bounded three
-- sides of a block across past sessions can close the fourth with a 200 m
-- jog. The ground that becomes enclosed has no relationship to that run's
-- distance, so measuring it against that run's distance is a category error.
--
-- ============================================================================
-- WHY IT MUST BE FIXED BEFORE THE PAGING FIX LANDS, NOT AFTER
-- ============================================================================
-- The guard does not fire today only because union enclosure is crippled:
-- territory-sync.ts reads the owner's tiles with an UNPAGED PostgREST select,
-- capped at 1,000 rows, so it has only ever seen ~17% of the heaviest
-- runner's 6,049 tiles. `fix/union-enclosure-paging` repairs that read and is
-- verified and ready.
--
-- The guard REJECTS; it does not degrade. It runs over the combined array
-- before `insert into tile_visits` and before the territory_tiles upsert, so
-- one trip means the run claims ZERO tiles — including ground the runner
-- genuinely ran over. That is strictly worse than the under-claiming it
-- would replace: a runner who covered real ground is told the server did not
-- believe them.
--
-- Concrete case already in production: a second account holds 175 cells
-- sitting inside the heavy runner's footprint. The run that finally encloses
-- that pocket could easily be under 300 m, proposing 175+ cells against a
-- ceiling of 64 — and losing the visited ground with them.
--
-- This repo has shipped this exact class of failure before. See
-- 20260907130000_tile_res12_guard.sql: "a guard hard-coding an assumption
-- does not degrade, it RAISES, and the whole run save fails... The order is
-- only dangerous in one direction." Guard first, then the data change.
--
-- ============================================================================
-- THE SPLIT
-- ============================================================================
-- 1. p_visited keeps the existing distance-derived bound, UNCHANGED. It is
--    the anti-forgery guard on the path actually run and it is doing real
--    work, so it is not weakened by a single digit. It is now applied to
--    p_visited's own distinct count rather than to the combined array.
--
--    This can only ever ACCEPT more than today, never reject more:
--    |distinct p_visited| <= |distinct (p_visited || p_enclosed)| always, and
--    the bound on the left-hand side is the same number. There is no input
--    that passed the old check and fails the new visited check.
--
-- 2. p_enclosed gets its own ceiling:
--
--       enclosed_ceiling = (tiles this runner already owns) + max_claimable(d)
--
--    You cannot enclose more ground than your existing territory is capable
--    of bounding, plus this run's own reach. It is self-limiting, it grows
--    honestly with legitimate play, and it needs no magic number — which
--    matters, because the largest single run in this database claimed 2,551
--    cells against 6,049 owned, so any flat cap would be a guess.
--
--    Enclosed cells are also inherently harder to forge than visited ones:
--    the bounding ring must itself be real owned-or-visited ground, and the
--    visited half of that is policed by the bound above plus
--    check_tile_visit_plausibility's independent 3x trigger on tile_visits.
--
-- The owned count is `count(*) from territory_tiles where owner_id = ...`,
-- served by territory_tiles_owner_idx (20260903120000_tile_coverage.sql:55).
-- One indexed count per upload, alongside the round trip territory-sync.ts
-- already makes for the same rows.
--
-- It deliberately does NOT filter by tile resolution the way fetchMyTileTotal
-- does. Counting any surviving res-11 rows can only make a CEILING more
-- generous, never cause a rejection, and "how many tiles do you own" is the
-- honest reading of the bound. (The client's own ownedSet does filter with
-- isCurrentTileRes, so the two numbers can differ slightly; that difference
-- is always in the safe direction here.)
--
-- ============================================================================
-- THE CEILING, AT REALISTIC COMBINATIONS
-- ============================================================================
-- 4*pi()*307.1 = 3,859.13. max_claimable(d) = greatest(64,
--   ceil(d^2/3859.13*1.5) + ceil(d/10.8)):
--
--   300 m : ceil(34.98)=35 + ceil(27.78)=28  ->  63, floored to  64
--   1 km  : ceil(388.69)=389 + ceil(92.59)=93 ->        482
--   5 km  : ceil(9717.2)=9718 + ceil(462.96)=463 ->  10,181
--   10 km : ceil(38868.9)=38869 + ceil(925.93)=926 -> 39,795
--
-- enclosed_ceiling = owned + max_claimable(d):
--
--   owned ->      0       500     6,049    20,000
--   300 m        64       564     6,113    20,064
--   1 km        482       982     6,531    20,482
--   5 km     10,181    10,681    16,230    30,181
--   10 km    39,795    40,295    45,844    59,795
--
-- The 175-cell production pocket, closed by a sub-300 m run by the runner who
-- holds 6,049 tiles: 175 against 6,113. Passes with 35x margin. It passes at
-- owned = 500 too (175 against 564). Under the current single bound it is
-- 175 against 64 — the whole claim refused.
--
-- FIRST RUN, ZERO OWNED TILES: enclosed_ceiling collapses to
-- max_claimable(d), which is exactly today's behaviour for a runner with no
-- history. That is intended. A first run has no past territory to bound
-- anything with, so the only ground it can legitimately enclose is what its
-- own loop closed — which is what max_claimable(d) measures.
--
-- ============================================================================
-- WHAT THIS STILL REJECTS THAT COULD BE HONEST — READ BEFORE THE FIRST TRIP
-- ============================================================================
-- Stated plainly rather than hidden. The bound is CONSERVATIVE against
-- geometry: a thin ring of N res-12 cells (centre-to-centre ~18.83 m) can
-- bound up to (N*18.83)^2/(4*pi()*307.1) ~= 0.092*N^2 cells, which is
-- quadratic in N, while this ceiling is linear. For N = 6,049 that geometric
-- limit is ~3.4 MILLION cells against a ceiling of ~6,113.
--
-- So there is a reachable shape that this refuses: a LARGE ring assembled
-- across sessions and closed by a SHORT run. Worked example — a 5 km loop run
-- in pieces, its track ~2.5 cells wide, owned along it ~660 cells; interior
-- = 5000^2/(4*pi()*307.1) ~= 6,478 cells; closed by a 300 m jog, ceiling =
-- 660 + 64 = 724. Rejected, and the 300 m of real ground goes with it.
-- The same 5 km loop run in ONE session is fine (max_claimable(5000) = 10,181
-- >= 6,478), so this needs the multi-session, short-closer combination.
--
-- Why it ships anyway: every measurement this repo actually has says real
-- union-enclosure holes are two to three orders of magnitude below the
-- ceiling. `npm run measure-holes` found the largest hole in any runner's
-- covered ground at 342 cells; `npm run retro-enclose` found 448 cells TOTAL
-- of surrounded-but-unwritten ground for the 6,049-tile runner, accumulated
-- over months. Both sit against ceilings in the thousands. Choosing the
-- quadratic geometric bound instead would mean ~3.4M for that runner, i.e.
-- no guard at all.
--
-- What to do if it ever trips on an honest run: the answer is NOT to raise
-- the constant. It is to make the enclosed half DEGRADE instead of reject —
-- drop p_enclosed and claim p_visited alone, so the runner keeps the ground
-- they actually covered. That is a change to the return values' meaning
-- (n_claimed would no longer include enclosure for that run) and so is a
-- separate, deliberate decision, not something to slip in under a hotfix.
-- The exception message names which bound blew and by how much precisely so
-- that decision can be made from evidence.
--
-- ============================================================================
-- WHAT THIS DOES NOT CHANGE
-- ============================================================================
-- Verified against this function's actual body, not assumed:
--
--  - `all_cells` is still `distinct unnest(coalesce(p_visited,'{}') ||
--    coalesce(p_enclosed,'{}'))` and is still what the CTE inserts and what
--    the trailing last_visited_at UPDATE touches. Only the guard ABOVE it
--    changes.
--  - n_claimed / n_taken / n_kept are still the three `count(*) filter`
--    aggregates over `upserted u left join before b`, unchanged.
--  - skipped_older is still `array_length(all_cells,1) - n_claimed - n_taken
--    - n_kept`. Its inputs are untouched, so it cannot move.
--  - taken_cells is still the array_agg of the same filter.
--  - Both checks still run BEFORE `insert into tile_visits` and before the
--    upsert, so a rejection still writes nothing at all.
--  - A null r.distance_m still yields max_claimable = 64: Postgres's
--    greatest() ignores nulls, and that was already true.
--
-- CAN BOTH BOUNDS PASS WHILE THE CLAIM IS JOINTLY IMPLAUSIBLE? Yes,
-- arithmetically: the joint total can reach owned + 2*max_claimable(d) where
-- the old single bound allowed max_claimable(d). There is deliberately NO
-- third combined check. The extra allowance over `owned` is exactly one
-- max_claimable(d) — precisely today's per-run enclosure allowance, which is
-- the thing this file is preserving — and a combined check would reintroduce
-- the same category error the split exists to remove: it would make a
-- legitimate union enclosure's acceptance depend on how far the closing run
-- happened to be. The two claims are bounded by two different physical
-- arguments and are checked against them separately, on purpose.
--
-- DIAGNOSABILITY: both rejections keep the CLAIM_IMPLAUSIBLE prefix and name
-- which bound was exceeded. territory-sync.ts matches by
-- `message.includes('CLAIM_IMPLAUSIBLE')` (CLAIM_IMPLAUSIBLE_MARKER, line
-- 188) because plpgsql raises all of these as the generic P0001 — substring,
-- not equality, not SQLSTATE — so adding words after the prefix cannot break
-- it. test/claim-tiles.test.ts asserts that mapping against a message of this
-- exact shape.
--
-- ============================================================================
-- CREATE OR REPLACE, NOT DROP
-- ============================================================================
-- The OUT list is byte-for-byte 20260920140000's `returns table (claimed
-- integer, taken integer, skipped_older integer, taken_cells text[])`.
-- Postgres only refuses CREATE OR REPLACE with 42P13 when the OUT list
-- changes (see 20260915120000, which explains that incident). Nothing here
-- touches the signature, so no drop is used and none is needed.
--
-- The provenance `case` from 20260920140000 is carried forward VERBATIM. That
-- migration is already applied to production; anything built on an older body
-- would silently revert it.
--
-- APPLY BY HAND in the Supabase SQL editor. Nothing in this repo runs
-- migrations, and `supabase migration list` lies about hand-applied ones.
-- VERIFY AFTER APPLYING, NOT BEFORE: plpgsql plans a function body lazily, so
-- a broken body installs perfectly cleanly and only fails on the first real
-- claim. The apply-and-verify checklist is at the bottom of this file.
--
-- Everything outside the marked guard block is copied verbatim from
-- 20260920140000_claim_run_id_provenance.sql.

create or replace function claim_run_tiles(
  p_run_id  uuid,
  p_visited text[],
  p_enclosed text[],
  p_region  text
)
returns table (claimed integer, taken integer, skipped_older integer, taken_cells text[])
language plpgsql
as $$
declare
  claim_window interval := interval '12 hours';
  tile_area_m2 constant numeric := 307.1;
  r            record;
  all_cells    text[];
  max_claimable integer;
  -- THE SPLIT: three new locals. Nothing else in this block changed.
  n_visited        integer;
  n_enclosed       integer;
  owned_tiles      integer;
  enclosed_ceiling integer;
  n_claimed    integer := 0;
  n_taken      integer := 0;
  n_kept       integer := 0;
  n_taken_cells text[] := '{}';
begin
  select id, user_id, ended_at, distance_m into r from runs where id = p_run_id;
  if r.id is null then
    raise exception 'CLAIM: no such run %', p_run_id;
  end if;
  if r.user_id <> auth.uid() then
    raise exception 'CLAIM: run % does not belong to the caller', p_run_id;
  end if;

  if r.ended_at > now() then
    raise exception 'CLAIM: run % claims to end in the future (%)', p_run_id, r.ended_at;
  end if;

  if now() - r.ended_at > claim_window then
    raise exception 'CLAIM_TOO_OLD: run % ended % ago, past the % window', p_run_id, now() - r.ended_at, claim_window;
  end if;

  all_cells := array(select distinct unnest(coalesce(p_visited, '{}') || coalesce(p_enclosed, '{}')));

  if coalesce(array_length(all_cells, 1), 0) = 0 then
    return query select 0, 0, 0, '{}'::text[];
    return;
  end if;

  -- ==========================================================================
  -- THE CHANGE, and the only one in this file: ONE bound over the combined
  -- array becomes TWO bounds over the two halves. See the header.
  -- ==========================================================================
  n_visited  := coalesce(array_length(array(select distinct unnest(coalesce(p_visited,  '{}'))), 1), 0);
  n_enclosed := coalesce(array_length(array(select distinct unnest(coalesce(p_enclosed, '{}'))), 1), 0);

  -- Unchanged, digit for digit, from every version since 20260908010000.
  max_claimable := greatest(
    64,
    ceil((r.distance_m * r.distance_m) / (4 * pi() * tile_area_m2) * 1.5)::integer
      + ceil(r.distance_m / 10.8)::integer
  );

  -- BOUND 1 — ground actually run over, against this run's own distance.
  -- The anti-forgery guard. Not weakened; only its subject narrowed from
  -- (visited + enclosed) to visited, which can never reject more than before.
  if n_visited > max_claimable then
    raise exception
      'CLAIM_IMPLAUSIBLE: run % claims % VISITED tiles, above the visited bound of % for a %m run',
      p_run_id, n_visited, max_claimable, r.distance_m;
  end if;

  -- BOUND 2 — ground surrounded but not crossed, against what this runner's
  -- existing territory could bound plus this run's own reach. Indexed count
  -- on territory_tiles_owner_idx. Read BEFORE any write below, so it is the
  -- pre-run holding, never inflated by this claim.
  select count(*) into owned_tiles from territory_tiles where owner_id = r.user_id;
  enclosed_ceiling := coalesce(owned_tiles, 0) + max_claimable;

  if n_enclosed > enclosed_ceiling then
    raise exception
      'CLAIM_IMPLAUSIBLE: run % claims % ENCLOSED tiles, above the enclosed ceiling of % (% tiles already owned + % for a %m run)',
      p_run_id, n_enclosed, enclosed_ceiling, coalesce(owned_tiles, 0), max_claimable, r.distance_m;
  end if;
  -- ==========================================================================
  -- END OF THE CHANGE. Everything below is verbatim from 20260920140000.
  -- ==========================================================================

  if coalesce(array_length(p_visited, 1), 0) > 0 then
    insert into tile_visits (h3, user_id, run_id)
    select unnest(p_visited), r.user_id, r.id
    on conflict (h3, run_id) do nothing;
  end if;

  with before as materialized (
    select h3, owner_id from territory_tiles where h3 = any(all_cells)
  ),
  upserted as (
    insert into territory_tiles as t (h3, owner_id, first_claimed_at, claim_run_id, claimed_at, last_visited_at, region_id)
    select unnest(all_cells), r.user_id, r.ended_at, r.id, r.ended_at, now(), p_region
    on conflict (h3) do update
      set owner_id        = excluded.owner_id,
          -- Provenance moves ONLY when the tile actually changes hands. A
          -- re-run over ground you already hold keeps pointing at the run
          -- that won it. Carried forward verbatim from 20260920140000 —
          -- that migration is applied to production and rewriting this
          -- expression would silently revert it.
          claim_run_id    = case
                              when t.owner_id is distinct from excluded.owner_id
                                then excluded.claim_run_id
                              else t.claim_run_id
                            end,
          claimed_at      = excluded.claimed_at,
          last_visited_at = now(),
          region_id       = coalesce(excluded.region_id, t.region_id)
      where excluded.claimed_at > t.claimed_at
    returning t.h3, (xmax = 0) as inserted
  )
  select
    count(*) filter (where u.inserted),
    count(*) filter (where not u.inserted and b.owner_id is distinct from r.user_id),
    count(*) filter (where not u.inserted and b.owner_id = r.user_id),
    coalesce(array_agg(u.h3) filter (where not u.inserted and b.owner_id is distinct from r.user_id), '{}')
    into n_claimed, n_taken, n_kept, n_taken_cells
  from upserted u
  left join before b on b.h3 = u.h3;

  update territory_tiles set last_visited_at = now() where h3 = any(all_cells);

  return query select
    coalesce(n_claimed, 0),
    coalesce(n_taken, 0),
    (array_length(all_cells, 1)
       - coalesce(n_claimed, 0)
       - coalesce(n_taken, 0)
       - coalesce(n_kept, 0))::integer,
    coalesce(n_taken_cells, '{}');
end;
$$;

-- ============================================================================
-- APPLY AND VERIFY — in this order, and do not merge the steps
-- ============================================================================
-- Prerequisite: 20260920140000_claim_run_id_provenance.sql must already be
-- applied (it is, as of 2026-09-20). This file is built on that body.
--
-- STEP 0 — confirm the index the new count relies on actually exists.
--   Run before applying anything. If it returns no row, STOP and create it
--   (`create index if not exists territory_tiles_owner_idx on
--   territory_tiles (owner_id);`) before continuing — without it the count
--   is a sequential scan on every single upload.
--
--     select indexname from pg_indexes
--     where tablename = 'territory_tiles' and indexname = 'territory_tiles_owner_idx';
--
-- STEP 1 — record the numbers this change is measured against, BEFORE it.
--   Keep the output. `auth.uid()` is null in the SQL editor (it runs as
--   `postgres`, not as a signed-in user), so the owner id is literal —
--   30ef31c5-c6f0-4efa-b90c-d283f087831b is the one measured on 2026-09-20.
--
--     select owner_id, count(*) as owned from territory_tiles group by owner_id order by 2 desc;
--
--   Expected shape: one row near 6,049 and at least one small row near 175.
--
-- STEP 2 — apply this file. Paste the whole thing into the SQL editor and
--   run it. It is a `create or replace function`: no drop, no downtime, the
--   signature is unchanged.
--
--   Expected: `Success. No rows returned.`
--
--   THIS PROVES NOTHING YET. plpgsql plans a function body lazily — a broken
--   body installs perfectly cleanly and only fails on the first real claim.
--   This repo has been bitten by exactly that. Step 4 is the actual test.
--
-- STEP 3 — confirm the installed body is THIS one and still carries the
--   provenance case. Both of these must return true.
--
--     select
--       pg_get_functiondef(p.oid) like '%ENCLOSED tiles, above the enclosed ceiling%' as split_installed,
--       pg_get_functiondef(p.oid) like '%t.owner_id is distinct from excluded.owner_id%' as provenance_intact
--     from pg_proc p
--     join pg_namespace n on n.oid = p.pronamespace
--     where p.proname = 'claim_run_tiles' and n.nspname = 'public';
--
--   PASS — both true.
--   STOP — provenance_intact false means an older body was pasted. Re-apply
--   20260920140000_claim_run_id_provenance.sql verbatim and start over.
--
-- STEP 4 — record a real run. This is the only real test.
--   On the phone or the web build, record a short run over ground you already
--   own, and let it finish and upload.
--
--   PASS — the run saves, the summary shows its stats, the conquest banner
--     reads a claimed/taken count, and there is no error toast.
--   STOP — any upload error, or a summary reporting 0 tiles for a run that
--     clearly covered ground. See ROLLBACK below, then report the error text.
--
--   Note what a CLAIM_IMPLAUSIBLE now looks like if one does fire: the
--   message names VISITED or ENCLOSED and prints the ceiling's two terms.
--   Copy it verbatim — it is the evidence for whether the bound or the
--   enclosure is wrong, and the header's last section says what to do with it.
--
-- STEP 5 — confirm the claim landed and nothing else moved. Replace
--   <run-id> with the run just recorded.
--
--     select
--       (select count(*) from tile_visits      where run_id       = '<run-id>') as visited_by_this_run,
--       (select count(*) from territory_tiles  where claim_run_id = '<run-id>') as tagged_to_this_run;
--
--   PASS — visited_by_this_run is roughly the run's footprint (NOT 0; 0 means
--     the guard rejected before the insert). tagged_to_this_run may legitimately
--     be small or 0 on ground already owned — that is 20260920140000 working.
--
--     select count(*) from territory_tiles where owner_id = '30ef31c5-c6f0-4efa-b90c-d283f087831b';
--
--   PASS — unchanged or higher than STEP 1. Never lower.
--
-- STEP 6 — only now is `fix/union-enclosure-paging` safe to merge and deploy.
--   The guard is re-bounded, so the paging fix can hand the function the
--   runner's full tile set without the first large union enclosure rejecting
--   an entire run. Order is dangerous in one direction only: guard, then the
--   data change, then deploy.
--
-- ROLLBACK
--   Re-apply supabase/migrations/20260920140000_claim_run_id_provenance.sql
--   VERBATIM. It is also a `create or replace` with the same signature, so it
--   restores the previous body in one paste with no drop and no downtime.
--   Do NOT roll back to 20260915120000 — that one predates the provenance fix
--   and would silently reintroduce the claim_run_id defect.
--   After rolling back, re-run STEP 3's provenance_intact query; it must be
--   true and split_installed must be false.

-- DRAFT — NOT APPLIED. Late runs claim territory (weakly) instead of being
-- refused at 12 hours. Pedro's call before applying.
--
-- WHY (2026-10-01): a run that reaches the server more than 12 h after it
-- ended — no signal on a trail, a dead phone, or an app bug like the one
-- fixed in PR #69 — saved to history with NO territory and NO Local Leaders
-- days. Found when a recovered 7.9 km run was saved 16 h late and the claim
-- was refused as CLAIM_TOO_OLD.
--
-- WHY IT IS SAFE: ordering by ended_at already does the protecting. The
-- territory upsert stamps claimed_at with the run's ended_at and overwrites
-- a tile only when that is NEWER than the tile's current claim
-- (`where excluded.claimed_at > t.claimed_at`). So a late run takes only
-- ground nobody has run since it ended; it can never beat a newer run.
-- Backdating ended_at only makes a run weaker, and a future ended_at is
-- still refused. Both claim bounds (visited vs distance; enclosed vs owned +
-- distance) and the tile_visits plausibility trigger are unchanged. The
-- backlog reached the same conclusion on 2026-09-08: with ended_at ordering
-- "the cutoff becomes a product choice, not a safety mechanism".
--
-- WHAT CHANGES (three edits to the live body, nothing else):
--   1. CLAIM_TOO_OLD fires past 7 days instead of 12 hours.
--   2. tile_visits.visited_at = the run's ended_at (was now()), so a late
--      run's Local Leaders day is the day it was run.
--   3. Nothing else — ownership check, bounds, provenance `case`, conquest
--      ordering, the four returned counts: verbatim from 20260920160000.
--
-- CLIENT: no change needed to land this. The claim retry queue
-- (claim-queue.ts) already retries until the server's final answer, and the
-- unsaved-run banner already offers runs up to 7 days old.
--
-- ROLLBACK: re-apply 20260920160000_claim_bound_split_visited_enclosed.sql
-- verbatim (create or replace, same signature, one paste).
--
-- APPLY in the SQL editor, then VERIFY (plpgsql plans lazily — installing
-- cleanly proves nothing; see the backlog's "A migration that applies isn't
-- verified"):
--   select position('late_cap' in pg_get_functiondef('claim_run_tiles(uuid,text[],text[],text)'::regprocedure)) > 0 as late_cap_installed,
--          position('r.ended_at
    on conflict (h3, run_id)' in pg_get_functiondef('claim_run_tiles(uuid,text[],text[],text)'::regprocedure)) > 0 as visits_stamped_with_ended_at;
-- then exercise the write path on a throwaway: in a transaction that you
-- ROLL BACK, insert a test run that ended 2 days ago, call the function as
-- its owner, check the counts and visited_at, and roll back.

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
  -- Full-power window, unchanged: within 12 h a run claims as it always has.
  claim_window interval := interval '12 hours';
  -- NEW: late runs are accepted up to 7 days after they ended, instead of
  -- refused at 12 h. See this file's header for why that is safe.
  late_cap     interval := interval '7 days';
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

  -- CHANGED: refuse only past the 7-day cap. Between 12 h and 7 days the
  -- claim proceeds; the territory upsert below already makes a late run
  -- weak (it stamps claimed_at with the run's own ended_at and only wins a
  -- tile whose current claim is OLDER), so it takes only ground nobody has
  -- run since it ended. claim_window is kept, unused, as the documented
  -- full-power boundary.
  if now() - r.ended_at > late_cap then
    raise exception 'CLAIM_TOO_OLD: run % ended % ago, past the % cap', p_run_id, now() - r.ended_at, late_cap;
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
    -- CHANGED: stamped with the run's own end time, not the upload time
    -- (the column default, now()). Local Leaders counts DAYS from
    -- visited_at, so a run uploaded late must count on the day it was run,
    -- never on the day it finally reached the server. For an on-time upload
    -- the two differ by seconds.
    insert into tile_visits (h3, user_id, run_id, visited_at)
    select unnest(p_visited), r.user_id, r.id, r.ended_at
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

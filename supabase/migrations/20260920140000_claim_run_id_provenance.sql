-- claim_run_id means "the run that WON this tile", not "the last run that
-- stepped on it". Today it means the second thing, and that is a data defect
-- with a visible product symptom.
--
-- THE DEFECT. Every prior version of this function (20260908010000,
-- 20260909230000, 20260915120000) wrote:
--
--   on conflict (h3) do update
--     set owner_id     = excluded.owner_id,
--         claim_run_id = excluded.claim_run_id,
--         claimed_at   = excluded.claimed_at,
--         ...
--     where excluded.claimed_at > t.claimed_at
--
-- The `where` only asks "is the incoming run newer". It never asks whether
-- ownership actually CHANGED HANDS. So running over ground you already own
-- re-stamps claim_run_id (and claimed_at) onto the newest run, every time.
-- Measured against production 2026-09-20 (owner 30ef31c5, 6,049 tiles):
--
--   run 11acc3bd (2026-09-20, 5,865 m):  474 tiles tagged to it,
--                                        ONE genuinely new; the oldest of
--                                        the other 473 was first claimed
--                                        2026-09-04.
--   run 070cb7d6 (2026-09-18):         2,551 tiles, reaching back to 09-03.
--   run b0982352 (2026-09-15):         2,186 tiles, reaching back to 09-02.
--
-- Two runs therefore "own" 78% of one runner's ground.
--
-- WHY IT MATTERS BEYOND TIDINESS. My Achievements colours each connected
-- territory component by its most-recent contributing run. When two runs
-- hold 78% of the cells, nearly everything collapses into one colour and the
-- runner sees a single formless blob. Five UI-level PRs (#53-#57) tried to
-- fix that appearance and could not, because the defect is in the data, not
-- in the renderer. Per-run tile counts in the detail bubble are wrong for
-- the same reason.
--
-- first_claimed_at was never in the `set` list, so it is intact, and it is
-- the only honest provenance left. The companion backfill
-- (supabase/backfills/20260920_claim_run_id_provenance.sql) reconstructs
-- history from it. This file only stops the bleeding; it repairs nothing
-- already written. Apply this FIRST, then the backfill, as two separate
-- decisions.
--
-- ============================================================================
-- THE ONE DESIGN DECISION: what claimed_at does on a SELF re-visit
-- ============================================================================
-- DECIDED: claimed_at KEEPS REFRESHING. Only claim_run_id freezes.
--
-- claimed_at is the conquest tiebreaker — `where excluded.claimed_at >
-- t.claimed_at` above, and enforce_territory_tiles_immutable()'s "ownership
-- may only pass to a strictly newer run" both read it. Freezing it would be
-- a change to the CONQUEST RULE, not a provenance repair:
--
--   You claim a tile with a run ending at t=1 and run over it again at t=3.
--   A rival then uploads a run that ENDED at t=2 (late upload, inside the
--   12 h claim window).
--     - claimed_at frozen at 1  -> 2 > 1, the rival TAKES ground you ran
--       over more recently than he did.
--     - claimed_at refreshed to 3 -> 3 > 2, he is refused.
--
-- The rule this repo actually ships is "a tile belongs to whoever ran or
-- surrounded it MOST RECENTLY" (20260908010000's own header) and "Board 1
-- CONQUEST changes hands the moment somebody else runs there"
-- (CLAUDE.md / Design Decisions.md). Under that rule the second answer is
-- the correct one, and it is also the one that changes nothing about who
-- holds what today. The brief for this change says repair provenance, do
-- not redesign ownership — so claimed_at is left exactly as it behaves now.
--
-- SAY IT PLAINLY: after this change the two columns describe DIFFERENT runs.
--   claim_run_id = the run that WON the tile (provenance / history).
--   claimed_at   = the end time of the most recent run by the CURRENT OWNER
--                  over this tile (the defence clock the conquest
--                  comparison reads).
-- That is acceptable because nothing anywhere treats claimed_at as a pointer
-- to claim_run_id's run. Grepped 2026-09-20: `claimed_at` appears in NO
-- client code, NO script and NO test — only in this function's where-clause,
-- the immutability trigger, and one explanatory comment in
-- territory-sync.ts. It is only ever compared as a timestamp.
-- It does mean `claimed_at <> (select ended_at from runs where id =
-- claim_run_id)` is now normal and is not corruption. Anyone who later wants
-- "when did the winning run end" should read runs.ended_at through
-- claim_run_id, or first_claimed_at, not claimed_at.
--
-- ============================================================================
-- IMPLEMENTATION SHAPE: a `case` in the SET list, NOT a narrower `where`
-- ============================================================================
-- Narrowing the `where` so self-owned rows stop matching would be the
-- obvious fix and it would silently break the return values. n_kept is
-- computed from `upserted`'s RETURNING; rows that stop matching the
-- ON CONFLICT ... WHERE never appear in RETURNING at all, so n_kept would
-- become 0, and skipped_older — computed by subtraction as
-- all_cells - claimed - taken - kept — would absorb every one of them and
-- report "you ran here and it isn't yours" about ground the runner does own.
--
-- Verified against this function's actual body, not taken on faith: n_kept
-- is `count(*) filter (where not u.inserted and b.owner_id = r.user_id)`
-- over `upserted u`, and skipped_older is the subtraction. A `case` in the
-- SET list leaves the matched row set byte-for-byte identical to today, so
-- claimed / taken / skipped_older / taken_cells all keep their current
-- meaning and the client's destructuring keeps working.
--
-- Postgres semantics this relies on: inside ON CONFLICT DO UPDATE, the table
-- alias `t` is the EXISTING row and `excluded` is the proposed one, and
-- every SET expression is evaluated against the pre-update row — so
-- `owner_id = excluded.owner_id` appearing earlier in the list does not
-- affect the `t.owner_id` read in the claim_run_id case.
--
-- THE IMMUTABILITY TRIGGER STILL PASSES, both paths:
--   TAKE  — new.owner_id <> old.owner_id, and new.claimed_at > old.claimed_at
--           is guaranteed by the where-clause. Allowed.
--   KEEP  — new.owner_id and new.claim_run_id are both unchanged, so the
--           trigger's takeover branch does not fire at all.
--
-- ============================================================================
-- NOT REGRESSED (both checked before writing this)
-- ============================================================================
-- last_visited_at: still set in the SET list, AND the blanket
--   `update territory_tiles set last_visited_at = now() where h3 =
--   any(all_cells)` after the CTE still runs unchanged — that statement is
--   what covers tiles this run did not win at all, and it is untouched here.
-- region_id backfill: `coalesce(excluded.region_id, t.region_id)` is
--   unchanged, so a NULL region_id is still filled on re-visit. That path
--   had to be repaired by hand once already
--   (retro-enclose-fix-region.sql); it is deliberately NOT narrowed by the
--   ownership test.
--
-- A NULL claim_run_id now STAYS NULL on a self re-visit (the case keeps
-- t.claim_run_id, null included) rather than being filled with a run that
-- did not win the tile. That is the repo's standing rule — leave the hole,
-- do not connect across a gap. The backfill reports how many such rows
-- exist; it does not invent an answer for them either.
--
-- ============================================================================
-- CREATE OR REPLACE, NOT DROP
-- ============================================================================
-- The OUT list is byte-for-byte the same as 20260915120000's
-- `returns table (claimed integer, taken integer, skipped_older integer,
-- taken_cells text[])`. Postgres only refuses CREATE OR REPLACE (42P13,
-- "cannot change return type of existing function") when the OUT list
-- changes, which is why THAT migration needed a DROP and said so. Nothing
-- here changes the signature — the client still destructures the same four
-- fields — so no drop is used and none is needed. Do not add one: dropping
-- and recreating would briefly leave claims failing, for nothing.
--
-- APPLY BY HAND in the Supabase SQL editor. Nothing in this repo runs
-- migrations, and `supabase migration list` lies about hand-applied ones.
-- VERIFY AFTER APPLYING, NOT BEFORE: plpgsql plans a function body lazily,
-- so a broken body installs perfectly cleanly and only fails on the first
-- real claim. See the checklist in the backfill file.
--
-- Everything outside the single marked change is copied verbatim from
-- 20260915120000_conquest_taken_cells.sql.

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

  max_claimable := greatest(
    64,
    ceil((r.distance_m * r.distance_m) / (4 * pi() * tile_area_m2) * 1.5)::integer
      + ceil(r.distance_m / 10.8)::integer
  );
  if array_length(all_cells, 1) > max_claimable then
    raise exception 'CLAIM_IMPLAUSIBLE: run % claims % tiles, above the bound of % for %m',
      p_run_id, array_length(all_cells, 1), max_claimable, r.distance_m;
  end if;

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
          -- THE CHANGE, and the only one in this file. Provenance moves ONLY
          -- when the tile actually changes hands. A re-run over ground you
          -- already hold keeps pointing at the run that won it.
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

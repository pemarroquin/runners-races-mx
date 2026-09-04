-- Territory Mode — Tile Coverage Model (Step 2 of the Tile Coverage brief)
-- See: Source Data/Outputs/Running App/Tile Coverage Model — Design &
-- Migration Brief.md, §2 (schema) and §2.5 (forgery guard).
--
-- Apply with `supabase db push --linked` (CLI-managed — see the Phase 1
-- migration's header, 20260826222037_territory_mode.sql). Like every
-- migration in this repo, this file is applied BY HAND: nothing in CI or
-- the app build runs `supabase db push` automatically, so none of this
-- exists until Pedro runs that command himself against the linked project
-- (ref hkqwvzhoopoxocdtzgik). Check with `supabase migration list --linked`
-- if it looks like it didn't take. Until it's applied, every call this PR
-- adds to territory-sync.ts (claimTiles) fails with an honest network/denied
-- outcome — never a silent no-op, but also nothing works.
--
-- NOTE ON THE BRIEF'S OWN MIGRATION INSTRUCTIONS: the brief this file
-- implements says migrations here are "applied by hand in the SQL editor".
-- That's stale — every migration actually in this repo since Phase 1
-- (20260826222037 through 20260902222537) documents itself as CLI-managed
-- via `supabase db push --linked`, confirmed working against the linked
-- project, and explicitly NOT the SQL-editor workflow Radial/wedding-invites
-- use. This file follows the convention that's actually in the repo, not
-- the brief's stale instruction — flagged here and in the executor's report
-- rather than silently doing either without saying so.

-- ============================================================================
-- Tables
-- ============================================================================

-- Current owner of each tile. h3 as PRIMARY KEY enforces first-to-claim:
-- `insert ... on conflict (h3) do nothing` is atomic and race-free under two
-- runners claiming the same street minutes apart, and it cannot drift from
-- the intended rule because it IS the rule. Application code (territory-
-- sync.ts) must never reimplement this check — see the brief §2.
create table if not exists territory_tiles (
  h3               text primary key,
  owner_id         uuid not null references auth.users(id),
  first_claimed_at timestamptz not null default now(),
  claim_run_id     uuid references runs(id),
  -- Updated on EVERY visit, including ones that lose the on-conflict race —
  -- see the brief §2's "NOT speculative" callout. Not read by anything yet
  -- (decay is future work), but painful to retrofit onto a live table, so it
  -- ships now while it's free.
  last_visited_at  timestamptz not null default now(),
  -- Stand-in denominator for "district" until §1's real OSM municipio
  -- boundaries + runnable-tile precompute exist (explicitly out of scope
  -- this pass — see the brief §1 and the executor's report). This is the
  -- SAME coarse metro string already on runs.region (src/lib/regions.ts),
  -- not a real municipio ("Monterrey" the metro, not "San Pedro Garza
  -- García" the municipio) — a tile can belong to more than one named area
  -- later (parks, real municipios), which is why this is a plain nullable
  -- column and not a hard FK to a not-yet-existing areas table.
  region_id        text
);

create index if not exists territory_tiles_owner_idx on territory_tiles (owner_id);
create index if not exists territory_tiles_region_idx on territory_tiles (region_id);

-- Every visit by anyone, for stats, decay (future) and audit. See the brief
-- §2: NOT speculative, this is what the §2.5 forgery guard below validates,
-- and it's what a future 30-day rolling leaderboard (brief §1.5 Layer 2,
-- explicitly NOT this pass) will read.
create table if not exists tile_visits (
  h3         text not null,
  user_id    uuid not null references auth.users(id),
  run_id     uuid not null references runs(id),
  visited_at timestamptz not null default now(),
  primary key (h3, run_id)
);

create index if not exists tile_visits_user_idx on tile_visits (user_id);
create index if not exists tile_visits_run_idx on tile_visits (run_id);

-- ============================================================================
-- RLS
-- ============================================================================

alter table territory_tiles enable row level security;
alter table tile_visits enable row level security;

-- A runner needs to see rivals' territory (that's the feature) and needs to
-- see other runners' tile_visits eventually for the Layer 2 rolling board
-- (brief §1.5, not this pass but cheap to open now — mirrors runs/profiles'
-- existing "read all" policies rather than inventing a narrower one that
-- would need its own migration later).
create policy "territory_tiles: read all" on territory_tiles
  for select using (true);

create policy "territory_tiles: insert own" on territory_tiles
  for insert with check (auth.uid() = owner_id);

-- UPDATE is NOT owner-only, deliberately: the brief §2 requires
-- last_visited_at to update "on every visit even when the insert conflicts"
-- — i.e. ANY runner who crosses a tile someone else already owns must be
-- able to bump last_visited_at on that row. Ownership itself stays
-- unstealable regardless: enforce_territory_tiles_immutable() below (a
-- trigger, not RLS) rejects any UPDATE that changes owner_id,
-- first_claimed_at, claim_run_id or h3, no matter who issues it or what
-- this policy allows. The two are deliberately split — RLS decides WHO may
-- attempt an update, the trigger decides WHAT an update may change — because
-- a `with check` clause on a policy can't compare NEW against OLD directly.
create policy "territory_tiles: update any (immutability enforced by trigger)" on territory_tiles
  for update using (true) with check (true);

create policy "tile_visits: read all" on tile_visits
  for select using (true);

create policy "tile_visits: insert own" on tile_visits
  for insert with check (auth.uid() = user_id);

-- No update/delete policy on tile_visits — it's an append-only visit log
-- (the brief calls it "for stats, decay and audit"); nothing should ever
-- rewrite or remove a row from it.

-- ============================================================================
-- Ownership immutability (the actual first-to-claim enforcement, part 2)
-- ============================================================================

-- The primary key + ON CONFLICT DO NOTHING (in territory-sync.ts's
-- claimTiles) is what makes first claim win. This trigger is what stops a
-- SECOND write from quietly rewriting an already-claimed tile's ownership
-- via UPDATE instead of INSERT — the read-all/update-any RLS policy above
-- is intentionally permissive (any runner needs to bump last_visited_at on
-- someone else's tile), so without this a permissive RLS + a plain UPDATE
-- would let anyone reassign any tile to themselves at any time, which is
-- strictly worse than having no first-to-claim rule at all.
create or replace function enforce_territory_tiles_immutable()
returns trigger
language plpgsql
as $$
begin
  if new.h3 is distinct from old.h3
    or new.owner_id is distinct from old.owner_id
    or new.first_claimed_at is distinct from old.first_claimed_at
    or new.claim_run_id is distinct from old.claim_run_id
  then
    raise exception 'territory_tiles: h3/owner_id/first_claimed_at/claim_run_id are immutable after first claim (h3=%)', old.h3;
  end if;
  return new;
end;
$$;

drop trigger if exists territory_tiles_immutable on territory_tiles;
create trigger territory_tiles_immutable
  before update on territory_tiles
  for each row
  execute function enforce_territory_tiles_immutable();

-- ============================================================================
-- §2.5 Forgery guard
-- ============================================================================
--
-- THE BRIEF RECOMMENDS OPTION 2 (corridor check: reject a submitted cell
-- whose centre is further than ~1 tile from the nearest raw_path point).
-- THIS MIGRATION SHIPS OPTION 3 (count bound) INSTEAD, and this comment
-- explains why at the length the deviation deserves — the brief explicitly
-- asks for that if option 2 turns out to be unworkable.
--
-- Option 2, and option 1 (full server recompute) equally, both need one
-- piece of machinery neither Postgres nor this migration has: turning an H3
-- cell id BACK into a lat/lng (cellToLatLng) or a lat/lng INTO an H3 cell id
-- (latLngToCell). That's real H3 projection math (icosahedron gnomonic
-- projection, face tables, IJK coordinates) — not something PostGIS's
-- ST_Distance/ST_MakePoint (used below, and by flag_implausible_speed
-- already on main) can approximate, and not something safe to hand-roll
-- correctly in plpgsql for a first ship. Supabase's hosted Postgres does not
-- offer an h3/h3-pg extension in its pre-approved extension list (verified
-- 2026-09-03 against github.com/orgs/supabase/discussions/9687 and
-- github.com/supabase/postgres#245, both still open feature requests, not
-- shipped) — so `create extension h3;` is not available the way `create
-- extension postgis;` was for Phase 1. Without it, neither option 1 nor
-- option 2 can verify that a submitted h3 STRING actually corresponds to
-- ground near raw_path; both would have to either (a) hand-port H3's
-- projection math into plpgsql — a second implementation with its own drift
-- risk, arguably worse than the drift risk the brief already rejected
-- option 1 for — or (b) run the real h3-js package server-side in a Supabase
-- Edge Function (Deno can `import "npm:h3-js"` directly, so this would be
-- the SAME code as tiles.ts, not a second implementation). (b) is a real,
-- buildable path and the right NEXT step if cheating actually appears (the
-- brief's own stated bar for moving to something stronger than option 3) —
-- it is out of scope for this pass because it introduces a wholly new
-- deployment mechanism (`supabase functions deploy`) this repo has never
-- used, on top of an already large change.
--
-- So: this trigger bounds submitted tile COUNT against what the run's own
-- distance_m could plausibly cover, using ONLY PostGIS/arithmetic that's
-- already proven in this repo (flag_implausible_speed, same migration
-- family). It is deliberately generous — see the constants below — and it
-- DOES catch the real incident that motivated this whole brief: a 3.3km
-- one-way path that auto-closed into a 977,565 m² fence under the OLD
-- enclosure model. Under tiles, that shape is ~454 res-11 cells
-- (977,565 / ~2,150 m² per cell); this trigger's bound for a 3.3km path is
-- ceil(3300/25)*3 = 396 cells — the exploit run would have been REJECTED.
--
-- WHAT THIS DOES NOT CATCH, stated plainly per the brief's own standard (a
-- guard that reads as protection but isn't is worse than none): a
-- TARGETED forgery that keeps a plausible cell COUNT for the claimed
-- distance but swaps in cell ids for ground the runner never went near
-- (e.g. claims real tiles in a desirable neighbourhood across town instead
-- of their own street) passes this check completely. Closing that gap
-- needs the real per-cell verification described above (option 1 or 2, via
-- an Edge Function) and is NOT built in this pass — do not read
-- `flagged = false` / a successful claim as proof of an honest run, same
-- caveat flag_implausible_speed already carries.
create or replace function check_tile_visit_plausibility()
returns trigger
language plpgsql
as $$
declare
  -- Res-11 edge length per the brief §1 (~25m). A constant, not derived —
  -- H3's own published cell statistics, same "known constant" trick the
  -- brief itself uses for cell area (2,150 m²) rather than computing it.
  tile_edge_m constant numeric := 25;
  -- How many tile-edges' worth of DISTINCT cells a run may plausibly cover
  -- per metre travelled. A straight path covers close to 1x; a winding
  -- street grid or a path that clips hex corners at an angle can run
  -- somewhat higher. 3x is generous headroom for real route geometry while
  -- still catching gross fabrication — see the worked example above. THIS
  -- IS A TUNED CONSTANT, not verified against real device data (no live
  -- tile uploads exist yet) — same category as the accuracy threshold and
  -- other tuned constants this repo has been burned by "correcting" without
  -- re-testing. Revisit once real runs have gone through it.
  safety_multiplier constant numeric := 3;
  -- Floor for very short/near-stationary runs, where distance_m alone would
  -- imply an unreasonably small allowance (a runner standing still still
  -- covers the one cell they're in, plus GPS jitter into 1-2 neighbours).
  min_allowed_tiles constant integer := 8;
  r record;
  run_distance_m numeric;
  cnt integer;
  max_allowed integer;
begin
  -- Distinct run_ids touched by THIS statement's batch — but the count
  -- checked below is the CUMULATIVE distinct-h3 total for that run_id
  -- across every tile_visits row that exists for it (this batch plus any
  -- earlier one), not just this batch's own rows. A single insert() call
  -- covers the normal path (territory-sync.ts submits one run's whole
  -- cell list at once), but bounding only the batch just inserted would
  -- let a deliberately-chunked upload (many small inserts for the same
  -- run_id) bypass the cap entirely — this closes that.
  for r in select distinct run_id from new_rows
  loop
    select distance_m into run_distance_m from runs where id = r.run_id;
    -- No matching run (shouldn't happen — run_id is a not-null FK) or a
    -- run with no distance recorded: fail closed rather than dividing by
    -- something that isn't there.
    if run_distance_m is null then
      raise exception 'TILE_FORGERY_GUARD: run % has no distance_m; cannot validate submitted tiles', r.run_id;
    end if;

    select count(distinct h3) into cnt from tile_visits where run_id = r.run_id;
    max_allowed := greatest(min_allowed_tiles, ceil(run_distance_m / tile_edge_m) * safety_multiplier)::integer;

    if cnt > max_allowed then
      raise exception 'TILE_FORGERY_GUARD: run % has % distinct claimed tiles total, which exceeds the plausible bound of % for a %sm run (edge %sm, x% margin)',
        r.run_id, cnt, max_allowed, run_distance_m, tile_edge_m, safety_multiplier;
    end if;
  end loop;
  return null; -- ignored for an AFTER STATEMENT trigger
end;
$$;

drop trigger if exists tile_visits_plausibility_guard on tile_visits;
create trigger tile_visits_plausibility_guard
  after insert on tile_visits
  referencing new table as new_rows
  for each statement
  execute function check_tile_visit_plausibility();

-- ============================================================================
-- flag_implausible_speed (ae8beb9, 20260827_anti_cheat_flag.sql) is UNCHANGED
-- ============================================================================
-- The brief §2.5 confirms it's model-agnostic (it only ever reads
-- distance_m/duration_s/raw_path on `runs`, never `fence` or anything tile-
-- shaped) and must be kept regardless of this migration. Nothing in this
-- file touches it. A flagged run still saves and still claims whatever
-- tiles pass the guard above — marked, not punished, same as today.

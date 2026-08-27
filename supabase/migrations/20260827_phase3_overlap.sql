-- Territory Mode — Phase 3: cross-user overlap (full take)
-- See: Source Data/Outputs/Running App/Territory Mode — Feature Plan.md §Phase 3
--
-- Apply with `supabase db push --linked` (this project's migrations are
-- CLI-managed — see the Phase 1 migration's header). Check with
-- `supabase migration list --linked` if it looks like it didn't take.
--
-- WHAT THIS DOES: when a run is inserted, any OTHER user's fence it overlaps
-- gets that overlap carved out of it, and a territory_events row records the
-- transfer. Full take, not split — the invader keeps their whole fence and
-- the loser keeps only what wasn't covered. That's the locked-in rule from
-- the plan; ST_Difference gives it for free.
--
-- WHAT THIS DELIBERATELY DOES NOT DO:
--   * anti-cheat (no speed/spoofing check — threshold still undecided)
--   * privacy zones (home_point exists but nothing masks raw_path yet)
--   * loser notification (territory_events is written, nothing reads it)
-- Each needs a decision before it's written. None of them block this.

-- The trigger updates OTHER users' rows and inserts into territory_events,
-- which no RLS policy allows. SECURITY DEFINER runs it as the function's
-- owner (the table owner), which bypasses RLS — the standard Supabase
-- pattern for exactly this. It is NOT a hole: the function only ever writes
-- the difference of an existing fence against the row that just landed, and
-- callers can't pass it arguments.
create or replace function apply_territory_overlap()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  loser record;
  remaining geometry;
  taken_m2 numeric;
  cell_key text;
begin
  -- Nothing to contest.
  if new.fence is null or ST_IsEmpty(new.fence) then
    return new;
  end if;

  -- Two runs finishing in overlapping geography at the same moment would
  -- otherwise both read "no overlap yet" and neither would subtract from the
  -- other. Serialise on a coarse (~5km) grid cell around the new fence, so
  -- unrelated runs elsewhere never wait on each other.
  cell_key := round(ST_Y(ST_Centroid(new.fence))::numeric, 1)::text || ':' ||
              round(ST_X(ST_Centroid(new.fence))::numeric, 1)::text;
  perform pg_advisory_xact_lock(hashtext(cell_key));

  for loser in
    select id, user_id, fence
    from runs
    where user_id <> new.user_id
      and id <> new.id
      and fence is not null
      and not ST_IsEmpty(fence)
      -- ST_Intersects is the indexable predicate — this is what the
      -- runs_fence_gix GiST index exists for. Without it this is a full
      -- table scan on every insert.
      and ST_Intersects(fence, new.fence)
    for update
  loop
    -- How much ground actually changes hands. Measured before the cut, on
    -- the geography type so the answer is in real m², not square degrees.
    taken_m2 := ST_Area(
      ST_Intersection(ST_MakeValid(loser.fence), ST_MakeValid(new.fence))::geography
    );

    -- Skip slivers: two fences merely touching along an edge "intersect"
    -- but transfer no meaningful area, and recording those would spam
    -- territory_events with 0 m² events on every adjacent run.
    if taken_m2 is null or taken_m2 < 1 then
      continue;
    end if;

    -- ST_Difference can return a GEOMETRYCOLLECTION with stray lines/points
    -- where the boundaries touch. CollectionExtract(..., 3) keeps only the
    -- polygonal part; without it the fence column ends up holding geometry
    -- that ST_Area reads as 0 and the app can't draw.
    remaining := ST_CollectionExtract(
      ST_Difference(ST_MakeValid(loser.fence), ST_MakeValid(new.fence)),
      3
    );

    if remaining is null or ST_IsEmpty(remaining) then
      -- Fully overtaken. The row STAYS, with no fence and no area: it is a
      -- historical record that this run happened and then got taken, and
      -- deleting it would break both the run history and any future
      -- per-user aggregate that wants every row that ever existed.
      update runs
        set fence = null,
            area_m2 = 0
        where id = loser.id;
    else
      update runs
        set fence = ST_Multi(remaining),
            area_m2 = ST_Area(remaining::geography)
        where id = loser.id;
    end if;

    insert into territory_events (winner_run_id, loser_run_id, area_taken_m2)
    values (new.id, loser.id, taken_m2);
  end loop;

  return new;
end;
$$;

-- AFTER INSERT, not BEFORE: the new row must already exist for
-- territory_events.winner_run_id to reference it.
drop trigger if exists runs_apply_overlap on runs;
create trigger runs_apply_overlap
  after insert on runs
  for each row
  execute function apply_territory_overlap();

-- territory_events is written only by the trigger above (SECURITY DEFINER),
-- so no insert policy is added — clients still must not write it directly.
-- The Phase 1 read-all policy already covers reading it.

-- Supporting index: the per-user aggregate and the run history both filter
-- by user and sort by recency.
create index if not exists runs_user_started_idx on runs (user_id, started_at desc);

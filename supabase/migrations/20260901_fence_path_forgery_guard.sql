-- Territory Mode — fence/path geometric consistency guard
--
-- Apply with `supabase db push --linked` (CLI-managed — see the Phase 1
-- migration's header). Check with `supabase migration list --linked` if it
-- looks like it didn't take.
--
-- WHY THIS EXISTS (Critical, 2026-09-01 deep review of 519dceb..ae8beb9).
-- apply_territory_overlap() (20260827_phase3_overlap.sql) carves any
-- submitted `fence` polygon out of every overlapping user's territory.
-- flag_implausible_speed() (20260827_anti_cheat_flag.sql) checks
-- distance_m/duration_s/raw_path SPEED only — it never references `fence`
-- at all. Nothing anywhere ties the two columns together. The project's own
-- supabase/verify-phase3.sql fixture proves it: it inserts a test row with
-- raw_path: '[]'::jsonb next to a hand-drawn ~1.1 km² fence, and that's a
-- fully valid insert today.
--
-- Since EXPO_PUBLIC_SUPABASE_ANON_KEY ships in the app bundle by design,
-- anyone can `signInAnonymously()` and POST one `runs` row straight to
-- PostgREST with a short, plausible raw_path and an arbitrarily large
-- fence — instantly carving real territory off real players, repeatably,
-- with a fresh anonymous identity each time and no rate limit anywhere.
--
-- THE CHECK: the isoperimetric inequality. Any closed curve of perimeter L
-- encloses at most L² / (4π) of area — a circle is the most area-efficient
-- closed shape that exists; nothing beats it, ever. buildFence()
-- (src/lib/territory.ts) builds `fence` by auto-closing raw_path into a
-- ring (closeRing: append the start point to the end) and then only ever
-- SIMPLIFYING that ring and UNIONING its self-intersection pieces back
-- together — simplify() drops points, union() recombines sub-polygons,
-- NEITHER ever adds area outside the ring's own convex hull. So for any
-- HONEST client, fence's area can never exceed the isoperimetric bound on
-- raw_path's own closed length (path distance + the closing segment back to
-- the start). This is a hard mathematical ceiling, not a heuristic — it
-- cannot produce a false positive against a real run, which is what makes
-- it safe to REJECT the insert outright, unlike the speed check next door
-- (which only flags: a degraded GPS signal can genuinely look fast, but no
-- GPS glitch can make a real run's fence bigger than geometry allows). A
-- generous 1.2x safety margin absorbs PostGIS-geography vs turf/area
-- rounding differences and simplify()'s tolerance — see the verify script
-- for why 1.2x was chosen.
--
-- Deliberately does NOT reuse `flagged`/`flag_reason`: those mean "still
-- saves, still holds territory, just marked" (Pedro's explicit call for the
-- speed check — a GPS glitch must never cost someone a real run). A fence
-- that is geometrically IMPOSSIBLE given its own path is a different kind
-- of thing: no honest client can ever produce one, so there is no
-- false-positive cost to weigh, and letting it merely "flag" would still
-- let apply_territory_overlap() (which does not check `flagged`) carve real
-- territory off real players — leaving the actual exploit open. Rejecting
-- the insert also means the AFTER INSERT overlap trigger never runs at all.
--
-- WHAT THIS STILL CANNOT DO: an attacker willing to submit a raw_path whose
-- own claimed length actually supports the fence size they want clears this
-- check (and would then need duration_s long enough to also clear the speed
-- check next door). This raises the cost of forgery to "submit a real
-- amount of plausible-looking path data" — it does not prove raw_path came
-- from a real device. Same threat model the anti-cheat migration already
-- states for itself; this closes the "zero relationship at all" gap, it
-- does not claim to close every gap.
create or replace function validate_fence_matches_path()
returns trigger
language plpgsql
as $$
declare
  safety_margin constant numeric := 1.2;
  n int;
  first_lat numeric;
  first_lng numeric;
  last_lat numeric;
  last_lng numeric;
  closing_m numeric;
  perimeter_m numeric;
  fence_area_m2 numeric;
  max_area_m2 numeric;
begin
  if new.fence is null or ST_IsEmpty(new.fence) then
    return new;
  end if;

  n := jsonb_array_length(new.raw_path);

  -- Fewer than 2 points can't enclose any area at all — any non-null fence
  -- here is definitionally impossible, independent of the formula below
  -- (which would otherwise divide a zero perimeter into a zero bound and
  -- get the same answer, but this gives a clearer error for that case).
  if n < 2 then
    raise exception
      'territory forgery guard: fence present but raw_path has only % point(s)', n
      using errcode = '23514';
  end if;

  first_lat := (new.raw_path->0->>0)::numeric;
  first_lng := (new.raw_path->0->>1)::numeric;
  last_lat := (new.raw_path->(n - 1)->>0)::numeric;
  last_lng := (new.raw_path->(n - 1)->>1)::numeric;

  -- Perimeter = travelled path length (consecutive-segment sum, same
  -- window-function shape as flag_implausible_speed's own CHECK 2) + the
  -- closing segment back to the start, matching territory.ts's closeRing().
  with pts as (
    select
      ordinality as i,
      (elem->>0)::float8 as lat,
      (elem->>1)::float8 as lng
    from jsonb_array_elements(new.raw_path) with ordinality as t(elem, ordinality)
  ),
  segs as (
    select
      ST_Distance(
        ST_MakePoint(lag(lng) over w, lag(lat) over w)::geography,
        ST_MakePoint(lng, lat)::geography
      ) as d_m
    from pts
    window w as (order by i)
  )
  select coalesce(sum(d_m), 0) into perimeter_m from segs where d_m is not null;

  closing_m := ST_Distance(
    ST_MakePoint(first_lng, first_lat)::geography,
    ST_MakePoint(last_lng, last_lat)::geography
  );
  perimeter_m := perimeter_m + closing_m;

  fence_area_m2 := ST_Area(new.fence::geography);
  max_area_m2 := (perimeter_m ^ 2) / (4 * pi()) * safety_margin;

  if fence_area_m2 > max_area_m2 then
    raise exception
      'territory forgery guard: fence area % m2 exceeds the isoperimetric maximum % m2 for a %m closed path',
      round(fence_area_m2), round(max_area_m2), round(perimeter_m)
      using errcode = '23514';
  end if;

  return new;
end;
$$;

-- BEFORE INSERT only, deliberately not UPDATE: the exploit is a forged
-- INSERT via PostgREST. apply_territory_overlap()'s own UPDATEs to OTHER
-- rows only ever SHRINK a fence (ST_Difference), never grow one, so they can
-- never newly violate a bound their original insert already satisfied —
-- adding UPDATE coverage would gate trusted internal maintenance writes for
-- no benefit, for a check that has never run in production before.
drop trigger if exists runs_validate_fence on runs;
create trigger runs_validate_fence
  before insert on runs
  for each row
  execute function validate_fence_matches_path();

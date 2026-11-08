-- Fence forgery guard, part 2: the fence must lie ON its own path.
--
-- validate_fence_matches_path (20260901_fence_path_forgery_guard.sql) only
-- checked that the fence's AREA fits the path's length (isoperimetric
-- bound). It never checked WHERE the fence is: found 2026-11-03 while
-- testing the PostGIS move, a real run's fence translated ~5 km away was
-- accepted. This adds a location check: every fence vertex within 50 m of
-- the recorded raw_path. Body otherwise identical to the live function.
--
-- Apply AFTER 20261104120000_postgis_to_extensions (uses
-- search_path = public, extensions; the names resolve either way).
-- Only new INSERTs are checked (BEFORE INSERT trigger); existing rows are
-- untouched. All 45 existing fences pass the new rule (max 14.2 m).
-- Verify: npm run verify-postgis-move -- snapshot ... -> c2c_moved_fence refused.

create or replace function public.validate_fence_matches_path()
 returns trigger
 language plpgsql
 set search_path = public, extensions
as $function$
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
  max_vertex_gap_m constant numeric := 50;
  path_line geometry;
  stray int;
  worst_m numeric;
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

  -- LOCATION: every vertex of the fence must lie on (near) the run's own
  -- path. The area check above only bounds SIZE, so before 2026-11-04 a
  -- fence moved 5 km away from its path was accepted. An honest fence is
  -- built from the same privacy-masked path that is stored in raw_path
  -- (territory-sync.ts: buildFence on the masked points), so its vertices
  -- ARE path points, give or take simplification. Measured on all 45 real
  -- fences (2026-11-03): worst vertex 14.2 m from its path, all others
  -- <= 2.4 m. 50 m is 3.5x the worst honest case. Vertices are enough:
  -- with every corner on the path, the area bound above stops an edge from
  -- spanning ground the runner never closed.
  path_line := ST_MakeLine(array(
    select ST_MakePoint((elem->>1)::float8, (elem->>0)::float8)
    from jsonb_array_elements(new.raw_path) with ordinality as t(elem, ordinality)
    order by ordinality));

  select count(*), round(max(ST_Distance(d.geom::geography, path_line::geography))::numeric)
    into stray, worst_m
    from ST_DumpPoints(new.fence) as d
    where not ST_DWithin(d.geom::geography, path_line::geography, max_vertex_gap_m);

  if stray > 0 then
    raise exception
      'territory forgery guard: % fence vertices lie off the recorded path (worst % m, limit % m)',
      stray, worst_m, max_vertex_gap_m
      using errcode = '23514';
  end if;

  return new;
end;
$function$;

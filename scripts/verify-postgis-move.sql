-- Checks for the PostGIS schema move (20261104120000_postgis_to_extensions).
--
-- ONE DO block that ends by RAISING its results, so every write it makes
-- (test runs inserted as a real runner, through the real triggers) is rolled
-- back. Safe on production: nothing persists. The result is the error text
-- `RESULT:{json}`; scripts/verify-postgis-move.mjs parses it and compares a
-- BEFORE snapshot with an AFTER one. Same SQL both sides, so any difference
-- is the move's doing.
--
-- Uses no schema-qualified PostGIS names: it resolves ST_* through
-- search_path exactly as the app's functions do (public before, extensions
-- after; postgres's own search_path includes both).
do $verify$
declare
  res jsonb := '{}'::jsonb;
  src record;
  uid uuid;
  newid uuid;
  r record;
  fast jsonb;
  t0 bigint;
begin
  -- A. The database itself ------------------------------------------------
  res := res || jsonb_build_object(
    'postgis_schema', (select extnamespace::regnamespace::text from pg_extension where extname = 'postgis'),
    'public_spatial_ref_sys', to_regclass('public.spatial_ref_sys') is not null,
    'srid_4326_rows', (select count(*) from spatial_ref_sys where srid = 4326),
    'runs_total', (select count(*) from public.runs),
    'runs_with_fence', (select count(fence) from public.runs),
    'fence_type', (select format_type(atttypid, atttypmod) from pg_attribute
                   where attrelid = 'public.runs'::regclass and attname = 'fence' and not attisdropped),
    'fence_wkt_md5', (select md5(string_agg(st_asewkt(fence), '|' order by id)) from public.runs where fence is not null),
    'fence_geog_area_sum', (select round(sum(st_area(fence::geography))::numeric, 3) from public.runs where fence is not null),
    'fence_index', (select regexp_replace(indexdef, '\s+', ' ', 'g') from pg_indexes
                    where schemaname = 'public' and indexname = 'runs_fence_gix'),
    'triggers', (select jsonb_agg(pg_get_triggerdef(oid) order by tgname) from pg_trigger
                 where tgrelid = 'public.runs'::regclass and not tgisinternal)
  );

  -- C. As a real runner, through the real triggers -------------------------
  -- Template: the newest run that has a fence.
  select * into src from public.runs where fence is not null order by started_at desc limit 1;
  uid := src.user_id;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', uid, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', uid::text, true);
  execute 'set local role authenticated';

  -- C2: an honest copy of a real run must be accepted, unflagged as before.
  begin
    insert into public.runs (user_id, region, started_at, ended_at, distance_m, duration_s, raw_path, fence, area_m2, laps)
    values (uid, src.region, src.started_at + interval '1 day', src.ended_at + interval '1 day', src.distance_m,
            src.duration_s, src.raw_path, src.fence, src.area_m2, src.laps)
    returning id, flagged, flag_reason, area_m2, st_asewkt(fence) = st_asewkt(src.fence) as same_fence
      into r;
    res := res || jsonb_build_object('c2_copy', jsonb_build_object(
      'ok', true, 'flagged', r.flagged, 'flag_reason', r.flag_reason, 'area_m2', r.area_m2, 'same_fence', r.same_fence,
      'fence_reads_back_as_geojson', (select (st_asgeojson(fence)::jsonb ->> 'type') from public.runs where id = r.id)));
  exception when others then
    res := res || jsonb_build_object('c2_copy', jsonb_build_object('ok', false, 'err', sqlstate || ' ' || sqlerrm));
  end;

  -- C2b: a fence far too big for its path (grown by ~5 km) must be
  -- refused by runs_validate_fence (isoperimetric guard, 23514). NOTE: the
  -- guard checks AREA only, not location: a fence moved away from its path
  -- is accepted, before and after the move (pre-existing, 2026-11-03).
  begin
    insert into public.runs (user_id, region, started_at, ended_at, distance_m, duration_s, raw_path, fence, area_m2, laps)
    values (uid, src.region, src.started_at + interval '2 day', src.ended_at + interval '2 day', src.distance_m,
            src.duration_s, src.raw_path, st_buffer(src.fence, 0.05), src.area_m2, src.laps);
    res := res || jsonb_build_object('c2b_bad_fence', jsonb_build_object('ok', true));
  exception when others then
    res := res || jsonb_build_object('c2b_bad_fence', jsonb_build_object('ok', false, 'err', sqlstate || ' ' || sqlerrm));
  end;

  -- C3: the same path run 4x faster must trip the speed guard.
  t0 := (src.raw_path -> 0 ->> 2)::bigint;
  select jsonb_agg(jsonb_build_array(p -> 0, p -> 1, t0 + ((p ->> 2)::bigint - t0) / 4) order by n)
    into fast from jsonb_array_elements(src.raw_path) with ordinality as e(p, n);
  begin
    insert into public.runs (user_id, region, started_at, ended_at, distance_m, duration_s, raw_path, fence, area_m2, laps)
    values (uid, src.region, src.started_at + interval '3 day', src.started_at + interval '3 day' + (src.ended_at - src.started_at) / 4,
            src.distance_m, src.duration_s / 4, fast, src.fence, src.area_m2, src.laps)
    returning flagged, flag_reason into r;
    res := res || jsonb_build_object('c3_fast', jsonb_build_object('ok', true, 'flagged', r.flagged, 'flag_reason', r.flag_reason));
  exception when others then
    res := res || jsonb_build_object('c3_fast', jsonb_build_object('ok', false, 'err', sqlstate || ' ' || sqlerrm));
  end;

  execute 'reset role';

  -- C4: after the inserts (and runs_apply_overlap), every runner's fences.
  res := res || jsonb_build_object(
    'c4_all_fences_md5_after_inserts',
    (select md5(string_agg(coalesce(st_asewkt(fence), '-'), '|' order by started_at, user_id, coalesce(st_asewkt(fence), '-'), area_m2)) from public.runs));

  raise exception 'RESULT:%', res::text;
end
$verify$;

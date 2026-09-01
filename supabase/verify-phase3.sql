-- Verification for Phase 3's overlap trigger. NOT a migration — this is a
-- throwaway you paste into the SQL editor. Part 2 rolls itself back, so
-- nothing here leaves data behind.
--
-- Why this exists: "Success. No rows returned" only proves the DDL parsed.
-- And the trigger only fires when a run belongs to a DIFFERENT user
-- (`user_id <> new.user_id`), so with one phone and one anonymous account
-- there is no way to exercise it in the app — this is the only way to know
-- it works before a second real runner exists.
--
-- raw_path below traces each square's own boundary (real closed loops, not
-- '[]') — required since 20260901_fence_path_forgery_guard.sql. Before that
-- guard existed, this script's own '[]'::jsonb + hand-drawn-fence fixture
-- was itself proof of the bug it fixes (see that migration's header); once
-- applied, an empty raw_path next to a real fence is rejected before this
-- script's overlap assertions ever get to run.

-- ---------------------------------------------------------------------
-- PART 1 — do the objects exist? (read-only, safe to run any time)
-- ---------------------------------------------------------------------
select
  (select count(*) from pg_proc
     where proname = 'apply_territory_overlap')                as function_count,
  (select count(*) from pg_trigger
     where tgname = 'runs_apply_overlap' and not tgisinternal) as trigger_count,
  (select count(*) from pg_indexes
     where tablename = 'runs' and indexname = 'runs_fence_gix') as fence_index_count,
  (select prosecdef from pg_proc
     where proname = 'apply_territory_overlap')                as is_security_definer;
-- Expect: 1, 1, 1, true
-- Anything 0 means that object didn't get created and the trigger is inert.


-- ---------------------------------------------------------------------
-- PART 2 — does it actually carve? (rolls back; nothing persists)
-- ---------------------------------------------------------------------
-- Two users run overlapping square loops in Monterrey. User B's run should
-- carve its overlap out of user A's fence and log a territory_events row.
-- Run this whole block at once — the ROLLBACK at the end is what makes it
-- safe, so do not run it line by line.
begin;

-- Fake identities. auth.users is the FK target for profiles.
insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at)
values
  ('aaaaaaaa-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'test-a@example.invalid', now(), now()),
  ('bbbbbbbb-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'test-b@example.invalid', now(), now());

insert into profiles (id, display_name) values
  ('aaaaaaaa-0000-4000-8000-000000000001', 'Test A'),
  ('bbbbbbbb-0000-4000-8000-000000000002', 'Test B');

-- User A: a ~1.1km square. raw_path traces the same ring the fence is —
-- exactly what buildFence() actually does client-side (closeRing() auto-
-- closes the path, then only simplifies/unions it).
insert into runs (id, user_id, region, started_at, ended_at, distance_m, duration_s, raw_path, fence, area_m2)
values (
  'aaaaaaaa-1111-4000-8000-000000000001',
  'aaaaaaaa-0000-4000-8000-000000000001',
  'mty', now() - interval '1 hour', now(), 4452, 1800,
  '[[25.68,-100.32,1756296400000],[25.68,-100.31,1756296800000],[25.69,-100.31,1756297200000],[25.69,-100.32,1756297600000],[25.68,-100.32,1756298000000]]'::jsonb,
  ST_GeomFromText('POLYGON((-100.32 25.68, -100.31 25.68, -100.31 25.69, -100.32 25.69, -100.32 25.68))', 4326),
  ST_Area(ST_GeomFromText('POLYGON((-100.32 25.68, -100.31 25.68, -100.31 25.69, -100.32 25.69, -100.32 25.68))', 4326)::geography)
);

select 'A before B runs' as step, area_m2::bigint as area_m2
from runs where id = 'aaaaaaaa-1111-4000-8000-000000000001';

-- User B: overlaps the right half of A's square. The trigger fires here.
insert into runs (id, user_id, region, started_at, ended_at, distance_m, duration_s, raw_path, fence, area_m2)
values (
  'bbbbbbbb-1111-4000-8000-000000000002',
  'bbbbbbbb-0000-4000-8000-000000000002',
  'mty', now() - interval '30 minutes', now(), 4452, 1800,
  '[[25.68,-100.315,1756298600000],[25.68,-100.305,1756299000000],[25.69,-100.305,1756299400000],[25.69,-100.315,1756299800000],[25.68,-100.315,1756300200000]]'::jsonb,
  ST_GeomFromText('POLYGON((-100.315 25.68, -100.305 25.68, -100.305 25.69, -100.315 25.69, -100.315 25.68))', 4326),
  ST_Area(ST_GeomFromText('POLYGON((-100.315 25.68, -100.305 25.68, -100.305 25.69, -100.315 25.69, -100.315 25.68))', 4326)::geography)
);

-- A should now hold roughly HALF what it did. B should be untouched.
select
  case when user_id = 'aaaaaaaa-0000-4000-8000-000000000001' then 'A after being carved'
       else 'B (invader, untouched)' end as step,
  area_m2::bigint as area_m2,
  ST_GeometryType(fence) as geom_type
from runs
where id in ('aaaaaaaa-1111-4000-8000-000000000001', 'bbbbbbbb-1111-4000-8000-000000000002')
order by user_id;

-- And the transfer should be recorded.
select 'territory_events' as step, count(*) as events, max(area_taken_m2)::bigint as area_taken_m2
from territory_events
where winner_run_id = 'bbbbbbbb-1111-4000-8000-000000000002';

rollback;

-- WHAT PASSING LOOKS LIKE:
--   A before      ≈ 1,100,000 m²
--   A after       ≈ 550,000 m²   (about half — carved)
--   B             ≈ 550,000 m²   (unchanged; full take, invader keeps all)
--   events        = 1, area_taken ≈ 550,000 m²
--
-- If A's area is unchanged after B's insert, the trigger did not fire.
-- If A's geom_type is GEOMETRYCOLLECTION, the CollectionExtract guard failed.

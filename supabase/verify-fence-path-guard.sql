-- Verification for the fence/path forgery guard (20260901_fence_path_
-- forgery_guard.sql). NOT a migration — paste into the SQL editor.
-- Rolls itself back; nothing persists.
--
-- Five cases: the review's own proof-of-concept forgery (must reject), a
-- second forgery shape (short real path, oversized fence — must reject), a
-- 1-point path (must reject), an honest closed-loop run whose fence is
-- exactly the shape a real client would submit (must succeed), and a run
-- with no fence at all (must succeed regardless of raw_path — nothing to
-- validate when there's no territory being claimed).

-- ---------------------------------------------------------------------
-- PART 1 — does the object exist? (read-only, safe to run any time)
-- ---------------------------------------------------------------------
select
  (select count(*) from pg_proc
     where proname = 'validate_fence_matches_path')       as function_count,
  (select count(*) from pg_trigger
     where tgname = 'runs_validate_fence' and not tgisinternal) as trigger_count;
-- Expect: 1, 1. Either 0 means the migration hasn't been applied.


-- ---------------------------------------------------------------------
-- PART 2 — does it actually reject/accept correctly? (rolls back)
-- ---------------------------------------------------------------------
begin;

insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at)
values ('dddddddd-0000-4000-8000-000000000004', '00000000-0000-0000-0000-000000000000',
        'authenticated', 'authenticated', 'test-d@example.invalid', now(), now());
insert into profiles (id, display_name) values
  ('dddddddd-0000-4000-8000-000000000004', 'Test D');

-- CASE 1 — the review's own PoC: empty raw_path, real ~1.1km² fence.
-- MUST REJECT.
do $$
begin
  insert into runs (id, user_id, region, started_at, ended_at, distance_m, duration_s, raw_path, fence, area_m2)
  values (
    '11111111-9000-4000-8000-000000000001', 'dddddddd-0000-4000-8000-000000000004',
    'mty', now(), now(), 4000, 1800, '[]'::jsonb,
    ST_GeomFromText('POLYGON((-100.32 25.68, -100.31 25.68, -100.31 25.69, -100.32 25.69, -100.32 25.68))', 4326),
    1100000
  );
  raise notice '1. empty path + big fence: FAIL — insert should have been rejected';
exception when check_violation then
  raise notice '1. empty path + big fence: PASS — rejected (%)', sqlerrm;
end $$;

-- CASE 2 — a short, plausible-looking real path (~200m loop) claiming a
-- huge fence nowhere near what 200m of perimeter could ever enclose.
-- MUST REJECT.
do $$
begin
  insert into runs (id, user_id, region, started_at, ended_at, distance_m, duration_s, raw_path, fence, area_m2)
  values (
    '22222222-9000-4000-8000-000000000002', 'dddddddd-0000-4000-8000-000000000004',
    'mty', now(), now(), 200, 120,
    '[[25.68,-100.32,1756300000000],[25.6805,-100.32,1756300010000],[25.6805,-100.3195,1756300020000],[25.68,-100.3195,1756300030000]]'::jsonb,
    ST_GeomFromText('POLYGON((-100.32 25.68, -100.31 25.68, -100.31 25.69, -100.32 25.69, -100.32 25.68))', 4326),
    1100000
  );
  raise notice '2. short path + big fence: FAIL — insert should have been rejected';
exception when check_violation then
  raise notice '2. short path + big fence: PASS — rejected (%)', sqlerrm;
end $$;

-- CASE 3 — a single-point path with a fence. MUST REJECT (the n < 2 guard).
do $$
begin
  insert into runs (id, user_id, region, started_at, ended_at, distance_m, duration_s, raw_path, fence, area_m2)
  values (
    '33333333-9000-4000-8000-000000000003', 'dddddddd-0000-4000-8000-000000000004',
    'mty', now(), now(), 0, 60, '[[25.68,-100.32,1756300000000]]'::jsonb,
    ST_GeomFromText('POLYGON((-100.32 25.68, -100.31 25.68, -100.31 25.69, -100.32 25.69, -100.32 25.68))', 4326),
    1100000
  );
  raise notice '3. one-point path + fence: FAIL — insert should have been rejected';
exception when check_violation then
  raise notice '3. one-point path + fence: PASS — rejected (%)', sqlerrm;
end $$;

-- CASE 4 — an HONEST run: raw_path traces the exact same ring as the fence
-- (what buildFence() actually does — closeRing() auto-closes the path, then
-- only simplifies/unions it). Perimeter ≈ 4,452m for this square, comfortably
-- clearing the isoperimetric bound for its own 1.1M m² area. MUST SUCCEED.
insert into runs (id, user_id, region, started_at, ended_at, distance_m, duration_s, raw_path, fence, area_m2)
values (
  '44444444-9000-4000-8000-000000000004', 'dddddddd-0000-4000-8000-000000000004',
  'mty', now(), now(), 4452, 1800,
  '[[25.68,-100.32,1756300000000],[25.68,-100.31,1756300400000],[25.69,-100.31,1756300800000],[25.69,-100.32,1756301200000],[25.68,-100.32,1756301600000]]'::jsonb,
  ST_GeomFromText('POLYGON((-100.32 25.68, -100.31 25.68, -100.31 25.69, -100.32 25.69, -100.32 25.68))', 4326),
  1100000
);
select '4. honest closed loop' as case_, count(*) as rows_inserted
from runs where id = '44444444-9000-4000-8000-000000000004';
-- Expect: 1 (insert succeeded).

-- CASE 5 — no fence at all (e.g. a run too short to form one). MUST SUCCEED
-- regardless of raw_path — nothing to validate when nothing is being claimed.
insert into runs (id, user_id, region, started_at, ended_at, distance_m, duration_s, raw_path, fence, area_m2)
values (
  '55555555-9000-4000-8000-000000000005', 'dddddddd-0000-4000-8000-000000000004',
  'mty', now(), now(), 50, 60, '[]'::jsonb, null, 0
);
select '5. no fence' as case_, count(*) as rows_inserted
from runs where id = '55555555-9000-4000-8000-000000000005';
-- Expect: 1 (insert succeeded).

rollback;

-- PASS = cases 1-3 print "PASS — rejected", cases 4-5 each show
-- rows_inserted = 1. Any case 1-3 printing "FAIL" means a forged fence can
-- still get through; any case 4-5 with rows_inserted = 0 means the guard is
-- rejecting real runs — check the safety_margin in the migration first.

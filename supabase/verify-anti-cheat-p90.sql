-- Verification for the REPAIRED anti-cheat trigger
-- (20260904220000_anti_cheat_percentile.sql). NOT a migration — paste into
-- the SQL editor. Rolls itself back; nothing persists.
--
-- Case 2 is the one that matters most: it is the exact shape of the drive
-- that got through on 2026-09-03 — a ~22 km/h average (UNDER the 25 km/h
-- bar that CHECK 1 and 2 use) sampled about once a second (so the old
-- CHECK 3, which needed a segment spanning 20s or more, could never see it).
-- If case 2 comes back flagged=false, the repair did not take.
--
-- Case 4 is the false-positive guard: an honest run carrying one wild GPS
-- fix. A real run in this table contains a 171 km/h segment, and a
-- max-based rule would end it. A p90 must not move.
begin;

insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at)
values ('dddddddd-0000-4000-8000-000000000004', '00000000-0000-0000-0000-000000000000',
        'authenticated', 'authenticated', 'test-d@example.invalid', now(), now());
insert into profiles (id, display_name) values
  ('dddddddd-0000-4000-8000-000000000004', 'Test D');

-- Straight-line path: `n` points, `step_m` apart, `step_s` apart.
create or replace function _mkpath2(n int, step_m float8, step_s float8)
returns jsonb language sql as $f$
  select jsonb_agg(jsonb_build_array(
           25.68 + (i * step_m) / 111320.0,
           -100.32,
           1756300000000::float8 + (i * step_s * 1000)))
  from generate_series(0, n - 1) as g(i);
$f$;

-- Same, but point `spike_at` is displaced `spike_m` sideways — one bad fix.
create or replace function _mkpath2_spike(n int, step_m float8, step_s float8,
                                          spike_at int, spike_m float8)
returns jsonb language sql as $f$
  select jsonb_agg(jsonb_build_array(
           25.68 + (i * step_m) / 111320.0,
           -100.32 + case when i = spike_at then spike_m / 100340.0 else 0 end,
           1756300000000::float8 + (i * step_s * 1000)))
  from generate_series(0, n - 1) as g(i);
$f$;

insert into runs (id, user_id, region, started_at, ended_at, distance_m, duration_s, raw_path, fence, area_m2)
values
  -- 1. HONEST 10 km/h, 300 points 1s apart (2.78 m each) = 831 m / 299 s.
  --    p90 = 10 km/h. Must NOT flag.
  ('22222222-0000-4000-8000-000000000001', 'dddddddd-0000-4000-8000-000000000004',
   'mty', now(), now(), 831, 299, _mkpath2(300, 2.78, 1),
   '{"type":"Polygon","coordinates":[[[-100.32,25.68],[-100.32,25.69],[-100.31,25.69],[-100.32,25.68]]]}'::jsonb, 1000),

  -- 2. THE DRIVE THAT GOT THROUGH. 300 points 1s apart at 16.1 m each =
  --    ~58 km/h sustained, but reported as a 22 km/h average — under
  --    CHECK 1/2 — and with no segment long enough for the old CHECK 3.
  --    Must flag, reason 'speed:p90'.
  ('22222222-0000-4000-8000-000000000002', 'dddddddd-0000-4000-8000-000000000004',
   'mty', now(), now(), 1830, 299, _mkpath2(300, 16.1, 1),
   '{"type":"Polygon","coordinates":[[[-100.32,25.68],[-100.32,25.69],[-100.31,25.69],[-100.32,25.68]]]}'::jsonb, 1000),

  -- 3. TOO FEW SEGMENTS to judge: 60 points of the same fast movement. The
  --    percentile abstains (min_segments = 100) and CHECK 1/2 still apply —
  --    here the claimed average is honest, so this must NOT flag. This is
  --    the near-stationary jittery short run that would otherwise trip it.
  ('22222222-0000-4000-8000-000000000003', 'dddddddd-0000-4000-8000-000000000004',
   'mty', now(), now(), 300, 299, _mkpath2(60, 16.1, 5),
   '{"type":"Polygon","coordinates":[[[-100.32,25.68],[-100.32,25.69],[-100.31,25.69],[-100.32,25.68]]]}'::jsonb, 1000),

  -- 4. FALSE-POSITIVE GUARD: honest 10 km/h with ONE fix 300 m off course.
  --    That single segment reads about 1 080 km/h. A p90 over 300 segments
  --    cannot be moved by it. Must NOT flag.
  ('22222222-0000-4000-8000-000000000004', 'dddddddd-0000-4000-8000-000000000004',
   'mty', now(), now(), 831, 299, _mkpath2_spike(300, 2.78, 1, 150, 300),
   '{"type":"Polygon","coordinates":[[[-100.32,25.68],[-100.32,25.69],[-100.31,25.69],[-100.32,25.68]]]}'::jsonb, 1000);

select
  right(id::text, 1) as case_no,
  flagged,
  coalesce(flag_reason, '-') as reason,
  case right(id::text, 1)
    when '1' then 'expect: false  -'
    when '2' then 'expect: TRUE   speed:p90'
    when '3' then 'expect: false  -'
    when '4' then 'expect: false  -'
  end as expected
from runs
where user_id = 'dddddddd-0000-4000-8000-000000000004'
order by id;

rollback;

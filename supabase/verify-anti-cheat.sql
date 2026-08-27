-- Verification for the anti-cheat speed trigger. NOT a migration — paste
-- into the SQL editor. Rolls itself back; nothing persists.
--
-- Four cases, including the one most likely to be a false positive: a
-- privacy-masked run. Masking trims distance AND elapsed time together, so
-- the derived speed is unchanged — but that is an assumption worth proving,
-- because a masked run wrongly flagged would punish people for protecting
-- their address.
begin;

insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at)
values ('cccccccc-0000-4000-8000-000000000003', '00000000-0000-0000-0000-000000000000',
        'authenticated', 'authenticated', 'test-c@example.invalid', now(), now());
insert into profiles (id, display_name) values
  ('cccccccc-0000-4000-8000-000000000003', 'Test C');

-- Builds a straight-line path of `n` points, `step_m` apart, `step_s` apart.
create or replace function _mkpath(n int, step_m float8, step_s float8)
returns jsonb language sql as $f$
  select jsonb_agg(jsonb_build_array(
           25.68 + (i * step_m) / 111320.0,
           -100.32,
           1756300000000::float8 + (i * step_s * 1000)))
  from generate_series(0, n - 1) as g(i);
$f$;

insert into runs (id, user_id, region, started_at, ended_at, distance_m, duration_s, raw_path, fence, area_m2)
values
  -- 1. Honest 10 km/h run: 60 points, 50m / 18s apart = 2950m over 1062s.
  ('11111111-0000-4000-8000-000000000001', 'cccccccc-0000-4000-8000-000000000003',
   'mty', now(), now(), 2950, 1062, _mkpath(60, 50, 18), null, 0),
  -- 2. Driving: same path, 50m every 3s = 60 km/h.
  ('22222222-0000-4000-8000-000000000002', 'cccccccc-0000-4000-8000-000000000003',
   'mty', now(), now(), 2950, 177, _mkpath(60, 50, 3), null, 0),
  -- 3. Liar: drives, but claims a 3-hour duration so CHECK 1 passes. The
  --    path's own timestamps still give it away (CHECK 2).
  ('33333333-0000-4000-8000-000000000003', 'cccccccc-0000-4000-8000-000000000003',
   'mty', now(), now(), 2950, 10800, _mkpath(60, 50, 3), null, 0),
  -- 4. MASKED honest run: same 10 km/h, but the path is short (ends
  --    trimmed) while distance_m/duration_s stay TRUE and larger. Must NOT
  --    flag.
  ('44444444-0000-4000-8000-000000000004', 'cccccccc-0000-4000-8000-000000000003',
   'mty', now(), now(), 4000, 1440, _mkpath(30, 50, 18), null, 0);

select
  case id
    when '11111111-0000-4000-8000-000000000001' then '1. honest 10km/h  (want: f)'
    when '22222222-0000-4000-8000-000000000002' then '2. driving 60km/h (want: t)'
    when '33333333-0000-4000-8000-000000000003' then '3. fake duration  (want: t)'
    else                                             '4. masked honest  (want: f)'
  end as case_,
  flagged,
  coalesce(flag_reason, '—') as reason
from runs
where user_id = 'cccccccc-0000-4000-8000-000000000003'
order by id;

drop function _mkpath(int, float8, float8);
rollback;

-- PASS = f, t, t, f.
-- Case 4 flagging is the failure that matters most: it would mean privacy
-- masking makes honest runners look like cheaters.

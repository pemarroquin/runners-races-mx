-- Move PostGIS from `public` to `extensions`.
--
-- WHY. Supabase alert (2026-10-31): `rls_disabled_in_public` on
-- public.spatial_ref_sys. That table is PostGIS's catalogue of coordinate
-- systems, owned by supabase_admin, and anon/authenticated hold ALL on it
-- (granted by supabase_admin, so `postgres` cannot revoke it — tried
-- 2026-11-03, see 20260909120000_spatial_ref_sys_lockdown.sql). A stranger
-- with the publishable key could read it and DELETE rows, including SRID 4326,
-- which every geography calculation on `runs` depends on. `extensions` is not
-- an exposed API schema (PGRST106), so moving PostGIS there takes the table
-- — and PostGIS's ~500 functions — out of the API for good.
--
-- WHY NOT `ALTER EXTENSION postgis SET SCHEMA`. PostGIS 3 is not relocatable
-- (extrelocatable = false) and `postgres` is not superuser here. So: save the
-- only PostGIS-typed data (runs.fence, as EWKT text), drop and re-create the
-- extension, put the data back.
--
-- WHAT DROP ... CASCADE REMOVES (measured 2026-11-03): the column runs.fence
-- and its index runs_fence_gix. Nothing else: no view, constraint or policy
-- uses fence. The three trigger functions that use ST_* are plpgsql, so they
-- survive the drop; they resolve ST_* and the geometry type at RUN time via
-- search_path, which is why step 5 pins it.
--
-- TRIGGERS ARE LEFT ALONE. runs_flag_speed, runs_validate_fence and
-- runs_apply_overlap are all INSERT-only; the restore below is an UPDATE.
--
-- Plan, tests and rollback:
-- Source Data/Outputs/Running App/PostGIS Schema Move — Plan (2026-11-03).md
-- Verify AFTER applying: `node scripts/verify-postgis-move.mjs`.
-- Applying is not verifying.

begin;

-- 1. Save every fence as text, in a schema the API does not serve.
--    ("Automatically expose new tables" is ON for this project: a backup in
--    `public` would be readable by anon. It holds location data.)
create schema if not exists postgis_move_backup;
revoke all on schema postgis_move_backup from public, anon, authenticated;

create table postgis_move_backup.runs_fence as
  select id, public.st_asewkt(fence) as ewkt
  from public.runs
  where fence is not null;

do $$
declare
  saved int;
  expected int;
begin
  select count(*) into saved from postgis_move_backup.runs_fence;
  select count(*) into expected from public.runs where fence is not null;
  if saved <> expected then
    raise exception 'fence backup incomplete: % of %', saved, expected;
  end if;
end;
$$;

-- 2. Move the extension. Removes runs.fence and runs_fence_gix.
drop extension postgis cascade;
create extension postgis with schema extensions;

-- 3. Put the column back, same type and SRID as before (position changes:
--    it moves to the end; nothing in the app relies on column order).
alter table public.runs add column fence extensions.geometry(Geometry, 4326);

update public.runs r
set fence = extensions.st_geomfromewkt(b.ewkt)
from postgis_move_backup.runs_fence b
where b.id = r.id;

-- 4. Index, exactly as before.
create index runs_fence_gix on public.runs using gist (fence);

-- 5. Let the trigger functions find ST_* and the geometry type.
alter function public.apply_territory_overlap()     set search_path = public, extensions;
alter function public.validate_fence_matches_path() set search_path = public, extensions;
alter function public.flag_implausible_speed()      set search_path = public, extensions;

-- 6. Prove the data came back before committing.
do $$
declare
  restored int;
  mismatched int;
begin
  select count(*) into restored from public.runs where fence is not null;
  select count(*) into mismatched
    from postgis_move_backup.runs_fence b
    join public.runs r on r.id = b.id
    where extensions.st_asewkt(r.fence) is distinct from b.ewkt;
  if restored <> (select count(*) from postgis_move_backup.runs_fence) or mismatched > 0 then
    raise exception 'fence restore failed: % restored, % mismatched', restored, mismatched;
  end if;
end;
$$;

commit;

-- The backup schema stays until the phone test passes. Then:
--   drop schema postgis_move_backup cascade;

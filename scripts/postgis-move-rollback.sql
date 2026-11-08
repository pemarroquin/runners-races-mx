-- ROLLBACK for 20261104120000_postgis_to_extensions.sql — puts PostGIS back
-- in `public`. NOT a migration (it lives in scripts/ so `db push` never runs
-- it). Use only if a check fails after the move:
--   npx supabase db query --linked -f scripts/postgis-move-rollback.sql
-- Saves the CURRENT fences (so runs uploaded after the move are kept), not
-- the pre-move backup. Rehearsed on a local copy 2026-11-03.
begin;

create schema if not exists postgis_move_backup;
revoke all on schema postgis_move_backup from public, anon, authenticated;
drop table if exists postgis_move_backup.runs_fence_rollback;
create table postgis_move_backup.runs_fence_rollback as
  select id, extensions.st_asewkt(fence) as ewkt from public.runs where fence is not null;

drop extension postgis cascade;
create extension postgis with schema public;

alter table public.runs add column fence public.geometry(Geometry, 4326);
update public.runs r set fence = public.st_geomfromewkt(b.ewkt)
  from postgis_move_backup.runs_fence_rollback b where b.id = r.id;
create index runs_fence_gix on public.runs using gist (fence);

-- Search paths exactly as they were before the move.
alter function public.apply_territory_overlap()     set search_path = public;
alter function public.validate_fence_matches_path() reset search_path;
alter function public.flag_implausible_speed()      reset search_path;

do $$
declare restored int; saved int; bad int;
begin
  select count(*) into saved from postgis_move_backup.runs_fence_rollback;
  select count(fence) into restored from public.runs;
  select count(*) into bad from postgis_move_backup.runs_fence_rollback b
    join public.runs r on r.id = b.id where public.st_asewkt(r.fence) is distinct from b.ewkt;
  if restored <> saved or bad > 0 then
    raise exception 'rollback restore failed: % of %, % mismatched', restored, saved, bad;
  end if;
end $$;

commit;

-- Delete run failed with 23503 for any run that claimed tiles: two foreign
-- keys to runs(id) had no ON DELETE action, so deleteRun reported 'network'.
--
--   tile_visits.run_id          -> CASCADE  (a visit belongs to its run)
--   territory_tiles.claim_run_id -> SET NULL (the tile stays with its owner;
--                                   only the provenance pointer is cleared)
--
-- Constraint names are looked up, not assumed: both were created inline.

do $$
declare
  c text;
begin
  select conname into c from pg_constraint
   where conrelid = 'public.tile_visits'::regclass and contype = 'f'
     and confrelid = 'public.runs'::regclass;
  if c is not null then
    execute format('alter table public.tile_visits drop constraint %I', c);
  end if;
  alter table public.tile_visits
    add constraint tile_visits_run_id_fkey
    foreign key (run_id) references public.runs(id) on delete cascade;

  select conname into c from pg_constraint
   where conrelid = 'public.territory_tiles'::regclass and contype = 'f'
     and confrelid = 'public.runs'::regclass;
  if c is not null then
    execute format('alter table public.territory_tiles drop constraint %I', c);
  end if;
  alter table public.territory_tiles
    add constraint territory_tiles_claim_run_id_fkey
    foreign key (claim_run_id) references public.runs(id) on delete set null;
end $$;

-- Verify after push (both rows should show the new action):
--   select conrelid::regclass, conname, confdeltype from pg_constraint
--    where confrelid = 'public.runs'::regclass;
--   -- 'c' = cascade, 'n' = set null

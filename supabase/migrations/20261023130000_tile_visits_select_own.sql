-- tile_visits: each runner reads only their own rows. STEP 2 OF 2.
--
-- APPLY ONLY AFTER 20261023120000 is applied AND the client that scores
-- Local Leaders through its functions is live on runningapp.pmarroquin.com.
-- Before that, the live board still reads other runners' visits directly
-- and this would blank it for everyone.
--
-- Supersedes draft PR #79 ("read authenticated"), which by its own account
-- was not a fix: anyone can mint an anonymous session. Both its policy and
-- the original read-all are dropped here, whichever is live.
--
-- Nothing server-side loses access: claim_run_tiles (invoker) only INSERTs
-- here with ON CONFLICT DO NOTHING, which needs no select policy; the
-- plausibility trigger counts the caller's OWN run; municipio_progress
-- filters on auth.uid(); the Local Leaders functions are security definer
-- and read run_ground, not this table. Client reads left after the switch
-- are all own-rows: fetchMyVisitedCells, reclaimUnclaimedRuns,
-- recordMissingGround.
--
-- Rollback (restores the exposure; only if a board is broken):
--   drop policy "tile_visits: select own" on public.tile_visits;
--   create policy "tile_visits: read all" on public.tile_visits for select using (true);

drop policy if exists "tile_visits: read all" on public.tile_visits;
drop policy if exists "tile_visits: read authenticated" on public.tile_visits;
drop policy if exists "tile_visits: select own" on public.tile_visits;
create policy "tile_visits: select own" on public.tile_visits
  for select using (auth.uid() = user_id);

-- VERIFY (applying is not verifying):
--   select policyname, cmd, qual from pg_policies where tablename = 'tile_visits';
--   -- expect exactly: "tile_visits: insert own" (INSERT) and
--   --                 "tile_visits: select own" (SELECT, (auth.uid() = user_id))
-- Then live, with the publishable key:
--   no session:        GET /rest/v1/tile_visits?select=user_id&limit=5 -> []
--   fresh anonymous:   POST /auth/v1/signup {} -> token; same GET with
--                      Authorization: Bearer <token>              -> []
--   (scripts/verify-tile-visits-closed.mjs does both.)

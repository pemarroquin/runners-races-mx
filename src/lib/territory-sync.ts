// Uploads a finished run to Supabase. Everything here is best-effort: this
// app has worked offline-first from day one (races.ts falls back to the
// bundled seed, saved.tsx tolerates blocked storage), and a run the runner
// just finished must never be lost to a dead network — so a failed upload
// is reported to the caller as a value, never thrown, and the run stays on
// screen for a manual retry.
import { ensureSession, supabase, TERRITORY_ENABLED } from '@/lib/supabase';
import { nearestRegion } from '@/lib/regions';
import type { FenceResult } from '@/lib/territory';
import type { TrackPoint } from '@/lib/tracking';

export interface RunUpload {
  points: TrackPoint[];
  fence: FenceResult;
  distanceM: number;
  startedAt: number;
  endedAt: number;
}

export type SyncOutcome =
  | { ok: true; runId: string }
  | { ok: false; reason: 'disabled' | 'auth' | 'network' };

/**
 * Inserts one run. Returns a discriminated outcome rather than a bare
 * boolean so the UI can say something true about *why* it failed — a
 * silent `catch {}` here would make "sync is off" and "sync broke" look
 * identical on screen, which is exactly the failure this codebase has been
 * bitten by before.
 */
export async function uploadRun(run: RunUpload): Promise<SyncOutcome> {
  if (!TERRITORY_ENABLED) return { ok: false, reason: 'disabled' };

  const session = await ensureSession();
  if (!session) return { ok: false, reason: 'auth' };

  const first = run.points[0];
  const region = first ? nearestRegion(first.lat, first.lng)?.id ?? null : null;

  try {
    // The profile row is what `runs.user_id` references, and an anonymous
    // user has none until we make one — upsert (not insert) because the
    // second run from the same device would otherwise collide on the PK.
    const { error: profileError } = await supabase
      .from('profiles')
      .upsert({ id: session.user.id }, { onConflict: 'id' });
    if (profileError) return { ok: false, reason: 'network' };

    const { data, error } = await supabase
      .from('runs')
      .insert({
        user_id: session.user.id,
        region,
        started_at: new Date(run.startedAt).toISOString(),
        ended_at: new Date(run.endedAt).toISOString(),
        distance_m: Math.round(run.distanceM),
        duration_s: Math.round((run.endedAt - run.startedAt) / 1000),
        raw_path: run.points.map((p) => [p.lat, p.lng, p.ts]),
        // PostGIS accepts GeoJSON geometry as text for a geometry column.
        fence: JSON.stringify(run.fence.geometry.geometry),
        area_m2: Math.round(run.fence.areaM2),
      })
      .select('id')
      .single();

    if (error || !data) return { ok: false, reason: 'network' };
    return { ok: true, runId: data.id };
  } catch {
    return { ok: false, reason: 'network' };
  }
}

// Uploads a finished run to Supabase. Everything here is best-effort: this
// app has worked offline-first from day one (races.ts falls back to the
// bundled seed, saved.tsx tolerates blocked storage), and a run the runner
// just finished must never be lost to a dead network — so a failed upload
// is reported to the caller as a value, never thrown, and the run stays on
// screen for a manual retry.
import type { MultiPolygon, Polygon } from 'geojson';

import { ensureSession, supabase, TERRITORY_ENABLED } from '@/lib/supabase';
import type { LeaderboardRun } from '@/lib/leaderboard';
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

/** One previously-captured fence, ready to draw. */
export interface MyFence {
  id: string;
  /** Epoch ms of the run's start — feeds fenceColorForRun, so the fence
   *  renders in the same colour set everywhere. */
  startedAtMs: number;
  geometry: Polygon | MultiPolygon;
  areaM2: number;
  distanceM: number;
}

export type FencesOutcome =
  | { ok: true; fences: MyFence[]; skipped: number }
  | { ok: false; reason: 'disabled' | 'auth' | 'network' };

/**
 * PostGIS ≥3 registers geometry→json casts, so PostgREST serialises the
 * `fence` column as a GeoJSON object. Verified defensively rather than
 * trusted: anything that isn't a usable (Multi)Polygon object is skipped AND
 * counted, so a serialisation surprise shows up as `skipped > 0` instead of
 * as a silently empty map.
 */
function parseFenceGeometry(value: unknown): Polygon | MultiPolygon | null {
  // Older PostgREST/PostGIS combinations return geometry as a string (WKB
  // hex, or GeoJSON text); the JSON-text case is recoverable.
  if (typeof value === 'string' && value.startsWith('{')) {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (typeof value !== 'object' || value === null) return null;
  const g = value as { type?: unknown; coordinates?: unknown };
  if ((g.type === 'Polygon' || g.type === 'MultiPolygon') && Array.isArray(g.coordinates)) {
    return g as unknown as Polygon | MultiPolygon;
  }
  return null;
}

/**
 * Every fence this device's (anonymous) identity has captured, newest first.
 * Same outcome-as-value contract as uploadRun, and for the same reason: the
 * callers render "why" (disabled/auth/network), never a bare empty list that
 * could mean anything.
 */
export async function fetchMyFences(): Promise<FencesOutcome> {
  if (!TERRITORY_ENABLED) return { ok: false, reason: 'disabled' };

  const session = await ensureSession();
  if (!session) return { ok: false, reason: 'auth' };

  try {
    const { data, error } = await supabase
      .from('runs')
      .select('id, started_at, distance_m, area_m2, fence')
      .eq('user_id', session.user.id)
      .order('started_at', { ascending: false });

    if (error || !data) return { ok: false, reason: 'network' };

    const fences: MyFence[] = [];
    let skipped = 0;
    for (const row of data) {
      const geometry = parseFenceGeometry(row.fence);
      const startedAtMs = Date.parse(row.started_at);
      if (!geometry || Number.isNaN(startedAtMs)) {
        skipped++;
        continue;
      }
      fences.push({
        id: row.id,
        startedAtMs,
        geometry,
        areaM2: Number(row.area_m2) || 0,
        distanceM: Number(row.distance_m) || 0,
      });
    }
    return { ok: true, fences, skipped };
  } catch {
    return { ok: false, reason: 'network' };
  }
}

export type LeaderboardOutcome =
  | { ok: true; runs: LeaderboardRun[]; meUserId: string; skipped: number }
  | { ok: false; reason: 'disabled' | 'auth' | 'network' };

/**
 * Every run's fence + owner, for the leaderboard to aggregate on device (see
 * leaderboard.ts for why the union happens here rather than in SQL).
 *
 * `runs: read all` and `profiles: read all` are both open policies, so this
 * legitimately returns other people's fences — that is the feature. The
 * caller's own id comes back too, so a row can be marked as yours without a
 * second round-trip.
 */
export async function fetchLeaderboard(): Promise<LeaderboardOutcome> {
  if (!TERRITORY_ENABLED) return { ok: false, reason: 'disabled' };

  const session = await ensureSession();
  if (!session) return { ok: false, reason: 'auth' };

  try {
    // The embedded profile comes from runs.user_id's FK to profiles.id.
    // PostgREST returns it as an object (or null if the row is missing).
    const { data, error } = await supabase
      .from('runs')
      .select('user_id, region, fence, profiles(display_name)');

    if (error || !data) return { ok: false, reason: 'network' };

    const runs: LeaderboardRun[] = [];
    let skipped = 0;
    for (const row of data) {
      const geometry = parseFenceGeometry(row.fence);
      if (!geometry) {
        skipped++;
        continue;
      }
      // Depending on how PostgREST infers the relationship this arrives as
      // an object or a one-element array; normalise rather than trusting one.
      const profile = Array.isArray(row.profiles) ? row.profiles[0] : row.profiles;
      runs.push({
        userId: row.user_id,
        displayName: profile?.display_name ?? null,
        region: row.region ?? null,
        geometry,
      });
    }
    return { ok: true, runs, meUserId: session.user.id, skipped };
  } catch {
    return { ok: false, reason: 'network' };
  }
}

export type ProfileOutcome =
  | { ok: true; displayName: string | null }
  | { ok: false; reason: 'disabled' | 'auth' | 'network' };

/** This device's own profile row (anonymous identity — see supabase.ts). */
export async function fetchMyProfile(): Promise<ProfileOutcome> {
  if (!TERRITORY_ENABLED) return { ok: false, reason: 'disabled' };

  const session = await ensureSession();
  if (!session) return { ok: false, reason: 'auth' };

  try {
    const { data, error } = await supabase
      .from('profiles')
      .select('display_name')
      .eq('id', session.user.id)
      .maybeSingle();

    // maybeSingle, not single: the profile row is only created on the first
    // run upload, so "no row yet" is the normal state for a new install and
    // must not read as an error.
    if (error) return { ok: false, reason: 'network' };
    return { ok: true, displayName: data?.display_name ?? null };
  } catch {
    return { ok: false, reason: 'network' };
  }
}

/** Longer names get truncated in every row that renders them; cap at the
 *  source so what's stored is what's shown. */
export const DISPLAY_NAME_MAX = 24;

/**
 * Sets the name shown on the leaderboard. Upserts because a runner may pick
 * a name before ever finishing a run, i.e. before uploadRun has created the
 * profile row.
 */
export async function updateDisplayName(name: string): Promise<ProfileOutcome> {
  if (!TERRITORY_ENABLED) return { ok: false, reason: 'disabled' };

  const session = await ensureSession();
  if (!session) return { ok: false, reason: 'auth' };

  const trimmed = name.trim().slice(0, DISPLAY_NAME_MAX);
  // An empty string would render as a nameless row; store a real null so
  // the UI's "anonymous" fallback is the single code path for "no name".
  const value = trimmed.length > 0 ? trimmed : null;

  try {
    const { error } = await supabase
      .from('profiles')
      .upsert({ id: session.user.id, display_name: value }, { onConflict: 'id' });
    if (error) return { ok: false, reason: 'network' };
    return { ok: true, displayName: value };
  } catch {
    return { ok: false, reason: 'network' };
  }
}

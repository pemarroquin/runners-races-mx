// Uploads a finished run to Supabase. Everything here is best-effort: this
// app has worked offline-first from day one (races.ts falls back to the
// bundled seed, saved.tsx tolerates blocked storage), and a run the runner
// just finished must never be lost to a dead network — so a failed upload
// is reported to the caller as a value, never thrown, and the run stays on
// screen for a manual retry.
import type { MultiPolygon, Polygon } from 'geojson';
import type { Session } from '@supabase/supabase-js';

import { ensureSession, supabase, TERRITORY_ENABLED } from '@/lib/supabase';
import type { LeaderboardRun } from '@/lib/leaderboard';
import { nearestRegion } from '@/lib/regions';
import type { FenceResult, LatLng } from '@/lib/territory';
import type { TrackPoint } from '@/lib/tracking';

/** Every outcome type below is this same shape with a different `ok: true`
 *  payload — `{ ok: true, ...payload } | { ok: false, reason: ... }`. */
type Outcome<T> = ({ ok: true } & T) | { ok: false; reason: 'disabled' | 'auth' | 'network' };

/**
 * Every exported function in this file opened with the identical
 * TERRITORY_ENABLED / ensureSession guard, then wrapped its Supabase calls in
 * a try/catch that folded any thrown error into `{ reason: 'network' }` —
 * six copies of the same skeleton (2026-09-01 review finding). Factored here
 * so the failure taxonomy lives in exactly one place: the next sync function
 * — or a fix to this one, e.g. a future 'maintenance' reason — only has to
 * change this function, not remember to touch every call site by hand.
 *
 * `fn` still owns its own internal errors (a `{ ok: false, reason: 'network' }`
 * for a specific failed step, same as before) — this only removes the
 * boilerplate that was IDENTICAL across every caller.
 */
async function withSession<T>(
  fn: (session: Session) => Promise<({ ok: true } & T) | { ok: false; reason: 'network' }>,
): Promise<Outcome<T>> {
  if (!TERRITORY_ENABLED) return { ok: false, reason: 'disabled' };

  const session = await ensureSession();
  if (!session) return { ok: false, reason: 'auth' };

  try {
    return await fn(session);
  } catch {
    return { ok: false, reason: 'network' };
  }
}

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
  return withSession<{ runId: string }>(async (session) => {
    const first = run.points[0];
    const region = first ? nearestRegion(first.lat, first.lng)?.id ?? null : null;

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
  });
}

/** One previously-captured fence, ready to draw. */
export interface MyFence {
  id: string;
  /** Epoch ms of the run's start — feeds fenceColorForRun, so the fence
   *  renders in the same colour set everywhere. */
  startedAtMs: number;
  /**
   * Null when the run has been FULLY taken by other runners — Phase 3's
   * trigger nulls the fence and zeroes the area rather than deleting the
   * row, because it is still history ("this run happened, then it was
   * overtaken"). Distinct from a parse failure: the row is intact and
   * correct, there is simply no ground left to draw.
   */
  geometry: Polygon | MultiPolygon | null;
  /**
   * The actual recorded path (already privacy-masked at upload — see
   * parseRawPath), for drawing the run's real route rather than the fence
   * polygon's boundary (the bug `1df2ae6` fixed for the summary map, here
   * for the Saved tab). Null whenever `raw_path` is missing or unparseable —
   * a card with a good fence but no route still renders, just without the
   * route line; this must NOT bump `skipped`, same defensive posture as the
   * null-fence case below.
   */
  route: LatLng[] | null;
  areaM2: number;
  distanceM: number;
  /** m² other runners have carved out of this run since it was saved. */
  lostM2: number;
  /** Set by the server-side speed trigger. A flagged run still counts and
   *  still holds territory — it is marked, not punished. Never treat it as
   *  proof of cheating; see 20260827_anti_cheat_flag.sql. */
  flagged: boolean;
  /** Which check tripped ('speed:claimed' | 'speed:path' | 'speed:segment'),
   *  so the UI can say what was implausible rather than showing a bare
   *  warning. */
  flagReason: string | null;
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
 * `raw_path` is written on upload as `run.points.map((p) => [p.lat, p.lng,
 * p.ts])` (see uploadRun above) — already privacy-masked by then
 * (privacy-zone.ts trims the start/end before it ever reaches uploadRun), so
 * there is nothing left to mask here, only to parse back defensively.
 * PostgREST serialises a `jsonb` column as a real JSON value, so this is
 * ordinarily an array already; the string branch covers the same
 * older-stack case parseFenceGeometry guards against. Anything that isn't a
 * clean array of `[lat, lng, ts]` triples returns null rather than throwing
 * or drawing a corrupted line.
 */
export function parseRawPath(value: unknown): LatLng[] | null {
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(value)) return null;

  const points: LatLng[] = [];
  for (const entry of value) {
    if (!Array.isArray(entry) || entry.length < 2) return null;
    const [lat, lng] = entry;
    if (typeof lat !== 'number' || typeof lng !== 'number') return null;
    points.push({ lat, lng });
  }
  return points;
}

/**
 * Every fence this device's (anonymous) identity has captured, newest first.
 * Same outcome-as-value contract as uploadRun, and for the same reason: the
 * callers render "why" (disabled/auth/network), never a bare empty list that
 * could mean anything.
 */
export async function fetchMyFences(): Promise<FencesOutcome> {
  return withSession<{ fences: MyFence[]; skipped: number }>(async (session) => {
    const { data, error } = await supabase
      .from('runs')
      .select('id, started_at, distance_m, area_m2, fence, raw_path, flagged, flag_reason')
      .eq('user_id', session.user.id)
      .order('started_at', { ascending: false });

    if (error || !data) return { ok: false, reason: 'network' };

    const fences: MyFence[] = [];
    let skipped = 0;
    for (const row of data) {
      const startedAtMs = Date.parse(row.started_at);
      // A NULL fence is a fully-overtaken run, which is real history and
      // must be kept. Only a fence that is present but unreadable, or an
      // unparseable timestamp, counts as skipped — conflating the two made
      // Phase 3's own outcome look like corrupt data.
      const geometry = row.fence === null ? null : parseFenceGeometry(row.fence);
      if (Number.isNaN(startedAtMs) || (row.fence !== null && geometry === null)) {
        skipped++;
        continue;
      }
      // A bad/missing raw_path is common (older rows predate this feature)
      // and must not count toward `skipped` — that field means "fence
      // present but unreadable, or a bad timestamp," not "no route line."
      const route = parseRawPath(row.raw_path);
      fences.push({
        id: row.id,
        startedAtMs,
        geometry,
        route,
        areaM2: Number(row.area_m2) || 0,
        distanceM: Number(row.distance_m) || 0,
        lostM2: 0, // filled in below
        flagged: row.flagged === true,
        flagReason: row.flag_reason ?? null,
      });
    }

    // How much ground each of these runs has lost to other runners. One
    // extra query rather than a join: the embed would need the FK
    // constraint's generated name, which is brittle to rename.
    if (fences.length > 0) {
      const { data: events } = await supabase
        .from('territory_events')
        .select('loser_run_id, area_taken_m2')
        .in(
          'loser_run_id',
          fences.map((f) => f.id),
        );
      if (events) {
        const lostByRun = new Map<string, number>();
        for (const e of events) {
          lostByRun.set(
            e.loser_run_id,
            (lostByRun.get(e.loser_run_id) ?? 0) + (Number(e.area_taken_m2) || 0),
          );
        }
        for (const fence of fences) fence.lostM2 = lostByRun.get(fence.id) ?? 0;
      }
      // A failure here leaves lostM2 at 0 rather than failing the whole
      // fetch: the fences themselves are the point, the loss annotation is
      // a garnish.
    }

    return { ok: true, fences, skipped };
  });
}

/** What one run took from other runners — Phase 3's payoff, read back after
 *  the upload so the summary can report it. */
export interface RunSpoils {
  areaTakenM2: number;
  /** Distinct runners who lost ground, not runs — losing 3 fences to one
   *  person reads as one rivalry, not three. */
  runnersAffected: number;
  runsAffected: number;
}

export type SpoilsOutcome =
  | { ok: true; spoils: RunSpoils }
  | { ok: false; reason: 'disabled' | 'auth' | 'network' };

/**
 * Territory this run carved out of other runners' fences.
 *
 * Reads `territory_events`, which ONLY the Phase 3 trigger writes — so an
 * empty result is the honest "you overlapped nobody", not a missing feature.
 * Safe to call before the trigger migration is applied: the table exists
 * from Phase 1 and simply stays empty.
 */
export async function fetchRunSpoils(runId: string): Promise<SpoilsOutcome> {
  return withSession<{ spoils: RunSpoils }>(async () => {
    const { data: events, error } = await supabase
      .from('territory_events')
      .select('loser_run_id, area_taken_m2')
      .eq('winner_run_id', runId);

    if (error || !events) return { ok: false, reason: 'network' };
    if (events.length === 0) {
      return { ok: true, spoils: { areaTakenM2: 0, runnersAffected: 0, runsAffected: 0 } };
    }

    const areaTakenM2 = events.reduce((sum, e) => sum + (Number(e.area_taken_m2) || 0), 0);
    const loserRunIds = events.map((e) => e.loser_run_id);

    // Second hop to turn runs into people. If it fails, fall back to the
    // run count rather than reporting 0 runners against a real area — a
    // number that contradicts itself is worse than a coarse one.
    const { data: losers } = await supabase
      .from('runs')
      .select('user_id')
      .in('id', loserRunIds);

    const runnersAffected = losers
      ? new Set(losers.map((r) => r.user_id)).size
      : loserRunIds.length;

    return {
      ok: true,
      spoils: { areaTakenM2, runnersAffected, runsAffected: events.length },
    };
  });
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
  return withSession<{ runs: LeaderboardRun[]; meUserId: string; skipped: number }>(async (session) => {
    // The embedded profile comes from runs.user_id's FK to profiles.id.
    // PostgREST returns it as an object (or null if the row is missing).
    const { data, error } = await supabase
      .from('runs')
      .select('user_id, region, fence, flagged, profiles(display_name)');

    if (error || !data) return { ok: false, reason: 'network' };

    const runs: LeaderboardRun[] = [];
    let skipped = 0;
    for (const row of data) {
      // A NULL fence means Phase 3 fully took this run's ground. It holds
      // nothing, so it correctly contributes nothing to the ranking — but
      // it is not corrupt, so it must not inflate `skipped`, which exists
      // to surface real parse failures.
      if (row.fence === null) continue;
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
        flagged: row.flagged === true,
      });
    }
    return { ok: true, runs, meUserId: session.user.id, skipped };
  });
}

export type ProfileOutcome =
  | { ok: true; displayName: string | null }
  | { ok: false; reason: 'disabled' | 'auth' | 'network' };

/** This device's own profile row (anonymous identity — see supabase.ts). */
export async function fetchMyProfile(): Promise<ProfileOutcome> {
  return withSession<{ displayName: string | null }>(async (session) => {
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
  });
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
  return withSession<{ displayName: string | null }>(async (session) => {
    const trimmed = name.trim().slice(0, DISPLAY_NAME_MAX);
    // An empty string would render as a nameless row; store a real null so
    // the UI's "anonymous" fallback is the single code path for "no name".
    const value = trimmed.length > 0 ? trimmed : null;

    const { error } = await supabase
      .from('profiles')
      .upsert({ id: session.user.id, display_name: value }, { onConflict: 'id' });
    if (error) return { ok: false, reason: 'network' };
    return { ok: true, displayName: value };
  });
}

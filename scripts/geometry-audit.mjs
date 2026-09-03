#!/usr/bin/env node
// Geometry measurement harness — re-runs this repo's OWN pure geometry
// (src/lib/territory.ts's buildFence/pathDistanceM, src/lib/tiles.ts's
// pathToTiles) against the runs actually saved in Supabase, and reports
// where the recomputation disagrees with what got stored. Built to answer
// (with real data, not synthesis) the open questions in
// `Source Data/Outputs/Running App/BACKLOG.md`: does the distance-delta
// STEP line up with a gap in the fix stream, and do the two bridge caps
// behave sanely on genuine runs.
//
// READ-ONLY. This script issues nothing but `.select()` calls against the
// `runs` table via the public anon key. It does not insert, update, delete,
// upsert, call any writing RPC, or touch migrations. It is safe to run
// against production as many times as useful.
//
// Mirrors src/lib/territory.ts and src/lib/tiles.ts rather than importing
// them: same reasoning as scripts/tiles-preview.mjs's own header — this is
// a plain Node script, CI runs Node 20 (.github/workflows/*.yml), and Node
// 20 has no TypeScript type-stripping (that landed unflagged only in Node
// 23.6+). Importing the .ts files directly would work locally on a newer
// Node but silently break in CI. The underlying math packages (@turf/*,
// h3-js) ARE imported for real — only the TS wrapper functions are
// reproduced by hand. Keep the mirrored constants/logic in sync with the
// source files if either changes; both are pasted in below with a pointer
// back to their origin.
//
// Usage (run from the repo root):
//   node scripts/geometry-audit.mjs [output.json]
//
// Reads EXPO_PUBLIC_SUPABASE_URL / EXPO_PUBLIC_SUPABASE_ANON_KEY from
// .env.local in the repo root (same file the app itself uses — see
// scripts/check-web-env.mjs's header for the vars list). NEVER logs,
// prints, or writes those values anywhere; only already-exported
// process.env vars are used as a fallback (e.g. in a CI context), and only
// their PRESENCE is ever printed, never their content.
//
// Writes a full machine-readable report to output.json (default
// geometry-audit-report.json, NOT committed — it can contain saved runners'
// raw GPS paths, which is not something to check into a public repo) and
// prints a human summary to stdout.

import { readFileSync, writeFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import area from '@turf/area';
import { polygon } from '@turf/helpers';
import kinks from '@turf/kinks';
import simplify from '@turf/simplify';
import union from '@turf/union';
import unkinkPolygon from '@turf/unkink-polygon';
import { gridPathCells, latLngToCell } from 'h3-js';

// ============================================================================
// Mirrored from src/lib/territory.ts — DO NOT diverge without a reason.
// ============================================================================

const EARTH_RADIUS_M = 6371008.8; // mean radius, matches @turf/area
const DEFAULT_TOLERANCE_DEG = 0.00003; // territory.ts's DEFAULT_TOLERANCE_DEG
const MIN_FENCE_POINTS = 3; // territory.ts's MIN_FENCE_POINTS

function haversineM(a, b) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

function pathDistanceM(points) {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += haversineM(points[i - 1], points[i]);
  return total;
}

function toLngLat(points) {
  return points.map((p) => [p.lng, p.lat]);
}

function dedupeConsecutive(coords) {
  const out = [];
  for (const c of coords) {
    const prev = out[out.length - 1];
    if (!prev || prev[0] !== c[0] || prev[1] !== c[1]) out.push(c);
  }
  return out;
}

function closeRing(coords) {
  if (coords.length === 0) return coords;
  const first = coords[0];
  const last = coords[coords.length - 1];
  if (first[0] === last[0] && first[1] === last[1]) return coords;
  return [...coords, first];
}

function cleanPolygon(raw) {
  const intersections = kinks(raw);
  if (intersections.features.length === 0) return { geometry: raw, selfIntersected: false };

  const pieces = unkinkPolygon(raw);
  if (pieces.features.length === 0) return { geometry: raw, selfIntersected: true };
  if (pieces.features.length === 1) return { geometry: pieces.features[0], selfIntersected: true, lobes: 1 };

  const merged = union(pieces);
  return { geometry: merged ?? pieces.features[0], selfIntersected: true, lobes: pieces.features.length };
}

/** Mirrors territory.ts's buildFence(). Returns null (with a reason) exactly
 *  where the real implementation would, plus a few extra diagnostics
 *  (self-intersection, lobe count, point counts before/after simplify) the
 *  real function doesn't expose but this audit wants. */
function buildFence(path, toleranceDeg = DEFAULT_TOLERANCE_DEG) {
  const rawRing = closeRing(toLngLat(path));
  const ring = dedupeConsecutive(rawRing);
  if (ring.length < MIN_FENCE_POINTS + 1) {
    return { fence: null, reason: 'too_few_points', pointsBeforeSimplify: ring.length };
  }
  try {
    const raw = polygon([ring]);
    const simplified = simplify(raw, { tolerance: toleranceDeg, highQuality: true });
    const simplifiedRing = simplified.geometry.coordinates[0];
    if (!simplifiedRing || dedupeConsecutive(simplifiedRing).length < MIN_FENCE_POINTS + 1) {
      return {
        fence: null,
        reason: 'collapsed_by_simplify',
        pointsBeforeSimplify: ring.length,
        pointsAfterSimplify: simplifiedRing?.length ?? 0,
      };
    }
    const { geometry: cleaned, selfIntersected, lobes } = cleanPolygon(simplified);
    const areaM2 = area(cleaned);
    if (!Number.isFinite(areaM2) || areaM2 <= 0) {
      return { fence: null, reason: 'zero_or_invalid_area', pointsBeforeSimplify: ring.length };
    }
    return {
      fence: cleaned,
      areaM2,
      selfIntersected,
      lobes: lobes ?? 1,
      pointsBeforeSimplify: ring.length,
      pointsAfterSimplify: dedupeConsecutive(simplifiedRing).length,
    };
  } catch (e) {
    return { fence: null, reason: 'threw', error: e?.message ?? String(e), pointsBeforeSimplify: ring.length };
  }
}

// ============================================================================
// Mirrored from src/lib/tiles.ts — DO NOT diverge without a reason.
// ============================================================================

const DEFAULT_TILE_RES = 11; // tiles.ts's DEFAULT_TILE_RES
// tiles.ts's MAX_BRIDGE_SPEED_MS — reused from the server's own anti-cheat
// flag (25 km/h), see that file's comment for the full reasoning.
const MAX_BRIDGE_SPEED_MS = (25 * 1000) / 3600; // ≈ 6.94 m/s
// tiles.ts's MAX_BRIDGE_DISTANCE_M.
const MAX_BRIDGE_DISTANCE_M = 150;

/** Mirrors tiles.ts's pathToTiles(). */
function pathToTiles(path, res = DEFAULT_TILE_RES) {
  const direct = new Set();
  const gapFilled = new Set();
  let bridgeFailures = 0;
  let bridgesSkippedSpeed = 0;
  let bridgesSkippedDistance = 0;
  let prevCell = null;
  let prevPoint = null;
  const skippedSpeedGaps = [];
  const skippedDistanceGaps = [];

  for (const p of path) {
    const cell = latLngToCell(p.lat, p.lng, res);
    direct.add(cell);

    if (prevCell !== null && prevCell !== cell && prevPoint !== null) {
      const dtS = (p.ts - prevPoint.ts) / 1000;
      const distM = haversineM(prevPoint, p);
      const impliedSpeedMs = dtS > 0 ? distM / dtS : Infinity;

      if (impliedSpeedMs > MAX_BRIDGE_SPEED_MS) {
        bridgesSkippedSpeed += 1;
        skippedSpeedGaps.push({ dtS, distM, impliedSpeedMs, atTs: prevPoint.ts });
      } else if (distM > MAX_BRIDGE_DISTANCE_M) {
        bridgesSkippedDistance += 1;
        skippedDistanceGaps.push({ dtS, distM, impliedSpeedMs, atTs: prevPoint.ts });
      } else {
        try {
          const line = gridPathCells(prevCell, cell);
          for (const c of line) gapFilled.add(c);
        } catch {
          bridgeFailures += 1;
        }
      }
    }
    prevCell = cell;
    prevPoint = p;
  }

  for (const c of direct) gapFilled.delete(c);

  return {
    cells: [...direct, ...gapFilled],
    directCount: direct.size,
    gapFilledCount: gapFilled.size,
    bridgeFailures,
    bridgesSkippedSpeed,
    bridgesSkippedDistance,
    skippedSpeedGaps,
    skippedDistanceGaps,
  };
}

// ============================================================================
// Env loading — .env.local only, values never logged.
// ============================================================================

function loadEnvLocal(path) {
  const out = {};
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return out;
  }
  for (const line of raw.split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let val = m[2];
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[m[1]] = val;
  }
  return out;
}

const fileEnv = loadEnvLocal('.env.local');
const SUPABASE_URL = fileEnv.EXPO_PUBLIC_SUPABASE_URL ?? process.env.EXPO_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = fileEnv.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error(
    '[geometry-audit] Missing EXPO_PUBLIC_SUPABASE_URL / EXPO_PUBLIC_SUPABASE_ANON_KEY.\n' +
      '  Put them in .env.local at the repo root (same file the app reads), or export them\n' +
      '  in the environment before running this script. Values are never printed.',
  );
  process.exit(1);
}
console.log('[geometry-audit] Supabase URL present: yes. Anon key present: yes. (values not logged)');

// ============================================================================
// Fetch — READ ONLY. Every call below is a .select(); nothing writes.
// ============================================================================

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const { data: runs, error, count } = await supabase
  .from('runs')
  .select(
    'id, user_id, region, started_at, ended_at, distance_m, duration_s, raw_path, fence, area_m2, flagged, flag_reason, created_at',
    { count: 'exact' },
  )
  .order('created_at', { ascending: true });

if (error) {
  console.error('[geometry-audit] Supabase query failed:', error.message);
  console.error(
    '  (This is the ONLY network call this script makes besides an anon sign-in the client\n' +
      "   library may do implicitly. If this is an RLS/policy error, that's a finding — the\n" +
      '   `runs: read all` policy in the Phase 1 migration should permit this select.)',
  );
  process.exit(1);
}

console.log(`[geometry-audit] Fetched ${runs.length} row(s) from \`runs\` (table count: ${count}).`);

if (runs.length === 0) {
  console.log(
    '[geometry-audit] No saved runs exist yet. HONEST SAMPLE SIZE: 0. Nothing below can be\n' +
      '  measured — this script refuses to fabricate findings from an empty table. Re-run\n' +
      '  after at least one real run has been saved.',
  );
  writeFileSync(
    process.argv[2] ?? 'geometry-audit-report.json',
    JSON.stringify({ generatedAt: new Date().toISOString(), sampleSize: 0, runs: [] }, null, 2),
  );
  process.exit(0);
}

// ============================================================================
// Per-run analysis.
// ============================================================================

// Heuristic only, NOT a claim about which gaps were real backgrounding
// events: tracking.ts's visibilitychange handler is what actually decides
// that, on-device, and it is not persisted anywhere this script can read
// (gapCount/gapDurationMs are ephemeral React state — see tracking.ts;
// pilot-instrumentation.ts's counters are LOCAL device prefs, never
// uploaded). 10s is 5x the tracker's own 2s throttle (TIME_INTERVAL_MS in
// tracking.ts) — comfortably above ordinary GPS jitter, used here only to
// flag segments worth a human look.
const GAP_FLAG_THRESHOLD_S = 10;

function quantile(sorted, q) {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1))));
  return sorted[idx];
}

function analyzeRun(row) {
  const rawPath = row.raw_path;
  const malformed = !Array.isArray(rawPath) || rawPath.length === 0;
  if (malformed) {
    return { id: row.id, malformed: true, raw_path_type: typeof rawPath };
  }

  // Schema comment on `runs.raw_path`: "[[lat,lng,ts], ...] as recorded" —
  // confirmed against 3 live rows during this audit (2026-09-02), all
  // arrays of [lat, lng, ts_ms].
  const points = rawPath.map((p) => ({ lat: p[0], lng: p[1], ts: p[2] }));

  const n = points.length;
  const dts = [];
  const stepDists = [];
  const segments = [];
  for (let i = 1; i < n; i++) {
    const dtS = (points[i].ts - points[i - 1].ts) / 1000;
    const d = haversineM(points[i - 1], points[i]);
    dts.push(dtS);
    stepDists.push(d);
    segments.push({ i, dtS, distM: d, impliedSpeedMs: dtS > 0 ? d / dtS : Infinity });
  }
  const sortedDts = [...dts].sort((a, b) => a - b);
  const sortedDists = [...stepDists].sort((a, b) => a - b);

  const duplicateConsecutivePoints = segments.filter((s) => s.distM === 0).length;

  const gaps = segments.filter((s) => s.dtS > GAP_FLAG_THRESHOLD_S);
  const gapTotalM = gaps.reduce((sum, g) => sum + g.distM, 0);
  const gapTotalS = gaps.reduce((sum, g) => sum + g.dtS, 0);

  // --- distance: naive full recompute vs stored ---
  const recomputedDistanceM = pathDistanceM(points);
  const storedDistanceM = Number(row.distance_m);
  const distanceDeltaM = recomputedDistanceM - storedDistanceM;
  // What fraction of that delta the flagged gap segments alone account for.
  // territory-sync.ts writes distance_m = Math.round(tracking.ts's live
  // distanceM), and tracking.ts's visibilitychange handler nulls its `lastRef`
  // leg pointer on every backgrounding gap — the chord across a real gap is
  // deliberately EXCLUDED from the live distanceM total, even though both
  // endpoints still land in raw_path. A naive recompute over the whole path
  // (this function) has no such leg break, so it should overcount by
  // approximately the gap chords, on TOP of the small baseline
  // chord-sampling undercount (`recomputedDistanceM` still undercounts a
  // curve vs continuous ground truth, by design).
  // Deliberately UNCLIPPED — a ratio > 1 (gap chords bigger than the whole
  // delta) is itself the finding: it means the flagged gap(s) were NOT
  // excluded from the stored distance at all (the client's own leg-break
  // never fired for them, e.g. a slow-GPS stall that stayed on one
  // continuous leg rather than a backgrounding event), which is just as
  // informative as a ratio near 1 (the gap WAS excluded). Clipping this to
  // 100% would silently erase that distinction.
  const gapChordVsDeltaRatio = gapTotalM === 0 ? null : distanceDeltaM !== 0 ? gapTotalM / distanceDeltaM : Infinity;

  // --- fence: recompute vs stored ---
  const fenceResult = buildFence(points);
  const storedAreaM2 = row.area_m2 === null ? null : Number(row.area_m2);
  const storedHasFence = row.fence !== null;
  let fenceAreaDeltaM2 = null;
  let fenceAreaDeltaPct = null;
  if (fenceResult.fence && storedAreaM2 !== null) {
    fenceAreaDeltaM2 = fenceResult.areaM2 - storedAreaM2;
    fenceAreaDeltaPct = storedAreaM2 !== 0 ? (fenceAreaDeltaM2 / storedAreaM2) * 100 : null;
  }

  // --- tiles: recompute from raw_path ---
  const tiles = pathToTiles(points);
  const tileAreaM2Estimate = tiles.cells.length * 2150; // ~res-11 cell area, tiles.ts's own doc comment

  return {
    id: row.id,
    region: row.region,
    started_at: row.started_at,
    ended_at: row.ended_at,
    flagged: row.flagged ?? null,
    flag_reason: row.flag_reason ?? null,
    pointCount: n,
    duration_s_stored: row.duration_s,
    duration_s_fromTimestamps: n > 1 ? (points[n - 1].ts - points[0].ts) / 1000 : 0,
    sampling: {
      dtS_min: sortedDts[0] ?? null,
      dtS_median: quantile(sortedDts, 0.5),
      dtS_p90: quantile(sortedDts, 0.9),
      dtS_max: sortedDts[sortedDts.length - 1] ?? null,
      stepM_min: sortedDists[0] ?? null,
      stepM_median: quantile(sortedDists, 0.5),
      stepM_p90: quantile(sortedDists, 0.9),
      stepM_max: sortedDists[sortedDists.length - 1] ?? null,
      duplicateConsecutivePoints,
    },
    gaps: {
      thresholdS: GAP_FLAG_THRESHOLD_S,
      count: gaps.length,
      totalGapS: gapTotalS,
      totalGapChordM: gapTotalM,
      detail: gaps,
    },
    distance: {
      storedM: storedDistanceM,
      recomputedNaiveM: recomputedDistanceM,
      deltaM: distanceDeltaM,
      deltaPct: storedDistanceM !== 0 ? (distanceDeltaM / storedDistanceM) * 100 : null,
      // See gapChordVsDeltaRatio's own comment: near 1 means the flagged
      // gap(s) were excluded from the stored total (a real leg-break);
      // near 0 or undefined means they weren't (stored already counted
      // that stretch — no leg-break fired for it).
      gapChordVsDeltaRatio,
    },
    fence: {
      storedHasFence,
      storedAreaM2,
      recomputed: fenceResult,
      deltaM2: fenceAreaDeltaM2,
      deltaPct: fenceAreaDeltaPct,
    },
    tiles: {
      cellsClaimed: tiles.cells.length,
      directCount: tiles.directCount,
      gapFilledCount: tiles.gapFilledCount,
      bridgeFailures: tiles.bridgeFailures,
      bridgesSkippedSpeed: tiles.bridgesSkippedSpeed,
      bridgesSkippedDistance: tiles.bridgesSkippedDistance,
      skippedSpeedGaps: tiles.skippedSpeedGaps,
      skippedDistanceGaps: tiles.skippedDistanceGaps,
      tileAreaM2Estimate,
    },
  };
}

const analyses = runs.map(analyzeRun);

// ============================================================================
// Report.
// ============================================================================

console.log('');
console.log('='.repeat(78));
console.log(`GEOMETRY AUDIT — ${analyses.length} saved run(s), generated ${new Date().toISOString()}`);
console.log('='.repeat(78));

for (const a of analyses) {
  console.log('');
  console.log(`--- run ${a.id} (${a.region ?? 'unknown region'}, ${a.started_at}) ---`);
  if (a.malformed) {
    console.log(`  MALFORMED raw_path (type: ${a.raw_path_type}) — skipped.`);
    continue;
  }
  console.log(`  points: ${a.pointCount}  duplicate-consecutive: ${a.sampling.duplicateConsecutivePoints}`);
  console.log(
    `  dt(s): min ${a.sampling.dtS_min?.toFixed(2)} median ${a.sampling.dtS_median?.toFixed(2)} ` +
      `p90 ${a.sampling.dtS_p90?.toFixed(2)} max ${a.sampling.dtS_max?.toFixed(2)}`,
  );
  console.log(
    `  step(m): min ${a.sampling.stepM_min?.toFixed(2)} median ${a.sampling.stepM_median?.toFixed(2)} ` +
      `p90 ${a.sampling.stepM_p90?.toFixed(2)} max ${a.sampling.stepM_max?.toFixed(2)}`,
  );
  console.log(
    `  duration: stored ${a.duration_s_stored}s, from first/last timestamp ${a.duration_s_fromTimestamps.toFixed(1)}s`,
  );
  console.log(
    `  gaps > ${a.gaps.thresholdS}s: ${a.gaps.count} (total ${a.gaps.totalGapS.toFixed(1)}s / ${a.gaps.totalGapChordM.toFixed(1)}m of chord)`,
  );
  for (const g of a.gaps.detail) {
    console.log(
      `    · dt=${g.dtS.toFixed(1)}s dist=${g.distM.toFixed(1)}m implied_speed=${(g.impliedSpeedMs * 3.6).toFixed(1)}km/h at segment #${g.i}`,
    );
  }
  console.log(
    `  distance: stored ${a.distance.storedM.toFixed(1)}m, naive recompute ${a.distance.recomputedNaiveM.toFixed(1)}m, ` +
      `delta ${a.distance.deltaM.toFixed(1)}m (${a.distance.deltaPct?.toFixed(2)}%)`,
  );
  if (a.gaps.count > 0) {
    const ratio = a.distance.gapChordVsDeltaRatio;
    const ratioStr = ratio === null ? 'n/a' : ratio === Infinity ? '∞' : ratio.toFixed(2);
    const read =
      ratio !== null && ratio >= 0.7 && ratio <= 1.4
        ? 'CONSISTENT with a leg-break: the gap chord was excluded from the stored total'
        : 'INCONSISTENT with a leg-break: stored total already includes most/all of this gap';
    console.log(`    gap-chord-total / delta ratio: ${ratioStr} — ${read}`);
  }
  if (a.fence.recomputed.fence) {
    console.log(
      `  fence: stored area ${a.fence.storedAreaM2}m², recomputed ${a.fence.recomputed.areaM2.toFixed(1)}m², ` +
        `delta ${a.fence.deltaM2?.toFixed(1)}m² (${a.fence.deltaPct?.toFixed(2)}%)` +
        `${a.fence.recomputed.selfIntersected ? ` [self-intersecting, ${a.fence.recomputed.lobes} lobe(s)]` : ''}`,
    );
  } else {
    console.log(
      `  fence: recompute returned NO FENCE (${a.fence.recomputed.reason}) — stored has_fence=${a.fence.storedHasFence}` +
        `${a.fence.storedHasFence ? ' — DISAGREEMENT' : ''}`,
    );
  }
  console.log(
    `  tiles: ${a.tiles.cellsClaimed} cells claimed (${a.tiles.directCount} direct, ${a.tiles.gapFilledCount} gap-filled), ` +
      `~${a.tiles.tileAreaM2Estimate.toLocaleString()}m² by tile count`,
  );
  console.log(
    `    bridge failures: ${a.tiles.bridgeFailures}, skipped(speed): ${a.tiles.bridgesSkippedSpeed}, skipped(distance): ${a.tiles.bridgesSkippedDistance}`,
  );
  if (a.flagged !== null) {
    console.log(`  anti-cheat: flagged=${a.flagged} reason=${a.flag_reason ?? 'n/a'}`);
  } else {
    console.log('  anti-cheat: `flagged` column not present in the select result (migration likely unapplied).');
  }
}

const outPath = process.argv[2] ?? 'geometry-audit-report.json';
writeFileSync(
  outPath,
  JSON.stringify(
    { generatedAt: new Date().toISOString(), sampleSize: analyses.length, gapFlagThresholdS: GAP_FLAG_THRESHOLD_S, runs: analyses },
    null,
    2,
  ),
);
console.log('');
console.log(`[geometry-audit] Full machine-readable report written to ${outPath} (NOT committed — contains raw GPS paths).`);
console.log(`[geometry-audit] Sample size: ${analyses.length} run(s). Treat any pattern below n≈10 as a lead, not a conclusion.`);

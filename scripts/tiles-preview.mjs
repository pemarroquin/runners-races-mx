#!/usr/bin/env node
// Turns a recorded run's raw path into a GeoJSON preview showing BOTH the
// route and the H3 tiles it would claim under the coverage model — a
// field-verifiable milestone before any DB or rendering work exists to show
// it any other way. Drop the output straight into geojson.io.
//
// Mirrors src/lib/tiles.ts's pathToTiles() rather than importing it: this is
// a plain Node script and there's no ts-node/tsx in this project's
// toolchain (same reasoning as scripts/verify-sweep.mjs mirroring
// races.ts's validator — see that file's own header). Keep the two in sync
// by hand if the gap-fill algorithm changes.
//
// Usage:
//   node scripts/tiles-preview.mjs [input.json] [output.geojson]
//
// input.json tolerates the checkpoint/last-run-debug shape as-is:
// { points: [{lat,lng,ts}], ... } — or a bare array of points. With no
// input file (or one that can't be read/parsed), falls back to a SYNTHETIC
// demo path near Monterrey and labels every output as synthetic — this
// script never presents generated data as a real run.
import { readFileSync, writeFileSync } from 'node:fs';
import { cellToBoundary, gridPathCells, latLngToCell } from 'h3-js';

const RES = 11; // matches src/lib/tiles.ts's DEFAULT_TILE_RES
// Fastest sustained human running speed the server's OWN anti-cheat
// flagging already treats as implausible — see
// supabase/migrations/20260827_anti_cheat_flag.sql's `max_kmh := 25`.
// Reused rather than a second, possibly-disagreeing number.
const MAX_BRIDGE_SPEED_MS = (25 * 1000) / 3600; // ≈ 6.94 m/s

function haversineM(a, b) {
  const R = 6371008.8;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.sin(dLng / 2) ** 2 * Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat));
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

function pathToTiles(points, res = RES) {
  const direct = new Set();
  const gapFilled = new Set();
  let bridgeFailures = 0;
  let bridgesSkipped = 0;
  let prevCell = null;
  let prevPoint = null;
  for (const p of points) {
    const cell = latLngToCell(p.lat, p.lng, res);
    direct.add(cell);
    if (prevCell !== null && prevCell !== cell && prevPoint !== null) {
      const dtS = (p.ts - prevPoint.ts) / 1000;
      const impliedSpeedMs = dtS > 0 ? haversineM(prevPoint, p) / dtS : Infinity;
      if (impliedSpeedMs > MAX_BRIDGE_SPEED_MS) {
        // Leave the hole — bridging would claim ground never run over.
        // This is the actual bug fix (b8's review, 2026-09-01): a 2km
        // background-gap jump used to be bridged exactly like a normal
        // throttle gap, silently claiming ~95,000 m2 never covered.
        bridgesSkipped += 1;
      } else {
        try {
          for (const c of gridPathCells(prevCell, cell)) gapFilled.add(c);
        } catch {
          // Fail open to the two endpoints — see tiles.ts's own comment.
          // Counted, not silently swallowed: without this, "the bridge
          // threw and left a hole" is indistinguishable from "already
          // adjacent, nothing to bridge" — exactly the failure shape this
          // session kept getting burned by.
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
    bridgesSkipped,
  };
}

function pathDistanceM(points) {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += haversineM(points[i - 1], points[i]);
  return total;
}

// A short, deliberately artificial ~1.2km rectangular loop near Monterrey.
// ONLY used when no real capture is available — every output derived from
// it is labelled `synthetic: true` and the console output says so loudly.
// ~55m point spacing, not the tracker's real 2s/3m throttle: empirically,
// res-11 cell CENTRES are only ~25-45m apart, so anything under ~50m here
// lands in plain neighbouring cells with nothing to gap-fill and the demo
// would report a misleadingly reassuring 0%. 55m reliably exercises the
// fill, which is the whole point of running this on synthetic data at all.
//
// Timestamps are derived from a comfortable jogging pace (JOG_MS), NOT a
// fixed 2s step — a fixed 2s/55m step implies ~27.5 m/s (99 km/h), which
// the bridge speed cap now correctly refuses to bridge. Deriving ts from an
// actual plausible speed keeps the demo showing what it's meant to (gap-
// filling in action) instead of accidentally exercising the skip path.
const JOG_MS = 3; // ~10.8 km/h, comfortably under MAX_BRIDGE_SPEED_MS
function syntheticPath() {
  const LAT = 25.6866;
  const LNG = -100.3161;
  const M_PER_DEG_LAT = 111_320;
  const M_PER_DEG_LNG = M_PER_DEG_LAT * Math.cos((LAT * Math.PI) / 180);
  const corners = [
    [0, 0],
    [300, 0],
    [300, 200],
    [0, 200],
    [0, 0],
  ];
  const points = [];
  let ts = Date.now() - 25 * 60 * 1000;
  for (let i = 0; i < corners.length - 1; i++) {
    const [x0, y0] = corners[i];
    const [x1, y1] = corners[i + 1];
    const legM = Math.hypot(x1 - x0, y1 - y0);
    const steps = Math.max(1, Math.round(legM / 55)); // ~55m spacing
    const stepM = legM / steps;
    for (let s = i === 0 ? 0 : 1; s <= steps; s++) {
      const t = s / steps;
      const x = x0 + (x1 - x0) * t;
      const y = y0 + (y1 - y0) * t;
      points.push({ lat: LAT + y / M_PER_DEG_LAT, lng: LNG + x / M_PER_DEG_LNG, ts });
      ts += (stepM / JOG_MS) * 1000;
    }
  }
  return points;
}

function loadPoints(filePath) {
  if (!filePath) return null;
  let raw;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (e) {
    console.warn(`[tiles-preview] Could not read ${filePath}: ${e.message}`);
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    console.warn(`[tiles-preview] ${filePath} is not valid JSON: ${e.message}`);
    return null;
  }
  const points = Array.isArray(parsed) ? parsed : parsed.points;
  if (!Array.isArray(points) || points.length === 0) {
    console.warn(`[tiles-preview] ${filePath} has no usable "points" array.`);
    return null;
  }
  const clean = points.filter((p) => p && typeof p.lat === 'number' && typeof p.lng === 'number');
  if (clean.length === 0) {
    console.warn(`[tiles-preview] ${filePath}'s points have no valid lat/lng.`);
    return null;
  }
  return clean;
}

const inputPath = process.argv[2];
const outputPath = process.argv[3] ?? 'tiles-preview.geojson';

let points = loadPoints(inputPath);
let synthetic = false;
if (!points) {
  console.warn(
    inputPath
      ? `[tiles-preview] Falling back to a SYNTHETIC demo path — ${inputPath} was not usable.`
      : '[tiles-preview] No input file given — using a SYNTHETIC demo path.',
  );
  points = syntheticPath();
  synthetic = true;
}

const { cells, directCount, gapFilledCount, bridgeFailures, bridgesSkipped } = pathToTiles(points);
const distanceM = pathDistanceM(points);

const routeFeature = {
  type: 'Feature',
  properties: { kind: 'route', synthetic, pointCount: points.length, distanceM: Math.round(distanceM) },
  geometry: { type: 'LineString', coordinates: points.map((p) => [p.lng, p.lat]) },
};

const tileFeatures = cells.map((h3) => ({
  type: 'Feature',
  properties: { kind: 'tile', h3, synthetic },
  // formatAsGeoJson: true -> [lng, lat] pairs, already a closed loop.
  geometry: { type: 'Polygon', coordinates: [cellToBoundary(h3, true)] },
}));

const geojson = {
  type: 'FeatureCollection',
  properties: { synthetic, bridgeFailures, bridgesSkipped, generatedAt: new Date().toISOString() },
  features: [routeFeature, ...tileFeatures],
};

writeFileSync(outputPath, JSON.stringify(geojson, null, 2));

const gapPct = cells.length > 0 ? ((gapFilledCount / cells.length) * 100).toFixed(0) : '0';
console.log(`[tiles-preview] ${synthetic ? 'SYNTHETIC demo path (not a real run)' : inputPath}`);
console.log(`  points:           ${points.length}`);
console.log(`  distance:         ${(distanceM / 1000).toFixed(2)} km`);
console.log(`  tiles claimed:    ${cells.length}`);
console.log(`  tiles direct:     ${directCount}`);
console.log(`  tiles gap-filled: ${gapFilledCount} (${gapPct}% of claimed tiles)`);
console.log(`  bridge failures:  ${bridgeFailures}${bridgeFailures > 0 ? ' — some gaps left UNFILLED holes, see tiles.ts' : ''}`);
console.log(`  bridges skipped:  ${bridgesSkipped}${bridgesSkipped > 0 ? ' — gap(s) implied a superhuman speed, left unbridged (see MAX_BRIDGE_SPEED_MS)' : ''}`);
console.log(`  wrote:            ${outputPath}`);
if (synthetic) {
  console.log('  NOTE: synthetic data — not Pedro\'s or anyone\'s real run.');
}

#!/usr/bin/env -S npx vite-node --config vitest.config.ts
// Turns a recorded run's raw path into a GeoJSON preview showing BOTH the
// route and the H3 tiles it would claim under the coverage model — a
// field-verifiable milestone before any DB or rendering work exists to show
// it any other way. Drop the output straight into geojson.io.
//
// Imports the app's OWN pathToTiles/pathDistanceM rather than mirroring
// them by hand. This used to hand-mirror both, and the mirror drifted
// silently: RES stayed 11 after DEFAULT_TILE_RES moved to 12
// (2026-09-07), and a flat per-gap distance cap disagreed with
// gap-policy.ts's whole-run budget (2026-09-02 geometry audit). Both are
// exactly the "two places apply the same rule and disagree" failure this
// codebase keeps a single shared implementation to prevent — see
// gap-policy.ts's own header. Run via `npm run tiles-preview`, which
// invokes this through vite-node so the `@/` alias resolves (same setup as
// convert-tile-res.ts / verify-claims.ts / measure-holes.ts /
// extract-park-paths.ts).
//
// Usage:
//   npm run tiles-preview -- [input.json] [output.geojson]
//
// input.json tolerates the checkpoint/last-run-debug shape as-is:
// { points: [{lat,lng,ts}], ... } — or a bare array of points. With no
// input file (or one that can't be read/parsed), falls back to a SYNTHETIC
// demo path near Monterrey and labels every output as synthetic — this
// script never presents generated data as a real run.
import { readFileSync, writeFileSync } from 'node:fs';
import { cellToBoundary } from 'h3-js';

import { pathDistanceM } from '@/lib/territory';
import { DEFAULT_TILE_RES, pathToTiles, type TilePoint } from '@/lib/tiles';
import { MAX_BRIDGE_SPEED_MS } from '@/lib/gap-policy';

// A short, deliberately artificial ~1.2km rectangular loop near Monterrey.
// ONLY used when no real capture is available — every output derived from
// it is labelled `synthetic: true` and the console output says so loudly.
// ~55m point spacing, not the tracker's real 2s/3m throttle: empirically,
// res-12 cell centres are only ~10-19m apart, so anything under ~20m here
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
function syntheticPath(): TilePoint[] {
  const LAT = 25.6866;
  const LNG = -100.3161;
  const M_PER_DEG_LAT = 111_320;
  const M_PER_DEG_LNG = M_PER_DEG_LAT * Math.cos((LAT * Math.PI) / 180);
  const corners: [number, number][] = [
    [0, 0],
    [300, 0],
    [300, 200],
    [0, 200],
    [0, 0],
  ];
  const points: TilePoint[] = [];
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

function loadPoints(filePath: string | undefined): TilePoint[] | null {
  if (!filePath) return null;
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (e) {
    console.warn(`[tiles-preview] Could not read ${filePath}: ${(e as Error).message}`);
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    console.warn(`[tiles-preview] ${filePath} is not valid JSON: ${(e as Error).message}`);
    return null;
  }
  const points = Array.isArray(parsed) ? parsed : (parsed as { points?: unknown }).points;
  if (!Array.isArray(points) || points.length === 0) {
    console.warn(`[tiles-preview] ${filePath} has no usable "points" array.`);
    return null;
  }
  const clean = (points as unknown[]).filter(
    (p): p is TilePoint =>
      typeof p === 'object' &&
      p !== null &&
      typeof (p as TilePoint).lat === 'number' &&
      typeof (p as TilePoint).lng === 'number' &&
      typeof (p as TilePoint).ts === 'number',
  );
  if (clean.length === 0) {
    console.warn(`[tiles-preview] ${filePath}'s points have no valid lat/lng/ts.`);
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

const { cells, directCount, gapFilledCount, bridgeFailures, bridgesSkippedSpeed, bridgesSkippedDistance } =
  pathToTiles(points);
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
  properties: {
    synthetic,
    bridgeFailures,
    bridgesSkippedSpeed,
    bridgesSkippedDistance,
    generatedAt: new Date().toISOString(),
  },
  features: [routeFeature, ...tileFeatures],
};

writeFileSync(outputPath, JSON.stringify(geojson, null, 2));

const gapPct = cells.length > 0 ? ((gapFilledCount / cells.length) * 100).toFixed(0) : '0';
console.log(
  `[tiles-preview] ${synthetic ? 'SYNTHETIC demo path (not a real run)' : inputPath} — res ${DEFAULT_TILE_RES}, ` +
    `MAX_BRIDGE_SPEED_MS ${MAX_BRIDGE_SPEED_MS.toFixed(2)}, real gap-policy.ts budget (not a flat cap)`,
);
console.log(`  points:                  ${points.length}`);
console.log(`  distance:                ${(distanceM / 1000).toFixed(2)} km`);
console.log(`  tiles claimed:           ${cells.length}`);
console.log(`  tiles direct:            ${directCount}`);
console.log(`  tiles gap-filled:        ${gapFilledCount} (${gapPct}% of claimed tiles)`);
console.log(
  `  bridge failures:        ${bridgeFailures}${bridgeFailures > 0 ? ' — some gaps left UNFILLED holes, see tiles.ts' : ''}`,
);
console.log(
  `  bridges skipped (speed): ${bridgesSkippedSpeed}${bridgesSkippedSpeed > 0 ? ' — gap(s) implied a superhuman speed, left unbridged (see MAX_BRIDGE_SPEED_MS)' : ''}`,
);
console.log(
  `  bridges skipped (dist):  ${bridgesSkippedDistance}${bridgesSkippedDistance > 0 ? ' — gap(s) exceeded MAX_BRIDGE_DISTANCE_M, path unknown, left unbridged' : ''}`,
);
console.log(`  wrote:                   ${outputPath}`);
if (synthetic) {
  console.log("  NOTE: synthetic data — not Pedro's or anyone's real run.");
}

// Territory Mode geometry pipeline — turns a recorded GPS run into a closed
// "fence" polygon and its area. Pure functions, no native modules, no React:
// same testing philosophy as races.ts (see vitest.config.ts's header comment)
// and the reason this file is safe to unit-test directly against known
// self-intersecting tracks before any UI exists.
//
// See: Source Data/Outputs/Running App/Territory Mode — Feature Plan.md
// §"Geometry pipeline" for the design rationale.
import area from '@turf/area';
import { polygon } from '@turf/helpers';
import kinks from '@turf/kinks';
import simplify from '@turf/simplify';
import union from '@turf/union';
import unkinkPolygon from '@turf/unkink-polygon';
import type { Feature, MultiPolygon, Polygon, Position } from 'geojson';

export interface LatLng {
  lat: number;
  lng: number;
}

export interface FenceResult {
  /** Cleaned, closed, simplified GeoJSON polygon — may be a MultiPolygon if
   *  the raw route self-intersected and split into separate lobes. */
  geometry: Feature<Polygon | MultiPolygon>;
  areaM2: number;
}

// ~3m at the equator, tightening slightly at MX latitudes. Cuts GPS jitter
// noise without flattening a genuinely small loop into a sliver.
const DEFAULT_TOLERANCE_DEG = 0.00003;
const MIN_FENCE_POINTS = 3;

/** [lat,lng] → GeoJSON's [lng,lat] order. Mixing these up silently produces
 *  a polygon on the wrong side of the planet, not an error. */
function toLngLat(points: LatLng[]): Position[] {
  return points.map((p) => [p.lng, p.lat]);
}

const EARTH_RADIUS_M = 6371008.8; // mean radius, same value @turf/area uses

/** Great-circle distance between two fixes, in metres. */
export function haversineM(a: LatLng, b: LatLng): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Total travelled distance along a recorded path, in metres. This is the
 *  route length the runner actually covered — NOT the fence perimeter, which
 *  would include the synthetic closing segment. */
export function pathDistanceM(points: LatLng[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += haversineM(points[i - 1], points[i]);
  return total;
}

/** Drops consecutive duplicate points (a runner stopped at a light, GPS kept
 *  emitting the same fix) — turf's polygon builder chokes on a degenerate
 *  ring otherwise. */
function dedupeConsecutive(coords: Position[]): Position[] {
  const out: Position[] = [];
  for (const c of coords) {
    const prev = out[out.length - 1];
    if (!prev || prev[0] !== c[0] || prev[1] !== c[1]) out.push(c);
  }
  return out;
}

/** Appends the start point to the end if the path isn't already closed —
 *  the "auto-close, any route shape" rule from the feature plan. */
export function closeRing(coords: Position[]): Position[] {
  if (coords.length === 0) return coords;
  const first = coords[0];
  const last = coords[coords.length - 1];
  if (first[0] === last[0] && first[1] === last[1]) return coords;
  return [...coords, first];
}

/**
 * A raw GPS polygon is frequently NOT simple — an out-and-back run is close
 * to a degenerate sliver, and a loop with any backtrack crosses itself.
 * `@turf/area` silently returns a wrong number on a self-crossing polygon
 * instead of erroring, so this check is not optional.
 *
 * When self-intersecting: `unkinkPolygon` splits the shape into simple
 * lobes at each crossing. Those lobes don't overlap each other by
 * construction, so unioning all of them back together is the honest read of
 * "the total area this route enclosed" — as opposed to keeping only the
 * largest lobe, which would silently discard real ground the runner covered.
 */
export function cleanPolygon(raw: Feature<Polygon>): Feature<Polygon | MultiPolygon> {
  const intersections = kinks(raw);
  if (intersections.features.length === 0) return raw;

  const pieces = unkinkPolygon(raw);
  if (pieces.features.length === 0) return raw; // shouldn't happen; fail safe to the raw shape
  if (pieces.features.length === 1) return pieces.features[0];

  const merged = union(pieces);
  return merged ?? pieces.features[0]; // union() can return null for degenerate input
}

/**
 * Full pipeline: raw recorded [lat,lng] points → cleaned closed fence +
 * area in m². Returns null if there aren't enough distinct points to form a
 * polygon at all (a run that never really moved, or was stopped almost
 * immediately) — callers should treat that as "no fence," not as an error.
 */
export function buildFence(path: LatLng[], toleranceDeg = DEFAULT_TOLERANCE_DEG): FenceResult | null {
  const ring = dedupeConsecutive(closeRing(toLngLat(path)));
  if (ring.length < MIN_FENCE_POINTS + 1) return null; // +1 for the closing repeat of point 0

  // The whole pipeline is wrapped because turf THROWS on degenerate input
  // rather than returning something this function can inspect.
  //
  // The case that matters is not exotic: walk in a straight line — office to
  // the parking lot, say — and the auto-closed ring is collinear. simplify()
  // then collapses it below four points and raises "invalid polygon, fewer
  // than 4 points" from inside @turf/clean-coords, BEFORE the ring check
  // below ever runs. On the Track screen buildFence is called during render,
  // so that throw took the whole tab down at the moment the runner pressed
  // Stop (found 2026-08-27, from a real 50m walk).
  //
  // This function's contract has always been "returns null if there aren't
  // enough distinct points to form a polygon" — a straight line is exactly
  // that case, so null is the honest answer and the implementation now
  // actually delivers it.
  try {
    const raw = polygon([ring]);
    const simplified = simplify(raw, { tolerance: toleranceDeg, highQuality: true });

    // Simplification can collapse a small/noisy loop below the minimum ring
    // size — re-check rather than handing turf a broken ring.
    const simplifiedRing = simplified.geometry.coordinates[0];
    if (!simplifiedRing || dedupeConsecutive(simplifiedRing).length < MIN_FENCE_POINTS + 1) {
      return null;
    }

    const cleaned = cleanPolygon(simplified);
    const areaM2 = area(cleaned);
    // A collinear or hairline shape can survive the point checks and still
    // enclose nothing. Treat that as "no fence" rather than offering the
    // runner a 0 m² territory to save.
    if (!Number.isFinite(areaM2) || areaM2 <= 0) return null;
    return { geometry: cleaned, areaM2 };
  } catch (e) {
    // The catch spans cleanPolygon() too, whose union()/unkinkPolygon()
    // backend is known to throw on numerically unstable input ("Unable to
    // complete output ring") — which a long, messy city loop can produce.
    // That is NOT the collinear case above, and silently returning null
    // tells a runner who just did 15km that their "route was too short",
    // with the Save button gated off and nothing recorded anywhere.
    //
    // Still returns null (the screen must not crash), but says so, so the
    // difference between "you walked in a line" and "turf fell over on your
    // real run" is recoverable from a log instead of invisible.
    if (process.env.NODE_ENV !== 'production') {
      console.warn('[buildFence] geometry pipeline threw; treating as no fence', e);
    }
    return null;
  }
}

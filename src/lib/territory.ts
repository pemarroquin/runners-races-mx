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

  const raw = polygon([ring]);
  const simplified = simplify(raw, { tolerance: toleranceDeg, highQuality: true });

  // Simplification can collapse a small/noisy loop below the minimum ring
  // size — re-check rather than handing turf a broken ring.
  const simplifiedRing = simplified.geometry.coordinates[0];
  if (!simplifiedRing || dedupeConsecutive(simplifiedRing).length < MIN_FENCE_POINTS + 1) return null;

  const cleaned = cleanPolygon(simplified);
  const areaM2 = area(cleaned);
  return { geometry: cleaned, areaM2 };
}

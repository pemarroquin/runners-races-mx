// Geometry for the rising 3D fence wall behind the runner.
//
// The route renders in two pieces while a session is live:
//   - the LAST `FENCE_LAG_M` metres stay a flat gradient line (the "live"
//     edge, still being drawn),
//   - everything older than that becomes a wall — a thin ribbon polygon
//     extruded upward, which is what makes the territory read as fenced in
//     rather than merely traced.
//
// Both pieces share their join point, so the line visually feeds into the
// wall instead of leaving a gap.
//
// Pure functions with no map/SDK dependency, so the metre maths is unit
// testable — same reasoning as territory.ts.
import type { Feature, Polygon } from 'geojson';

import { haversineM, type LatLng } from '@/lib/territory';

const METRES_PER_DEG_LAT = 111_320;

export interface RouteSplit {
  /** Older part of the route — becomes the extruded wall. */
  settled: LatLng[];
  /** Most recent stretch — stays a flat line. Shares its first point with
   *  `settled`'s last, so the two render as one continuous route. */
  active: LatLng[];
}

/**
 * Splits a route into the part that has "set" into a fence and the live
 * trailing edge, measured by distance travelled backwards from the current
 * position — not by point count, which would vary with GPS sample rate.
 */
export function splitTrailing(points: LatLng[], trailingM: number): RouteSplit {
  if (points.length < 2) return { settled: [], active: points };

  let accumulated = 0;
  // Walk backwards from the newest point until `trailingM` is covered.
  for (let i = points.length - 1; i > 0; i--) {
    accumulated += haversineM(points[i - 1], points[i]);
    if (accumulated >= trailingM) {
      // `accumulated` INCLUDES the i-1 → i segment, so the live edge has to
      // start at i-1 for its length to actually equal that distance. Slicing
      // from `i` here left the edge one segment short of the window — caught
      // by the "covers at least the requested window" test.
      return {
        settled: points.slice(0, i), // ends at points[i - 1]
        active: points.slice(i - 1), // starts at points[i - 1] — shared join
      };
    }
  }
  // Whole route is shorter than the trailing window: nothing has settled yet.
  return { settled: [], active: points };
}

/**
 * A thin ribbon polygon centred on the path, for `fill-extrusion`.
 *
 * Mapbox can't extrude a LineString, so the wall has to be an actual polygon:
 * the path offset perpendicular by half the wall thickness on one side, then
 * back along the other. Offsets are computed per-point from the local
 * heading, and longitude is scaled by cos(latitude) — without that the wall
 * would be visibly thicker running east-west than north-south.
 */
export function buildWallPolygon(points: LatLng[], widthM: number): Feature<Polygon> | null {
  if (points.length < 2) return null;

  const half = widthM / 2;
  const left: [number, number][] = [];
  const right: [number, number][] = [];

  for (let i = 0; i < points.length; i++) {
    const prev = points[Math.max(0, i - 1)];
    const next = points[Math.min(points.length - 1, i + 1)];
    const p = points[i];

    const cosLat = Math.cos((p.lat * Math.PI) / 180) || 1e-6;
    // Heading as a local metre-space vector, so the perpendicular is a plain
    // 90° rotation rather than a spherical bearing calculation.
    const dx = (next.lng - prev.lng) * METRES_PER_DEG_LAT * cosLat;
    const dy = (next.lat - prev.lat) * METRES_PER_DEG_LAT;
    const len = Math.hypot(dx, dy) || 1;

    // Perpendicular of (dx, dy) is (-dy, dx), normalised then scaled.
    const offsetXm = (-dy / len) * half;
    const offsetYm = (dx / len) * half;

    const dLng = offsetXm / (METRES_PER_DEG_LAT * cosLat);
    const dLat = offsetYm / METRES_PER_DEG_LAT;

    left.push([p.lng + dLng, p.lat + dLat]);
    right.push([p.lng - dLng, p.lat - dLat]);
  }

  const ring = [...left, ...right.reverse()];
  ring.push(ring[0]); // GeoJSON rings must close

  return {
    type: 'Feature',
    properties: {},
    geometry: { type: 'Polygon', coordinates: [ring] },
  };
}

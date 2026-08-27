// Drawing helpers shared by the native fence renderers (track-map.tsx,
// fence-map.tsx): GeoJSON ring extraction for react-native-maps, and
// per-vertex sampling of the route gradient — GL JS interpolates
// `line-gradient` on the GPU on web, but react-native-maps' Polyline needs
// one explicit colour per coordinate. Pure functions, unit-testable.
import type { MultiPolygon, Polygon, Position } from 'geojson';

import { ROUTE_GRADIENT } from '@/constants/map';

export interface MapCoord {
  latitude: number;
  longitude: number;
}

/** GeoJSON [lng,lat] ring → react-native-maps coordinate list. */
export function ringToCoords(ring: Position[]): MapCoord[] {
  return ring.map(([lng, lat]) => ({ latitude: lat, longitude: lng }));
}

/**
 * (Multi)Polygon → its polygons' rings, each as [outer, ...holes]. Callers
 * feed outer to react-native-maps' `coordinates` and the rest to `holes`.
 */
export function polygonRings(geometry: Polygon | MultiPolygon): Position[][][] {
  return geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
}

/** Linear blend of two '#rrggbb' colours. */
function hexLerp(a: string, b: string, t: number): string {
  const pa = parseInt(a.slice(1), 16);
  const pb = parseInt(b.slice(1), 16);
  const ch = (shift: number) => {
    const va = (pa >> shift) & 0xff;
    const vb = (pb >> shift) & 0xff;
    return Math.round(va + (vb - va) * t);
  };
  return `#${((ch(16) << 16) | (ch(8) << 8) | ch(0)).toString(16).padStart(6, '0')}`;
}

/** Colour at offset t ∈ [0,1] along ROUTE_GRADIENT — cool tail, warm head. */
export function gradientColorAt(t: number): string {
  const stops = ROUTE_GRADIENT;
  if (t <= stops[0][0]) return stops[0][1];
  for (let i = 1; i < stops.length; i++) {
    const [offset, color] = stops[i];
    if (t <= offset) {
      const [prevOffset, prevColor] = stops[i - 1];
      return hexLerp(prevColor, color, (t - prevOffset) / (offset - prevOffset));
    }
  }
  return stops[stops.length - 1][1];
}

/** One gradient colour per vertex, for Polyline `strokeColors`. */
export function gradientStrokeColors(count: number): string[] {
  if (count <= 0) return [];
  return Array.from({ length: count }, (_, i) =>
    gradientColorAt(count === 1 ? 1 : i / (count - 1)),
  );
}

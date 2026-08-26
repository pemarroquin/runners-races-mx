// Shared Mapbox Static Images URL builder — used by the route map on BOTH web
// and native (a plain image, no GL/native-maps SDK, no Google API key). Requires
// EXPO_PUBLIC_MAPBOX_TOKEN (inlined at build time for every platform).
import type { Geometry } from 'geojson';

import type { Race } from '@/lib/races';

const TOKEN = process.env.EXPO_PUBLIC_MAPBOX_TOKEN;
const ROUTE_COLOR = 'e4572e'; // #E4572E without the '#'
const IMG = { w: 800, h: 300, retina: '@2x' };
const MARKER_ZOOM = 14;

export const MAPBOX_ENABLED = !!TOKEN;
export const MAP_ASPECT = IMG.w / IMG.h; // 2.66:1

// Google/Mapbox polyline encoding (precision 5).
function encodePolyline(coords: [number, number][]): string {
  const enc = (v: number) => {
    let value = v < 0 ? ~(v << 1) : v << 1;
    let out = '';
    while (value >= 0x20) {
      out += String.fromCharCode((0x20 | (value & 0x1f)) + 63);
      value >>= 5;
    }
    return out + String.fromCharCode(value + 63);
  };
  let lastLat = 0;
  let lastLng = 0;
  let result = '';
  for (const [lat, lng] of coords) {
    const latE5 = Math.round(lat * 1e5);
    const lngE5 = Math.round(lng * 1e5);
    result += enc(latE5 - lastLat) + enc(lngE5 - lastLng);
    lastLat = latE5;
    lastLng = lngE5;
  }
  return result;
}

/** Static-map image URL for a race's start pin (+ route polyline if present), or null. */
export function buildStaticMapUrl(race: Race, dark: boolean): string | null {
  const start = race.start ?? null;
  if (!TOKEN || !start) return null;

  const styleId = dark ? 'mapbox/dark-v11' : 'mapbox/streets-v12';
  const route = race.routeCoords && race.routeCoords.length > 1 ? race.routeCoords : null;

  const overlays: string[] = [];
  if (route) {
    overlays.push(`path-4+${ROUTE_COLOR}-0.9(${encodeURIComponent(encodePolyline(route))})`);
  }
  overlays.push(`pin-l+${ROUTE_COLOR}(${start.lng},${start.lat})`);

  const viewport = route ? 'auto' : `${start.lng},${start.lat},${MARKER_ZOOM}`;
  const size = `${IMG.w}x${IMG.h}${IMG.retina}`;
  const padding = route ? '&padding=40' : '';

  return `https://api.mapbox.com/styles/v1/${styleId}/static/${overlays.join(
    ',',
  )}/${viewport}/${size}?access_token=${TOKEN}${padding}`;
}

// Territory Mode's finished fence, drawn over real streets — one image
// request when a run ends, which is affordable in a way that repainting a
// live map would not be (see route-trace.tsx's header).
const FENCE_IMG = { w: 800, h: 500, retina: '@2x' };
export const FENCE_MAP_ASPECT = FENCE_IMG.w / FENCE_IMG.h;

/**
 * Static-map URL for a fence polygon, or null when no token is configured.
 *
 * Mapbox's `geojson(...)` overlay styles itself from simplestyle-spec
 * properties on the feature, so the fill/stroke have to ride along inside
 * the GeoJSON rather than being URL parameters like the `path(...)` overlay
 * above. A very long ring can also blow past Mapbox's ~8k URL limit — the
 * caller passes geometry that territory.ts has already simplified, and this
 * returns null rather than emitting a URL the API will reject outright.
 */
export function buildFenceMapUrl(geometry: Geometry, dark: boolean): string | null {
  if (!TOKEN) return null;

  const styleId = dark ? 'mapbox/dark-v11' : 'mapbox/streets-v12';
  const feature = {
    type: 'Feature' as const,
    properties: {
      stroke: `#${ROUTE_COLOR}`,
      'stroke-width': 3,
      'stroke-opacity': 0.95,
      fill: `#${ROUTE_COLOR}`,
      'fill-opacity': 0.25,
    },
    geometry,
  };

  const overlay = `geojson(${encodeURIComponent(JSON.stringify(feature))})`;
  const size = `${FENCE_IMG.w}x${FENCE_IMG.h}${FENCE_IMG.retina}`;
  const url = `https://api.mapbox.com/styles/v1/${styleId}/static/${overlay}/auto/${size}?access_token=${TOKEN}&padding=40`;

  return url.length > 8000 ? null : url;
}

// Shared Mapbox Static Images URL builder — used by the route map on BOTH web
// and native (a plain image, no GL/native-maps SDK, no Google API key). Requires
// EXPO_PUBLIC_MAPBOX_TOKEN (inlined at build time for every platform).
import type { Geometry } from 'geojson';

import {
  FENCE_FILL_OPACITY,
  MAP_ALWAYS_DARK,
  MAP_DEFAULT_ZOOM,
  MAP_STYLE_STATIC,
  ROUTE_LINE_COLOR_URL,
} from '@/constants/map';
import type { Race } from '@/lib/races';

const TOKEN = process.env.EXPO_PUBLIC_MAPBOX_TOKEN;
const ROUTE_COLOR = ROUTE_LINE_COLOR_URL; // shared with GL JS — see constants/map.ts
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

/**
 * Basemap centred on a single point, with a pin — what the Track tab shows
 * before a run starts, so the screen isn't empty while you're standing at
 * the start line.
 */
export function buildPinMapUrl(
  lat: number,
  lng: number,
  _dark: boolean,
  /** Only draw the pin when the coordinate is a real fix. Framing the map on
   *  the selected city is fine; dropping a "you are here" pin on that city's
   *  centre is a false claim, and was the actual cause of the pin appearing
   *  kilometres from the runner. */
  hasRealFix = true,
): string | null {
  if (!TOKEN) return null;
  // Territory Mode's map is always dark — see MAP_ALWAYS_DARK.
  const styleId = MAP_ALWAYS_DARK ? MAP_STYLE_STATIC : _dark ? 'mapbox/dark-v11' : 'mapbox/streets-v12';
  const size = `${FENCE_IMG.w}x${FENCE_IMG.h}${FENCE_IMG.retina}`;
  const overlay = hasRealFix ? `pin-s+${ROUTE_COLOR}(${lng},${lat})` : '';
  const path = overlay ? `${overlay}/` : '';
  return `https://api.mapbox.com/styles/v1/${styleId}/static/${path}${lng},${lat},${MAP_DEFAULT_ZOOM}/${size}?access_token=${TOKEN}`;
}

/**
 * The route so far, drawn *by Mapbox* over real streets.
 *
 * The path is baked into the image rather than overlaid as SVG on top of a
 * basemap. Overlaying would mean reproducing Mapbox's Web Mercator framing
 * exactly to keep the line on the right streets, and any drift there reads
 * as a broken map — letting Mapbox draw both makes misalignment impossible
 * by construction. The cost is a network round-trip, which is why callers
 * throttle this (see track-map.tsx) instead of calling it per GPS fix.
 *
 * Long routes are decimated first: a polyline of several hundred points
 * encodes past Mapbox's ~8k URL limit, which fails as a broken image rather
 * than an error.
 */
export function buildPathMapUrl(
  points: { lat: number; lng: number }[],
  dark: boolean,
  /** Current position. Drawn as a pin on top of the route so the runner can
   *  see where they are on it — the route alone doesn't show which end is
   *  "now". */
  here?: { lat: number; lng: number } | null,
): string | null {
  if (!TOKEN || points.length < 2) return null;
  const styleId = MAP_ALWAYS_DARK ? MAP_STYLE_STATIC : dark ? 'mapbox/dark-v11' : 'mapbox/streets-v12';
  const size = `${FENCE_IMG.w}x${FENCE_IMG.h}${FENCE_IMG.retina}`;
  const coords = decimate(points, 100).map((p): [number, number] => [p.lat, p.lng]);
  const overlays = [`path-4+${ROUTE_COLOR}-0.9(${encodeURIComponent(encodePolyline(coords))})`];
  if (here) overlays.push(`pin-s+${ROUTE_COLOR}(${here.lng},${here.lat})`);
  const url = `https://api.mapbox.com/styles/v1/${styleId}/static/${overlays.join(
    ',',
  )}/auto/${size}?access_token=${TOKEN}&padding=50`;
  return url.length > 8000 ? null : url;
}

/** Evenly thin a list down to at most `max` items, always keeping the first
 *  and last so the drawn route still starts and ends where the run did. */
export function decimate<T>(items: T[], max: number): T[] {
  if (items.length <= max) return items;
  const step = (items.length - 1) / (max - 1);
  const out: T[] = [];
  for (let i = 0; i < max; i++) out.push(items[Math.round(i * step)]);
  return out;
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
 *
 * `route`, when given, draws the actual recorded path as a `path(...)`
 * overlay in the SAME request, comma-joined AFTER the fence's `geojson(...)`
 * overlay — this is the fix for the Saved tab's thumbnails drawing the
 * fence's polygon boundary instead of the run that was actually recorded
 * (`1df2ae6` fixed the same bug for the summary map). The Static Images API
 * draws later-listed overlays on top (buildStaticMapUrl pushes its pin AFTER
 * its path for the same reason), and constants/map.ts's GL map convention
 * (`MAP_SLOT_ROUTE = 'top'` above `MAP_SLOT_FILL`) makes the same call for
 * the identical reason: "a route must never render underneath a road or
 * building" — here, never underneath the fence's fill/stroke. A loop run's
 * fence boundary tracks close to the actual path, so a fence drawn on top
 * would bury exactly the route detail this fix exists to show. Decimated
 * the same way buildPathMapUrl decimates a live route, so a long run
 * doesn't blow the URL budget on its own.
 */
export function buildFenceMapUrl(
  geometry: Geometry,
  dark: boolean,
  /** '#rrggbb' — the run's own fence colour (FENCE_COLOR_SETS). Defaults to
   *  the route colour for callers that predate per-run colours. */
  colorHex?: string,
  /** The recorded route (already privacy-masked before it ever reached
   *  storage — see territory-sync.ts's parseRawPath). Omitted or too short
   *  to draw a line and the fence-only overlay renders exactly as before. */
  route?: { lat: number; lng: number }[],
): string | null {
  if (!TOKEN) return null;

  const color = colorHex ?? `#${ROUTE_COLOR}`;
  const styleId = MAP_ALWAYS_DARK ? MAP_STYLE_STATIC : dark ? 'mapbox/dark-v11' : 'mapbox/streets-v12';
  const feature = {
    type: 'Feature' as const,
    properties: {
      stroke: color,
      'stroke-width': 3,
      'stroke-opacity': 0.95,
      fill: color,
      'fill-opacity': FENCE_FILL_OPACITY,
    },
    geometry,
  };

  const overlays: string[] = [`geojson(${encodeURIComponent(JSON.stringify(feature))})`];
  if (route && route.length > 1) {
    const coords = decimate(route, 100).map((p): [number, number] => [p.lat, p.lng]);
    // Pushed AFTER the fence overlay so the route draws on top of it — see
    // the function doc above.
    overlays.push(`path-4+${ROUTE_COLOR}-0.9(${encodeURIComponent(encodePolyline(coords))})`);
  }

  const size = `${FENCE_IMG.w}x${FENCE_IMG.h}${FENCE_IMG.retina}`;
  const url = `https://api.mapbox.com/styles/v1/${styleId}/static/${overlays.join(
    ',',
  )}/auto/${size}?access_token=${TOKEN}&padding=40`;

  return url.length > 8000 ? null : url;
}

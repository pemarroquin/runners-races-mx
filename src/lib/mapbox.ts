// Shared Mapbox Static Images URL builder — used by the route map on BOTH web
// and native (a plain image, no GL/native-maps SDK, no Google API key). Requires
// EXPO_PUBLIC_MAPBOX_TOKEN (inlined at build time for every platform).

import {
  MAP_ALWAYS_DARK,
  MAP_STYLE_STATIC,
  ROUTE_LINE_COLOR_URL,
} from '@/constants/map';
import type { Race } from '@/lib/races';

const TOKEN = process.env.EXPO_PUBLIC_MAPBOX_TOKEN;
const ROUTE_COLOR = ROUTE_LINE_COLOR_URL; // shared with GL JS — see constants/map.ts
const IMG = { w: 800, h: 300, retina: '@2x' };
// Used by the pin map — track-map.web.tsx's full-bleed Track-tab
// placeholder, shown with objectFit:'cover' over a PORTRAIT container. A
// landscape 800x500 frame (1.6 aspect) forced cover to scale the image up
// ~1.4x in CSS terms just to fill a ~0.46-aspect phone screen, on top of
// the device's own 2-3x pixel ratio — compounding into ~4x upscale past
// the source resolution, which is what read as pixelated (reported
// 2026-09-17). Shaped to a portrait ratio instead so cover barely has to
// scale it at all; kept at roughly the same total pixel count (384,000 vs
// 400,000) so this doesn't reopen the LCP bottleneck @2x caused (222 KiB —
// see git history) — that tradeoff stays as-is, this fixes the same
// pixel budget's aspect ratio instead of its resolution. Still no @2x
// suffix: this is a blurred background placeholder, not a sharp detail
// view.
const FENCE_IMG = { w: 480, h: 800, retina: '' };
const MARKER_ZOOM = 14;
// One step further out than MAP_DEFAULT_ZOOM (15), for this static
// placeholder ONLY — deliberately not sharing that constant, which the
// live interactive map also boots at (track-map.web.tsx). Less fine
// road/label detail in the source image means any remaining softness from
// the upscale above reads as a smooth basemap rather than blocky edges;
// the live map keeps its own zoom untouched.
const STATIC_PLACEHOLDER_ZOOM = 13;


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
  dark: boolean,
  /** Only draw the pin when the coordinate is a real fix. Framing the map on
   *  the selected city is fine; dropping a "you are here" pin on that city's
   *  centre is a false claim, and was the actual cause of the pin appearing
   *  kilometres from the runner. */
  hasRealFix = true,
): string | null {
  if (!TOKEN) return null;
  const styleId = pinMapStyleId(dark);
  const size = `${FENCE_IMG.w}x${FENCE_IMG.h}${FENCE_IMG.retina}`;
  const path = hasRealFix ? `pin-s+${ROUTE_COLOR}(${lng},${lat})/` : '';
  return `https://api.mapbox.com/styles/v1/${styleId}/static/${path}${lng},${lat},${STATIC_PLACEHOLDER_ZOOM}/${size}?access_token=${TOKEN}`;
}

/** Territory Mode's map is always dark — see MAP_ALWAYS_DARK — so the
 *  caller's light/dark preference only decides the style when that flag is
 *  off. Race maps (buildStaticMapUrl above) follow the preference either
 *  way, which is why this lives here and not there. */
function pinMapStyleId(dark: boolean): string {
  if (MAP_ALWAYS_DARK) return MAP_STYLE_STATIC;
  return dark ? 'mapbox/dark-v11' : 'mapbox/streets-v12';
}

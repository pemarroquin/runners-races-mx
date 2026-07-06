// Shared Mapbox Static Images URL builder — used by the route map on BOTH web
// and native (a plain image, no GL/native-maps SDK, no Google API key). Requires
// EXPO_PUBLIC_MAPBOX_TOKEN (inlined at build time for every platform).
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

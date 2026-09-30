// Mexican metro regions the app can switch between. The unit is the metro
// area backed by state matching — races in a metro span many municipalities
// (MTY races run in San Nicolás, San Pedro, Guadalupe, Apodaca, Santiago…),
// so filtering by race.state keeps the whole metro calendar together.
// Only Monterrey has race data today; the others are wired and waiting for
// data compiled via the Race Research Playbook.
import type { Race } from '@/lib/races';

export interface Region {
  id: string;
  name: string; // display name
  states: string[]; // race.state values that belong to this region
  lat: number; // metro center, for nearest-region matching
  lng: number;
  /** How this city divides itself, for the leaderboard's place switcher —
   *  municipios here, arrondissements in Paris, boroughs in London. Read only
   *  by scripts/extract-subdivisions.ts, which keeps the TOP_SUBDIVISIONS most
   *  populated ones. Check a new city's OSM admin levels by hand. */
  subdivisions?: {
    /** OSM area the subdivisions sit inside, and its admin_level. */
    within: { name: string; adminLevel: number };
    /** admin_level of the subdivisions themselves. */
    adminLevel: number;
  };
}

/** Subdivisions kept per city (Pedro, 2026-09-30): the most populated urban
 *  ones, where running actually happens. */
export const TOP_SUBDIVISIONS = 10;

export const REGIONS: Region[] = [
  {
    id: 'mty',
    name: 'Monterrey',
    states: ['Nuevo León'],
    lat: 25.6866,
    lng: -100.3161,
    subdivisions: { within: { name: 'Nuevo León', adminLevel: 4 }, adminLevel: 6 },
  },
  { id: 'cdmx', name: 'Ciudad de México', states: ['Ciudad de México', 'Estado de México'], lat: 19.4326, lng: -99.1332 },
  { id: 'gdl', name: 'Guadalajara', states: ['Jalisco'], lat: 20.6597, lng: -103.3496 },
  { id: 'qro', name: 'Querétaro', states: ['Querétaro'], lat: 20.5888, lng: -100.3899 },
  { id: 'pue', name: 'Puebla', states: ['Puebla'], lat: 19.0414, lng: -98.2063 },
  { id: 'mid', name: 'Mérida', states: ['Yucatán'], lat: 20.9674, lng: -89.5926 },
  { id: 'tij', name: 'Tijuana', states: ['Baja California'], lat: 32.5149, lng: -117.0382 },
  { id: 'leon', name: 'León', states: ['Guanajuato'], lat: 21.125, lng: -101.686 },
  { id: 'cun', name: 'Cancún', states: ['Quintana Roo'], lat: 21.1619, lng: -86.8515 },
  { id: 'slp', name: 'San Luis Potosí', states: ['San Luis Potosí'], lat: 22.1565, lng: -100.9855 },
  { id: 'slw', name: 'Saltillo', states: ['Coahuila'], lat: 25.4383, lng: -100.9737 },
  { id: 'chih', name: 'Chihuahua', states: ['Chihuahua'], lat: 28.632, lng: -106.0691 },
];

export const DEFAULT_REGION_ID = 'mty'; // the only region with data today

export function getRegion(id: string | null | undefined): Region {
  return REGIONS.find((r) => r.id === id) ?? REGIONS[0];
}

export function raceInRegion(race: Race, region: Region): boolean {
  return region.states.includes(race.state);
}

/** Great-circle distance in km (haversine). */
function distanceKm(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLng = ((bLng - aLng) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((aLat * Math.PI) / 180) * Math.cos((bLat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/**
 * Nearest region to a coordinate. Mexico-bound: if the closest metro is
 * further than `maxKm` (clearly outside MX coverage), there is no sensible
 * match — return `null` rather than silently substituting the default, so
 * callers can tell "we detected you're in Monterrey" apart from "we have no
 * idea where you are". 450km is wide enough to still resolve genuinely
 * covered-but-far cities (e.g. Oaxaca City, ~330km from Puebla, its nearest
 * covered metro) while rejecting locations with no nearby coverage at all.
 */
export function nearestRegion(lat: number, lng: number, maxKm = 450): Region | null {
  let best: Region | null = null;
  let bestD = Infinity;
  for (const r of REGIONS) {
    const d = distanceKm(lat, lng, r.lat, r.lng);
    if (d < bestD) {
      bestD = d;
      best = r;
    }
  }
  return best && bestD <= maxKm ? best : null;
}

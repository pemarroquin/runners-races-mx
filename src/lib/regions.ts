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
}

export const REGIONS: Region[] = [
  { id: 'mty', name: 'Monterrey', states: ['Nuevo León'], lat: 25.6866, lng: -100.3161 },
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
 * further than `maxKm` (clearly outside MX coverage), fall back to default.
 */
export function nearestRegion(lat: number, lng: number, maxKm = 300): Region {
  let best: Region = getRegion(DEFAULT_REGION_ID);
  let bestD = Infinity;
  for (const r of REGIONS) {
    const d = distanceKm(lat, lng, r.lat, r.lng);
    if (d < bestD) {
      bestD = d;
      best = r;
    }
  }
  return bestD <= maxKm ? best : getRegion(DEFAULT_REGION_ID);
}

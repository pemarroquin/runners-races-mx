// Distance by pin, not by state. A region is a set of states, so the Saltillo
// feed holds Torreón (~260 km away) and the Chihuahua feed holds Ciudad Juárez
// (~350 km). kmFromMetro is what lets a card say so.
import { describe, expect, it } from 'vitest';

import { CITY_CENTROIDS } from '@/lib/city-centroids';
import type { Race } from '@/lib/races';
import { SEED_RACES } from '@/lib/races';
import { FAR_FROM_METRO_KM, getRegion, kmFromMetro, raceInRegion, raceLocation, REGIONS } from '@/lib/regions';

function race(over: Partial<Race>): Race {
  return { id: 'x', city: 'Monterrey', state: 'Nuevo León', start: null, ...over } as Race;
}

describe('raceLocation', () => {
  const mty = getRegion('mty');

  it('prefers the race’s own start pin', () => {
    const loc = raceLocation(race({ city: 'Montemorelos', start: { lat: 25.19, lng: -99.83 } }), mty);
    expect(loc).toEqual({ lat: 25.19, lng: -99.83, source: 'start' });
  });

  it('falls back to the sourced city centroid', () => {
    expect(raceLocation(race({ city: 'Montemorelos' }), mty).source).toBe('city');
  });

  it('falls back to the metro centre for a city it can’t place — never a guess', () => {
    expect(raceLocation(race({ city: 'Pueblo Inventado' }), mty)).toEqual({ lat: mty.lat, lng: mty.lng, source: 'region' });
  });
});

describe('kmFromMetro', () => {
  it('flags Torreón in the Saltillo feed at roughly its real distance', () => {
    const km = kmFromMetro(race({ city: 'Torreón', state: 'Coahuila' }), getRegion('slw'));
    expect(km).not.toBeNull();
    expect(km!).toBeGreaterThan(200);
    expect(km!).toBeLessThan(300);
  });

  it('flags Ciudad Juárez in the Chihuahua feed', () => {
    expect(kmFromMetro(race({ city: 'Ciudad Juárez', state: 'Chihuahua' }), getRegion('chih'))!).toBeGreaterThan(300);
  });

  it('leaves a race across town alone (San Pedro, Santiago NL)', () => {
    expect(kmFromMetro(race({ city: 'San Pedro Garza García' }), getRegion('mty'))).toBeNull();
    expect(kmFromMetro(race({ city: 'Santiago' }), getRegion('mty'))).toBeNull();
  });

  it('says nothing when the location is unknown — an unknown is not a distance', () => {
    expect(kmFromMetro(race({ city: 'Pueblo Inventado', state: 'Coahuila' }), getRegion('slw'))).toBeNull();
  });

  it('rounds to 10 km so the card never claims false precision', () => {
    const km = kmFromMetro(race({ city: 'Torreón', state: 'Coahuila' }), getRegion('slw'))!;
    expect(km % 10).toBe(0);
  });

  it('every flagged race in the seed is genuinely past the threshold', () => {
    for (const r of SEED_RACES) {
      const region = REGIONS.find((g) => raceInRegion(r, g));
      if (!region) continue;
      const km = kmFromMetro(r, region);
      if (km !== null) expect(km).toBeGreaterThanOrEqual(FAR_FROM_METRO_KM);
    }
  });
});

describe('CITY_CENTROIDS', () => {
  it('only holds coordinates inside Mexico', () => {
    for (const [key, [lat, lng]] of Object.entries(CITY_CENTROIDS)) {
      expect(lat, key).toBeGreaterThan(14);
      expect(lat, key).toBeLessThan(33);
      expect(lng, key).toBeGreaterThan(-118);
      expect(lng, key).toBeLessThan(-86);
    }
  });

  it('places every centroid within 450 km of its own state’s metro — a wrong-state match would not be', () => {
    for (const [key, [lat, lng]] of Object.entries(CITY_CENTROIDS)) {
      const state = key.split('|')[1];
      const region = REGIONS.find((g) => g.states.includes(state));
      if (!region) continue;
      const km = kmFromMetro(race({ city: key.split('|')[0], state, start: { lat, lng } }), region) ?? 0;
      expect(km, key).toBeLessThan(450);
    }
  });
});

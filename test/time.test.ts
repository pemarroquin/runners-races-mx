import { describe, expect, it } from 'vitest';

import racesJson from '@/assets/data/races.json';
import { instantInZone, timeZoneForState } from '@/lib/time';
import { nearestRegion, raceInRegion, REGIONS } from '@/lib/regions';
import type { Race } from '@/lib/races';

/**
 * What wall-clock time does the real IANA database report for `instant` in
 * `zone`? The offset table in src/lib/time.ts is hand-written precisely to
 * avoid depending on Intl at runtime — so the tests cross-check it against
 * Node's actual zone database, which is the thing it is standing in for.
 */
function readBackInZone(instant: Date, zone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(instant);
  return parts.replace(', ', ' ');
}

describe('timeZoneForState', () => {
  it('maps the three states that are not on Mexico City time', () => {
    expect(timeZoneForState('Baja California')).toBe('America/Tijuana');
    expect(timeZoneForState('Quintana Roo')).toBe('America/Cancun');
    expect(timeZoneForState('Chihuahua')).toBe('America/Chihuahua');
  });

  it('defaults the UTC-6 bloc to Mexico City', () => {
    for (const state of ['Nuevo León', 'Jalisco', 'Yucatán', 'Puebla', 'Coahuila']) {
      expect(timeZoneForState(state)).toBe('America/Mexico_City');
    }
  });

  it('defaults an unknown state rather than throwing', () => {
    expect(timeZoneForState('Oaxaca')).toBe('America/Mexico_City');
  });

  it('assigns a zone to every state in the dataset', () => {
    const states = new Set((racesJson.races as Race[]).map((r) => r.state));
    for (const state of states) expect(timeZoneForState(state)).toBeTruthy();
  });
});

describe('instantInZone', () => {
  // The bug: the event was built from the PHONE's local time, so a runner in
  // Tijuana adding a Cancun race got it two hours off.
  it('produces an instant that reads back as the intended local time', () => {
    const cases: [string, string, string][] = [
      ['2026-08-16', '07:00', 'America/Mexico_City'],
      ['2026-08-16', '07:00', 'America/Cancun'],
      ['2026-01-15', '06:30', 'America/Chihuahua'],
      ['2026-08-16', '07:00', 'America/Tijuana'],
      ['2026-12-13', '07:00', 'America/Tijuana'],
    ];
    for (const [date, time, zone] of cases) {
      expect(readBackInZone(instantInZone(date, time, zone as never), zone)).toBe(
        `${date} ${time}`,
      );
    }
  });

  // Baja California is the only Mexican state still observing DST, and it
  // follows US rules — the one place the offset table has to be conditional.
  it('gets both Tijuana daylight-saving boundaries right', () => {
    const boundaries: [string, string][] = [
      ['2027-03-13', '07:00'], // day before DST starts -> UTC-8
      ['2027-03-14', '07:00'], // second Sunday of March -> UTC-7
      ['2026-10-31', '07:00'], // still DST -> UTC-7
      ['2026-11-01', '07:00'], // first Sunday of November -> UTC-8
    ];
    for (const [date, time] of boundaries) {
      expect(
        readBackInZone(instantInZone(date, time, 'America/Tijuana'), 'America/Tijuana'),
        `${date} ${time}`,
      ).toBe(`${date} ${time}`);
    }
  });

  it('differs across zones for the same wall-clock time', () => {
    const cancun = instantInZone('2026-08-16', '07:00', 'America/Cancun');
    const mexico = instantInZone('2026-08-16', '07:00', 'America/Mexico_City');
    // Cancun is UTC-5 and Mexico City UTC-6, so 07:00 happens an hour earlier.
    expect(mexico.getTime() - cancun.getTime()).toBe(60 * 60 * 1000);
  });
});

describe('regions', () => {
  it('gives every region at least one state and a unique id', () => {
    const ids = new Set(REGIONS.map((r) => r.id));
    expect(ids.size).toBe(REGIONS.length);
    for (const region of REGIONS) expect(region.states.length).toBeGreaterThan(0);
  });

  it('places every race in the dataset into exactly one region', () => {
    for (const race of racesJson.races as Race[]) {
      const matches = REGIONS.filter((r) => raceInRegion(race, r));
      expect(matches.length, `${race.id} (${race.state})`).toBe(1);
    }
  });

  it('resolves a coordinate to its nearest metro', () => {
    expect(nearestRegion(25.6866, -100.3161)?.id).toBe('mty'); // Monterrey
    expect(nearestRegion(19.4326, -99.1332)?.id).toBe('cdmx'); // CDMX
    expect(nearestRegion(21.1619, -86.8515)?.id).toBe('cun'); // Cancún
  });

  // Returning null rather than the default is what stops the app telling
  // someone in Madrid that they are in Monterrey.
  it('returns null when nothing is within range', () => {
    expect(nearestRegion(40.4168, -3.7038)).toBeNull(); // Madrid
    expect(nearestRegion(-33.8688, 151.2093)).toBeNull(); // Sydney
  });
});

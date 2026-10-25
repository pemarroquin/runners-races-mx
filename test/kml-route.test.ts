// The KML route-line maths behind scripts/import-route-kml.mjs. The length
// check is the safety that keeps the WRONG line (a 5K drawn on the same map, a
// warm-up loop) out of races.json, so it gets the most attention here.
import { describe, expect, it } from 'vitest';

import {
  distanceKmFromLabel,
  haversineM,
  lengthKm,
  myMapsId,
  parseKmlLines,
  pickBestLine,
  round5,
  simplify,
} from '../scripts/lib/kml-route.mjs';

type LatLng = [number, number];

/** A straight line due north of `start`, `km` long, sampled every ~10 m. */
function northLine(start: LatLng, km: number): LatLng[] {
  const steps = Math.round(km * 100);
  const dLat = km / 111.195 / steps;
  return Array.from({ length: steps + 1 }, (_, i) => [start[0] + i * dLat, start[1]] as LatLng);
}

function kml(lines: { name: string; coords: LatLng[] }[]): string {
  const pm = lines
    .map(
      (l) =>
        `<Placemark><name>${l.name}</name><LineString><tessellate>1</tessellate><coordinates>\n` +
        l.coords.map(([lat, lng]) => `${lng},${lat},0`).join('\n') +
        `\n</coordinates></LineString></Placemark>`,
    )
    .join('');
  return `<?xml version="1.0"?><kml><Document><Placemark><name>K1</name><Point><coordinates>-99.8,25.1,0</coordinates></Point></Placemark>${pm}</Document></kml>`;
}

describe('parseKmlLines', () => {
  it('reads every LineString as [lat, lng] and ignores point placemarks', () => {
    const lines = parseKmlLines(kml([{ name: 'MMM2026', coords: [[25.1, -99.8], [25.2, -99.9]] }]));
    expect(lines).toHaveLength(1);
    expect(lines[0].name).toBe('MMM2026');
    // KML stores lng,lat — the app stores [lat, lng]. Swapping these puts the
    // course in Antarctica, which is exactly why it's tested.
    expect(lines[0].coords).toEqual([[25.1, -99.8], [25.2, -99.9]]);
  });

  it('returns nothing for a pins-only map', () => {
    expect(parseKmlLines(kml([]))).toEqual([]);
  });
});

describe('lengthKm / haversineM', () => {
  it('measures a line to within a few metres', () => {
    expect(lengthKm(northLine([25.19, -99.83], 10))).toBeCloseTo(10, 1);
  });
  it('one degree of latitude is ~111.2 km', () => {
    expect(haversineM([0, 0], [1, 0]) / 1000).toBeCloseTo(111.2, 0);
  });
});

describe('distanceKmFromLabel', () => {
  it.each([
    ['21K', 21.0975],
    ['Half', 21.0975],
    ['42K', 42.195],
    ['Full', 42.195],
    ['10K', 10],
    ['2.5K', 2.5],
    ['3K caminata', 3],
    ['Infantil', null],
  ])('%s -> %s', (label, km) => {
    expect(distanceKmFromLabel(label)).toBe(km);
  });
});

describe('pickBestLine', () => {
  const half = northLine([25.19, -99.83], 21.19); // Montemorelos measured 21.19 km
  const five = northLine([25.19, -99.83], 5.4);

  it('picks the line that matches an advertised distance, with its error', () => {
    const best = pickBestLine(
      [
        { name: '5K', coords: five },
        { name: '21K', coords: half },
      ],
      [21.0975],
    )!;
    expect(best.line.name).toBe('21K');
    expect(best.error).toBeLessThan(0.03);
  });

  it('reports a large error when no line fits, so the importer can refuse', () => {
    const best = pickBestLine([{ name: 'warm-up', coords: five }], [21.0975])!;
    expect(best.error).toBeGreaterThan(0.03);
  });

  it('is null with no lines', () => {
    expect(pickBestLine([], [10])).toBeNull();
  });
});

describe('simplify', () => {
  it('collapses a straight line to its endpoints', () => {
    const line = northLine([25.19, -99.83], 2);
    expect(simplify(line, 5)).toEqual([line[0], line[line.length - 1]]);
  });

  it('keeps a real corner and both ends exact', () => {
    const out = northLine([25.19, -99.83], 1);
    const corner = out[out.length - 1];
    const east: LatLng[] = Array.from({ length: 50 }, (_, i) => [corner[0], corner[1] + (i + 1) * 0.0001]);
    const s = simplify([...out, ...east], 5);
    expect(s[0]).toEqual(out[0]);
    expect(s).toContainEqual(corner);
    expect(s[s.length - 1]).toEqual(east[east.length - 1]);
    expect(s).toHaveLength(3);
  });

  it('barely changes the measured length of a wiggly course', () => {
    const wiggle: LatLng[] = Array.from({ length: 400 }, (_, i) => [25.19 + i * 0.0001, -99.83 + Math.sin(i / 8) * 0.002]);
    const before = lengthKm(wiggle);
    expect(Math.abs(lengthKm(simplify(wiggle, 5)) - before) / before).toBeLessThan(0.01);
  });
});

describe('round5', () => {
  it('rounds to 5 decimals', () => {
    expect(round5([[25.1893612, -99.8267734]])).toEqual([[25.18936, -99.82677]]);
  });
});

describe('myMapsId', () => {
  it('pulls the mid out of an edit or viewer URL, or accepts a bare id', () => {
    expect(myMapsId('https://www.google.com/maps/d/edit?mid=1B1qd0uO8zqnl4DhkWIO9Ou8MPobVsaY')).toBe(
      '1B1qd0uO8zqnl4DhkWIO9Ou8MPobVsaY',
    );
    expect(myMapsId('https://www.google.com/maps/d/viewer?hl=es&mid=1B1qd0uO8zqnl4DhkWIO9Ou8MPobVsaY&ll=1,2')).toBe(
      '1B1qd0uO8zqnl4DhkWIO9Ou8MPobVsaY',
    );
    expect(myMapsId('1B1qd0uO8zqnl4DhkWIO9Ou8MPobVsaY')).toBe('1B1qd0uO8zqnl4DhkWIO9Ou8MPobVsaY');
    expect(myMapsId('https://maps.app.goo.gl/abc')).toBeNull();
  });
});

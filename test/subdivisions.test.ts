// City subdivisions as arenas, against the real bundled Monterrey data.
// The contract that matters: every tile counts in exactly one subdivision,
// and the server-side district filter never drops a tile that counts.
import { cellToChildren, latLngToCell, polygonToCells } from 'h3-js';
import { describe, expect, it } from 'vitest';

import { districtOfCell } from '../src/lib/district';
import {
  BUNDLED_SUBDIVISIONS,
  arenasFor,
  coveringDistricts,
  parseSubdivisions,
  subdivisionArena,
  subdivisionAt,
  subdivisionOfCell,
} from '../src/lib/subdivisions';

const MTY = BUNDLED_SUBDIVISIONS.mty;
const byName = (name: string) => MTY.find((s) => s.name === name)!;

describe('bundled data', () => {
  it('has the ten most populated Monterrey municipios, largest first', () => {
    expect(MTY).toHaveLength(10);
    expect(MTY[0].name).toBe('Monterrey');
    expect(MTY.map((s) => s.name)).toContain('San Pedro Garza García');
    for (let i = 1; i < MTY.length; i++) expect(MTY[i - 1].population).toBeGreaterThanOrEqual(MTY[i].population);
  });
});

describe('subdivisionAt', () => {
  it('places known landmarks in the right municipio', () => {
    expect(subdivisionAt(MTY, 25.6696, -100.3097)?.name).toBe('Monterrey'); // Macroplaza
    expect(subdivisionAt(MTY, 25.6538, -100.4033)?.name).toBe('San Pedro Garza García'); // Calzada del Valle
    expect(subdivisionAt(MTY, 25.7298, -100.3108)?.name).toBe('San Nicolás de los Garza'); // UANL campus
  });

  it('is null far from every outline', () => {
    expect(subdivisionAt(MTY, 19.4326, -99.1332)).toBeNull(); // CDMX
  });
});

describe('exactly one subdivision per tile', () => {
  // A sample of real res-12 tiles across the metro: the children of res-8
  // cells along a line from San Pedro through downtown to Apodaca, which
  // crosses several municipal borders.
  const line = Array.from({ length: 40 }, (_, i) => {
    const t = i / 39;
    return latLngToCell(25.65 + t * (25.78 - 25.65), -100.42 + t * (-100.19 + 100.42), 8);
  });
  const tiles = [...new Set(line)].flatMap((c) => cellToChildren(c, 12).filter((_, i) => i % 7 === 0));
  const arenas = MTY.map((s) => subdivisionArena(s, MTY));

  it('never counts a tile twice', () => {
    for (const h3 of tiles) {
      expect(arenas.filter((a) => a.contains(h3)).length).toBeLessThanOrEqual(1);
    }
  });

  it('counts a tile exactly where subdivisionOfCell puts it', () => {
    for (const h3 of tiles) {
      const owner = subdivisionOfCell(MTY, h3);
      for (const a of arenas) expect(a.contains(h3)).toBe(a.key === owner?.id);
    }
  });

  it('crosses at least three municipios on the sample line', () => {
    const hit = new Set(tiles.map((h3) => subdivisionOfCell(MTY, h3)?.name).filter(Boolean));
    expect(hit.size).toBeGreaterThanOrEqual(3);
  });

  it('rejects tiles not at the tile resolution', () => {
    expect(subdivisionOfCell(MTY, latLngToCell(25.6696, -100.3097, 11))).toBeNull();
  });
});

describe('coveringDistricts', () => {
  it('covers every tile that counts in the subdivision, including edge tiles', () => {
    const sp = byName('San Pedro Garza García');
    const cover = new Set(coveringDistricts(sp.geometry));
    // Every res-9 cell in San Pedro's bounding box, expanded to tiles at a
    // stride — edge tiles are the ones the truncation parent can miss.
    const bbox = [
      [-100.47, 25.61],
      [-100.33, 25.61],
      [-100.33, 25.69],
      [-100.47, 25.69],
      [-100.47, 25.61],
    ];
    const tiles = polygonToCells(bbox, 9, true).flatMap((c) => cellToChildren(c, 12).filter((_, i) => i % 97 === 0));
    let counted = 0;
    for (const h3 of tiles) {
      if (subdivisionOfCell(MTY, h3)?.id !== sp.id) continue;
      counted++;
      expect(cover.has(districtOfCell(h3)!)).toBe(true);
    }
    expect(counted).toBeGreaterThan(100);
  });
});

describe('subdivisionArena', () => {
  it("sizes San Pedro near the 228k tiles measured for its area", () => {
    const total = subdivisionArena(byName('San Pedro Garza García'), MTY).totalCells;
    expect(total).toBeGreaterThan(200_000);
    expect(total).toBeLessThan(260_000);
  });
});

describe('arenasFor', () => {
  it('starts inside the subdivision you stand in, then the rest nearest first', () => {
    const list = arenasFor(MTY, { lat: 25.6538, lng: -100.4033 });
    expect(list[0].name).toBe('San Pedro Garza García');
    expect(list).toHaveLength(10);
    expect(new Set(list.map((a) => a.key)).size).toBe(10);
  });

  it('falls back to your district outside every subdivision, still listing the city', () => {
    const list = arenasFor(MTY, { lat: 25.588, lng: -99.998 }); // Cadereyta, 11th
    expect(list[0].kind).toBe('district');
    expect(list).toHaveLength(11);
  });

  it('is just your district in a city with no subdivisions', () => {
    const list = arenasFor([], { lat: 19.4326, lng: -99.1332 });
    expect(list).toHaveLength(1);
    expect(list[0].kind).toBe('district');
  });
});

describe('parseSubdivisions', () => {
  it('rejects junk', () => {
    expect(parseSubdivisions(null)).toBeNull();
    expect(parseSubdivisions({ regions: {} })).toBeNull();
    expect(parseSubdivisions({ regions: { mty: [{ id: 'x' }] } })).toBeNull();
  });

  it('drops a region with any bad record rather than keeping part of it', () => {
    const good = MTY[0];
    const parsed = parseSubdivisions({ regions: { mty: [good, { id: 'bad' }], gdl: [good] } });
    expect(parsed?.mty).toBeUndefined();
    expect(parsed?.gdl).toHaveLength(1);
  });
});

describe('district read filters', () => {
  it('builds one like-clause per district, with the verified prefix', async () => {
    const { districtCellPattern, districtsOrFilter, districtChunks, DISTRICTS_PER_REQUEST } = await import(
      '../src/lib/district'
    );
    const a = districtOfCell(latLngToCell(25.6696, -100.3097, 12))!;
    const b = districtOfCell(latLngToCell(25.6538, -100.4033, 12))!;
    expect(districtsOrFilter([a, b])).toBe(
      `h3.like.${districtCellPattern(a)}*,h3.like.${districtCellPattern(b)}*`,
    );
    const many = Array.from({ length: DISTRICTS_PER_REQUEST * 2 + 3 }, () => a);
    const chunks = districtChunks(many);
    expect(chunks.map((c) => c.length)).toEqual([DISTRICTS_PER_REQUEST, DISTRICTS_PER_REQUEST, 3]);
  });
});

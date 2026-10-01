// Extract each city's most populated subdivisions for the leaderboard's
// place switcher: `npm run extract-subdivisions`.
//
// For every region in regions.ts with a `subdivisions` config:
//   1. Overpass lists the admin boundaries at that level inside the parent
//      area, with their `population` tag.
//   2. The TOP_SUBDIVISIONS most populated are kept. Boundaries with no
//      population tag are printed, never silently dropped: check that none
//      of them belongs in the top list before committing.
//   3. Nominatim returns each one's outline as simplified GeoJSON, which
//      saves stitching raw OSM ways into rings.
//
// Writes assets/data/subdivisions.json, which the app bundles and refreshes
// from GitHub the same way it does races.json.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { REGIONS, TOP_SUBDIVISIONS } from '../src/lib/regions';

const OUT = join(__dirname, '..', 'assets', 'data', 'subdivisions.json');
// Identifies the app, as both services' usage policies ask. No personal
// contact goes in here.
const USER_AGENT = 'runners-races-mx subdivision extraction (github.com/pemarroquin/runners-races-mx)';
// ~10 m. Neighbouring outlines are simplified independently, so they can
// leave slivers between them; subdivisions.ts assigns a tile in a sliver to
// the nearest outline, and 10 m keeps every sliver under a tile's width.
const SIMPLIFY_DEG = 0.0001;

// See extract-park-paths.ts: Overpass rate-limits hard and the main
// instance stops answering, so mirrors are tried in turn.
const MIRRORS = [
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

async function overpass<T>(query: string, attempt = 0): Promise<T> {
  let lastError: unknown = new Error('no mirrors tried');
  for (const url of MIRRORS) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        body: new URLSearchParams({ data: query }),
        headers: { 'User-Agent': USER_AGENT },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as T;
    } catch (e) {
      lastError = e;
      console.log(`    ${new URL(url).host}: ${e instanceof Error ? e.message : e}`);
    }
  }
  if (attempt >= 2) throw lastError;
  await new Promise((r) => setTimeout(r, 30_000 * (attempt + 1)));
  return overpass<T>(query, attempt + 1);
}

type Geometry =
  | { type: 'Polygon'; coordinates: number[][][] }
  | { type: 'MultiPolygon'; coordinates: number[][][][] };

const round = (n: number) => Math.round(n * 1e5) / 1e5;
function roundGeometry(g: Geometry): Geometry {
  const ring = (r: number[][]) => r.map(([lng, lat]) => [round(lng), round(lat)]);
  return g.type === 'Polygon'
    ? { type: 'Polygon', coordinates: g.coordinates.map(ring) }
    : { type: 'MultiPolygon', coordinates: g.coordinates.map((p) => p.map(ring)) };
}

async function main() {
  const out: Record<string, unknown[]> = {};
  for (const region of REGIONS) {
    const cfg = region.subdivisions;
    if (!cfg) continue;
    console.log(`${region.name}: admin_level ${cfg.adminLevel} inside ${cfg.within.name}`);

    const listed = await overpass<{ elements: { id: number; tags: Record<string, string> }[] }>(
      `[out:json][timeout:120];
area["name"="${cfg.within.name}"]["admin_level"="${cfg.within.adminLevel}"]->.a;
rel(area.a)["boundary"="administrative"]["admin_level"="${cfg.adminLevel}"];
out tags;`,
    );
    const candidates = listed.elements.map((e) => ({
      osmId: e.id,
      name: e.tags.name,
      population: Number(String(e.tags.population ?? '').replace(/[^\d]/g, '')) || 0,
    }));
    const untagged = candidates.filter((c) => c.population === 0).map((c) => c.name);
    if (untagged.length > 0) {
      console.log(`  no population tag (check none belongs in the top ${TOP_SUBDIVISIONS}): ${untagged.join(', ')}`);
    }
    const top = candidates
      .filter((c) => c.population > 0)
      .sort((a, b) => b.population - a.population)
      .slice(0, TOP_SUBDIVISIONS);
    if (top.length === 0) throw new Error(`${region.name}: no populated subdivisions found`);

    const ids = top.map((c) => `R${c.osmId}`).join(',');
    const res = await fetch(
      `https://nominatim.openstreetmap.org/lookup?osm_ids=${ids}&format=json&polygon_geojson=1&polygon_threshold=${SIMPLIFY_DEG}`,
      { headers: { 'User-Agent': USER_AGENT } },
    );
    if (!res.ok) throw new Error(`Nominatim HTTP ${res.status}`);
    const shapes = (await res.json()) as { osm_id: number; geojson: Geometry }[];
    const byId = new Map(shapes.map((s) => [s.osm_id, s.geojson]));

    out[region.id] = top.map((c) => {
      const geometry = byId.get(c.osmId);
      if (!geometry || (geometry.type !== 'Polygon' && geometry.type !== 'MultiPolygon')) {
        throw new Error(`${c.name}: Nominatim returned no polygon`);
      }
      console.log(`  ${c.population.toLocaleString('en')}  ${c.name}`);
      return { id: `osm-r${c.osmId}`, name: c.name, population: c.population, geometry: roundGeometry(geometry) };
    });
  }

  writeFileSync(
    OUT,
    `${JSON.stringify({ _meta: { source: 'OpenStreetMap (ODbL)', extracted: new Date().toISOString().slice(0, 10) }, regions: out })}\n`,
  );
  console.log(`wrote ${OUT}`);
}

void main();

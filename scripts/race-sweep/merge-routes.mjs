// 2027 sweep, shared route pass: writes `start` (and courseMapUrl/routeCoords if ever supplied)
// from found/routes-<State>.json onto existing rows. No other field is touched.
// usage: node merge-routes.mjs <before.json> <out races.json> <found-dir>
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';

const [,, beforePath, racesPath, foundDir] = process.argv;
const doc = JSON.parse(readFileSync(beforePath, 'utf8'));
const byId = new Map(doc.races.map((r) => [r.id, r]));

// Only a start the page labels as the start address is exact; every other pin is the event's
// venue / directions pin and stays approx (schema.md: approx = venue centroid, not the start line).
const EXACT = new Set(['cancun-marathon-2026']);

let filled = 0, nulls = 0;
const files = readdirSync(foundDir).filter((f) => f.startsWith('routes-') && f.endsWith('.json'));
for (const f of files) {
  for (const it of JSON.parse(readFileSync(`${foundDir}/${f}`, 'utf8'))) {
    const row = byId.get(it.id);
    if (!row) throw new Error(`unknown id ${it.id}`);
    if (!it.start && !it.courseMapUrl && !it.routeCoords) { nulls++; continue; }
    if (it.start) {
      const { lat, lng } = it.start;
      if (typeof lat !== 'number' || typeof lng !== 'number' || Math.abs(lat) > 90 || Math.abs(lng) > 180) throw new Error(`bad start ${it.id}`);
      if (row.start) throw new Error(`row already has start ${it.id}`);
      row.start = EXACT.has(row.id) ? { lat, lng } : { lat, lng, approx: true };
    }
    if (it.courseMapUrl) row.courseMapUrl = it.courseMapUrl;
    if (it.routeCoords) row.routeCoords = it.routeCoords;
    filled++;
  }
}
doc._meta.description += ' 2027 route pass 2026-10-24: start pins for rows added in the 2027 sweep.';
writeFileSync(racesPath, JSON.stringify(doc, null, 2) + '\n');
console.log(`filled ${filled}, left null ${nulls}`);

#!/usr/bin/env node
// Import a race's course line from a Google My Maps link into races.json.
//
// Usage:
//   npm run import-route -- <raceId> <my-maps-url-or-mid> [--distance 21K] [--dry-run]
//
// Writes `routeCoords` ([lat, lng], Douglas-Peucker at 5 m, 5 decimals) and,
// when the race has no exact start, sets `start` to the line's first point —
// but only if that point is within 300 m of the existing approx pin (or there
// is no pin): further than that and the line or the pin is wrong, and a human
// should look before either one is trusted.
//
// REFUSES to write when the line's measured length is more than 3% off the
// advertised distance. The wrong line (a 5K drawn on the same map, a warm-up
// loop, an old edition) looks exactly as plausible as the right one on screen.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  distanceKmFromLabel,
  haversineM,
  myMapsId,
  parseKmlLines,
  pickBestLine,
  round5,
  simplify,
} from './lib/kml-route.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_PATH = resolve(ROOT, 'assets/data/races.json');
const MAX_LENGTH_ERROR = 0.03;
const MAX_START_SHIFT_M = 300;
const SIMPLIFY_TOLERANCE_M = 5;

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const distIdx = args.indexOf('--distance');
const distanceArg = distIdx !== -1 ? args[distIdx + 1] : null;
const [raceId, mapRef] = args.filter((a, i) => !a.startsWith('--') && (distIdx === -1 || i !== distIdx + 1));

function fail(msg) {
  console.error(`import-route-kml: ${msg}`);
  process.exit(1);
}

if (!raceId || !mapRef) fail('usage: import-route-kml.mjs <raceId> <my-maps-url-or-mid> [--distance 21K] [--dry-run]');
const mid = myMapsId(mapRef);
if (!mid) fail(`not a Google My Maps link or id: ${mapRef}`);

const doc = JSON.parse(readFileSync(DATA_PATH, 'utf8'));
const race = doc.races.find((r) => r.id === raceId);
if (!race) fail(`no race with id ${raceId}`);

const labels = distanceArg ? [distanceArg] : race.distances;
const targets = [...new Set(labels.map(distanceKmFromLabel).filter((km) => km !== null))];
if (targets.length === 0) fail(`no usable distance in ${JSON.stringify(labels)} — pass --distance`);

const kmlUrl = `https://www.google.com/maps/d/kml?mid=${mid}&forcekml=1`;
const res = await fetch(kmlUrl, { signal: AbortSignal.timeout(20_000) });
if (!res.ok) fail(`${kmlUrl} answered HTTP ${res.status}`);
const lines = parseKmlLines(await res.text());
if (lines.length === 0) fail('the map has no line in it (only pins?) — nothing to import');

const best = pickBestLine(lines, targets);
console.log(
  `${lines.length} line(s); best "${best.line.name ?? '(unnamed)'}": ${best.line.coords.length} points, ` +
    `${best.km.toFixed(2)} km measured vs ${best.targetKm} km advertised (${(best.error * 100).toFixed(1)}% off)`,
);
if (best.error > MAX_LENGTH_ERROR) {
  fail(`measured length is more than ${MAX_LENGTH_ERROR * 100}% off the advertised distance — not writing`);
}

const coords = round5(simplify(best.line.coords, SIMPLIFY_TOLERANCE_M));
console.log(`simplified to ${coords.length} points at ${SIMPLIFY_TOLERANCE_M} m`);

const first = coords[0];
let startNote = 'start unchanged (already exact)';
if (!race.start || race.start.approx) {
  const shift = race.start ? haversineM([race.start.lat, race.start.lng], first) : 0;
  if (race.start && shift > MAX_START_SHIFT_M) {
    startNote = `start NOT moved: the line begins ${Math.round(shift)} m from the existing pin (max ${MAX_START_SHIFT_M}) — check which is right`;
  } else {
    startNote = race.start
      ? `start set to the line's first point (${Math.round(shift)} m from the old pin)`
      : "start set to the line's first point (there was no pin)";
    if (!dryRun) race.start = { lat: first[0], lng: first[1] };
  }
}
console.log(startNote);

if (dryRun) {
  console.log('dry run, nothing written');
} else {
  race.routeCoords = coords;
  const line = `Course line imported from Google My Maps (mid=${mid}): ${best.km.toFixed(2)} km measured vs ${best.targetKm} km advertised.`;
  race.sourceNotes = race.sourceNotes ? `${race.sourceNotes} ${line}` : line;
  writeFileSync(DATA_PATH, JSON.stringify(doc, null, 2) + '\n');
  console.log(`wrote routeCoords for ${raceId}`);
}

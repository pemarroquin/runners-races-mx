#!/usr/bin/env node
// Write official course maps into races.json from Asdeporte's /ruta pages.
//
// Why a script and not an agent: the 2026-10-24 route pass (an agent) read
// each event's `datos-del-evento` page, never the `/ruta` tab, and reported
// "no course map" for all 8 races that already had one. The tab is
// server-rendered with deterministic CloudFront filenames, so this is a
// fetch-and-regex job that gives the same answer every time it runs.
//
// Maps go up 20-111 days before race day (median 53), so this runs on a
// schedule (.github/workflows/course-maps.yml), not once.
//
// Additive only: existing courseMaps entries are never removed or rewritten.
//
// Usage:
//   npm run course-maps                       # every upcoming Asdeporte race
//   npm run course-maps -- --within-days 60   # only races in the next 60 days
//   npm run course-maps -- --dry-run          # report, write nothing
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { asdeporteEventBase, extractCourseMapImages, mergeCourseMaps } from './lib/course-map-parse.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_PATH = resolve(ROOT, 'assets/data/races.json');
const CONCURRENCY = 4;
const TIMEOUT_MS = 20_000;
const UA = 'Mozilla/5.0 (compatible; runners-races-mx course-map check; +https://runningapp.pmarroquin.com)';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const withinIdx = args.indexOf('--within-days');
const withinDays = withinIdx !== -1 ? Number(args[withinIdx + 1]) : null;
if (withinIdx !== -1 && !(withinDays >= 0)) {
  console.error('--within-days needs a non-negative number');
  process.exit(2);
}

// Mexico City date, not UTC: a race dated today is still in the window at
// 7 pm in Monterrey, when UTC has already rolled over.
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City' }).format(new Date());
const horizon =
  withinDays === null ? null : new Date(Date.parse(today) + withinDays * 86_400_000).toISOString().slice(0, 10);

const raw = readFileSync(DATA_PATH, 'utf8');
const doc = JSON.parse(raw);

const targets = doc.races
  .filter((r) => r.date && r.date >= today && (horizon === null || r.date <= horizon))
  .map((r) => ({ race: r, base: asdeporteEventBase(r) }))
  .filter((t) => t.base);

async function fetchRuta(base) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${base}/ruta`, { headers: { 'User-Agent': UA }, signal: controller.signal });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    return { html: await res.text() };
  } catch (e) {
    return { error: e.name === 'AbortError' ? 'timeout' : String(e.message || e).slice(0, 60) };
  } finally {
    clearTimeout(timer);
  }
}

const results = [];
let next = 0;
async function worker() {
  while (next < targets.length) {
    const t = targets[next++];
    results.push({ ...t, ...(await fetchRuta(t.base)) });
  }
}
await Promise.all(Array.from({ length: Math.min(CONCURRENCY, targets.length) }, worker));

let racesChanged = 0;
let mapsAdded = 0;
let errors = 0;
for (const { race, base, html, error } of results.sort((a, b) => a.race.date.localeCompare(b.race.date))) {
  if (error) {
    errors++;
    console.warn(`  skip  ${race.id}: ${error}`);
    continue;
  }
  const found = extractCourseMapImages(html);
  if (found.length === 0) continue;
  const { list, added } = mergeCourseMaps(race.courseMaps, found);
  if (added === 0) continue;
  racesChanged++;
  mapsAdded += added;
  console.log(`  +${added}  ${race.id} (${race.date})`);
  for (const m of list.slice(list.length - added)) console.log(`        ${m.kind} ${m.distance ?? '-'}  ${m.url}`);
  if (dryRun) continue;
  race.courseMaps = list;
  const uploaded = found.map((f) => f.uploadedAt).sort()[0];
  const line = `Course maps from ${base}/ruta (uploaded ${uploaded}), added ${today} by fetch-course-maps.`;
  race.sourceNotes = race.sourceNotes ? `${race.sourceNotes} ${line}` : line;
}

console.log(
  `\nfetch-course-maps: ${targets.length} Asdeporte races checked${horizon ? ` (through ${horizon})` : ''}, ` +
    `${mapsAdded} maps added to ${racesChanged} races, ${errors} fetch errors${dryRun ? ' (dry run, nothing written)' : ''}.`,
);

if (!dryRun && racesChanged > 0) writeFileSync(DATA_PATH, JSON.stringify(doc, null, 2) + '\n');
// A run where EVERY fetch failed is an outage or a block, not "no new maps" —
// say so loudly instead of exiting green with nothing to show.
if (targets.length > 0 && errors === targets.length) {
  console.error('fetch-course-maps: every request failed — Asdeporte unreachable or blocking us');
  process.exit(1);
}

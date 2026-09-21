#!/usr/bin/env npx vite-node
// Measures detectLaps (src/lib/laps.ts) against REAL recorded runs, so
// MIN_SEPARATION_CELLS / MIN_REPEATED_CELLS / MIN_REPEAT_FRACTION can be
// tuned against actual loop data rather than guessed — the same discipline
// measure-holes.ts and verify-claims.ts already apply to their own
// constants (MAX_NOISE_HOLE_CELLS, OFF_PATH_MARGIN_M).
//
// Per run: distance, laps, repeatedCells.length, repeatFraction, and
// whether it qualifies today. Also prints the distribution of
// repeatFraction across every run that has ANY repeated cells at all — the
// same "show the empty band the constant has to sit in" shape as
// measure-holes' bucket table — so MIN_REPEAT_FRACTION (0.6) can be checked
// against where real out-and-backs, figure-8s, and genuine loop-repeats
// actually land, not just synthetic fixtures (test/laps.test.ts).
//
// IMPORTANT CAVEAT, same shape as verify-claims.ts's OFF_PATH_MARGIN_M: this
// reads `runs.raw_path`, which is the PRIVACY-MASKED path (privacy-zone.ts
// trims ~200-350m off each end before it is ever stored — see
// territory-sync.ts's uploadRun). The UNMASKED path never leaves the device
// and cannot be read back here. For a runner who starts and finishes at
// home, masking is exactly where an out-and-back or a home-loop closes, so
// every number this script reports is a LOWER BOUND on the true
// laps/repeatedCells/repeatFraction detectLaps would see on-device — never
// an overcount. Treat a run this script says does NOT qualify as
// "did not qualify on the stored path"; it may still have qualified on the
// full one. See territory-sync.ts's own comment on this same limitation for
// why it was not silently worked around in this pass.
//
// Read-only. Anon key and the read-all policies, same posture as
// measure-holes.ts/verify-claims.ts — it cannot modify anything.
//
//   npm run measure-laps                  # every run with a stored path
//   npm run measure-laps -- --json
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { detectLaps, MIN_REPEAT_FRACTION, MIN_REPEATED_CELLS } from '@/lib/laps';
import type { TimedPoint } from '@/lib/gap-policy';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function env(name: string): string {
  const raw = readFileSync(path.join(ROOT, '.env.local'), 'utf8');
  const line = raw.split('\n').find((l) => l.startsWith(`${name}=`));
  const value = line?.slice(name.length + 1).trim().replace(/^["']|["']$/g, '');
  if (!value) throw new Error(`${name} missing from .env.local`);
  return value;
}

const URL_BASE = env('EXPO_PUBLIC_SUPABASE_URL');
const ANON = env('EXPO_PUBLIC_SUPABASE_ANON_KEY');

/** Every row, following PostgREST's 1000-row page cap — a truncated
 *  measurement would silently under-sample runs, which is the direction
 *  that would justify too permissive a set of constants. */
async function restAll<T>(table: string, select: string, order: string): Promise<T[]> {
  const out: T[] = [];
  for (let offset = 0; ; offset += 1000) {
    const res = await fetch(
      `${URL_BASE}/rest/v1/${table}?select=${select}&order=${order}&limit=1000&offset=${offset}`,
      { headers: { apikey: ANON, Authorization: `Bearer ${ANON}` } },
    );
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    const page = (await res.json()) as T[];
    out.push(...page);
    if (page.length < 1000) return out;
  }
}

/** Size buckets for the repeatFraction distribution table — spans the range
 *  MIN_REPEAT_FRACTION has to be chosen within. */
function bucketOf(fraction: number): string {
  if (fraction < 0.1) return '0.0-0.1';
  if (fraction < 0.2) return '0.1-0.2';
  if (fraction < 0.3) return '0.2-0.3';
  if (fraction < 0.4) return '0.3-0.4';
  if (fraction < 0.5) return '0.4-0.5';
  if (fraction < 0.6) return '0.5-0.6';
  if (fraction < 0.8) return '0.6-0.8';
  return '0.8-1.0';
}

async function main() {
  const asJson = process.argv.includes('--json');

  const runs = await restAll<{
    id: string;
    started_at: string;
    distance_m: number;
    raw_path: [number, number, number][] | null;
  }>('runs', 'id,started_at,distance_m,raw_path', 'started_at.asc');

  type Row = {
    id: string;
    startedAt: string;
    distanceM: number;
    laps: number;
    repeatedCells: number;
    distinctCells: number;
    repeatFraction: number;
    qualifies: boolean;
  };
  const rows: Row[] = [];
  let noPath = 0;

  for (const run of runs) {
    if (!Array.isArray(run.raw_path) || run.raw_path.length === 0) {
      noPath++;
      continue;
    }
    const points: TimedPoint[] = run.raw_path.map(([lat, lng, ts]) => ({ lat, lng, ts }));
    const result = detectLaps(points);
    const distinctCells = result.repeatFraction > 0 ? Math.round(result.repeatedCells.length / result.repeatFraction) : 0;
    rows.push({
      id: run.id,
      startedAt: run.started_at,
      distanceM: run.distance_m,
      laps: result.laps,
      repeatedCells: result.repeatedCells.length,
      distinctCells,
      repeatFraction: result.repeatFraction,
      qualifies: result.qualifies,
    });
  }

  if (asJson) {
    console.log(JSON.stringify({ runs: runs.length, noPath, rows }, null, 2));
    return;
  }

  console.log(`\n${runs.length} run(s) total, ${noPath} with no stored path (skipped)`);
  console.log(
    `constants in force: MIN_SEPARATION_CELLS, MIN_REPEATED_CELLS=${MIN_REPEATED_CELLS}, MIN_REPEAT_FRACTION=${MIN_REPEAT_FRACTION}\n`,
  );

  for (const r of rows) {
    console.log(
      `  ${r.startedAt.slice(0, 10)} ${r.id.slice(0, 8)}  ${String(r.distanceM).padStart(6)}m  ` +
        `laps ${String(r.laps).padStart(2)}  repeated ${String(r.repeatedCells).padStart(4)}/${String(r.distinctCells).padStart(4)}  ` +
        `frac ${r.repeatFraction.toFixed(3)}  ${r.qualifies ? 'QUALIFIES' : ''}`,
    );
  }

  const withRepeats = rows.filter((r) => r.repeatedCells > 0);
  console.log(`\n${withRepeats.length} of ${rows.length} run(s) have at least one repeated cell.`);
  if (withRepeats.length > 0) {
    const buckets = new Map<string, number>();
    for (const r of withRepeats) buckets.set(bucketOf(r.repeatFraction), (buckets.get(bucketOf(r.repeatFraction)) ?? 0) + 1);
    console.log('\nrepeatFraction distribution (runs with >=1 repeated cell):');
    for (const key of ['0.0-0.1', '0.1-0.2', '0.2-0.3', '0.3-0.4', '0.4-0.5', '0.5-0.6', '0.6-0.8', '0.8-1.0']) {
      const n = buckets.get(key) ?? 0;
      if (n > 0) console.log(`    ${key.padEnd(10)} ${n}`);
    }
  }

  const qualifying = rows.filter((r) => r.qualifies);
  console.log(`\n${qualifying.length} run(s) qualify for the bonus at today's constants.`);
  console.log(
    '\nRemember: these numbers are a LOWER BOUND — raw_path is the privacy-masked path, ' +
      'not the unmasked one detectLaps runs against on-device. See this script\'s own header.',
  );
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});

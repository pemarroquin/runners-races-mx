#!/usr/bin/env npx vite-node
// One-time backfill: rewrites `runs.duration_s` from finish-minus-start to
// running time (gap-policy.ts's activeDurationS), the meaning uploadRun writes
// since 2026-10-25. Before this every pace on screen divided by wall clock, so
// a run left recording after the runner stopped read as 46 min/km.
//
// Idempotent: the new value is computed from started_at/ended_at and the
// stored raw_path, never from the current duration_s, so a second run lands
// on the same numbers. The speed trigger is BEFORE INSERT only, so updating
// duration_s does not re-flag anything.
//
//   npm run backfill-active-duration            # dry run: prints the diff
//   npm run backfill-active-duration -- --apply # writes, after saving a backup
//
// Needs the SECRET key (SUPABASE_SERVICE_KEY, an sb_secret_ key in
// .env.local): runs is select-own, so the publishable key sees nothing.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { activeDurationS, type TimedPoint } from '@/lib/gap-policy';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APPLY = process.argv.includes('--apply');

function env(name: string): string {
  const raw = readFileSync(path.join(ROOT, '.env.local'), 'utf8');
  const line = raw.split('\n').find((l) => l.startsWith(`${name}=`));
  const value = line?.slice(name.length + 1).trim().replace(/^["']|["']$/g, '');
  if (!value) throw new Error(`${name} missing from .env.local`);
  return value;
}

const URL_BASE = env('EXPO_PUBLIC_SUPABASE_URL');
const SECRET = env('SUPABASE_SERVICE_KEY');
if (!SECRET.startsWith('sb_secret_')) {
  throw new Error('SUPABASE_SERVICE_KEY must be an sb_secret_ key: anything weaker sees no other runner');
}
const HEADERS = { apikey: SECRET, Authorization: `Bearer ${SECRET}` };

interface Row {
  id: string;
  started_at: string;
  ended_at: string;
  duration_s: number;
  distance_m: number;
  raw_path: unknown;
}

async function allRuns(): Promise<Row[]> {
  const rows: Row[] = [];
  for (let from = 0; ; from += 1000) {
    const res = await fetch(
      `${URL_BASE}/rest/v1/runs?select=id,started_at,ended_at,duration_s,distance_m,raw_path&order=started_at.asc`,
      { headers: { ...HEADERS, Range: `${from}-${from + 999}` } },
    );
    if (!res.ok) throw new Error(`read failed: ${res.status} ${await res.text()}`);
    const page = (await res.json()) as Row[];
    rows.push(...page);
    if (page.length < 1000) return rows;
  }
}

function timedPath(value: unknown): TimedPoint[] | null {
  if (!Array.isArray(value)) return null;
  const pts: TimedPoint[] = [];
  for (const e of value) {
    if (!Array.isArray(e) || typeof e[0] !== 'number' || typeof e[1] !== 'number' || typeof e[2] !== 'number') {
      return null;
    }
    pts.push({ lat: e[0], lng: e[1], ts: e[2] });
  }
  return pts;
}

const pace = (m: number, s: number) => {
  if (m < 100 || s <= 0) return '—';
  const sPerKm = s / (m / 1000);
  return `${Math.floor(sPerKm / 60)}:${String(Math.round(sPerKm % 60)).padStart(2, '0')}`;
};

const rows = await allRuns();
const changes: { id: string; from: number; to: number }[] = [];
let untimed = 0;
for (const r of rows) {
  const pts = timedPath(r.raw_path);
  if (!pts) {
    untimed++;
    continue;
  }
  const wall = (Date.parse(r.ended_at) - Date.parse(r.started_at)) / 1000;
  const to = activeDurationS(pts, wall);
  if (to !== r.duration_s) {
    changes.push({ id: r.id, from: r.duration_s, to });
    console.log(
      `${r.started_at.slice(0, 16)} ${r.id.slice(0, 8)} ${(r.distance_m / 1000).toFixed(2)} km  ` +
        `${r.duration_s}s -> ${to}s  pace ${pace(r.distance_m, r.duration_s)} -> ${pace(r.distance_m, to)}`,
    );
  }
}
console.log(`\n${rows.length} runs, ${changes.length} to change, ${untimed} skipped (no timestamps)`);

if (!APPLY) {
  console.log('Dry run. Re-run with --apply to write.');
} else if (changes.length > 0) {
  const dir = path.join(ROOT, 'supabase', 'generated');
  mkdirSync(dir, { recursive: true });
  const backup = path.join(dir, `duration-backfill-backup-${Date.now()}.json`);
  writeFileSync(backup, JSON.stringify(changes, null, 2));
  console.log(`Backup of old values: ${backup}`);
  for (const c of changes) {
    const res = await fetch(`${URL_BASE}/rest/v1/runs?id=eq.${c.id}`, {
      method: 'PATCH',
      headers: { ...HEADERS, 'Content-Type': 'application/json', Prefer: 'return=representation' },
      body: JSON.stringify({ duration_s: c.to }),
    });
    const written = res.ok ? ((await res.json()) as { duration_s: number }[]) : [];
    // Checked, not assumed: a PATCH that matches no row answers 200 with [].
    if (written.length !== 1 || written[0].duration_s !== c.to) {
      throw new Error(`write failed for ${c.id}: ${res.status}`);
    }
  }
  console.log(`Wrote ${changes.length} rows.`);
}

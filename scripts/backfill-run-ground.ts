#!/usr/bin/env npx vite-node
// Records enclosure for sessions claimed BEFORE 20261023120000, for runners
// who won't open the app (each device fills in its own on open, see
// territory-sync.ts recordMissingGround). Without it, those sessions count
// on Local Leaders by their crossed tiles alone until they age out of the
// 30-day window.
//
// Same rule as the device: each session's OWN loop (enclosure.ts
// groundOfRun) from the cells it logged in tile_visits, nothing across
// sessions. Written straight to run_ground with the secret key
// (SUPABASE_SERVICE_KEY in .env.local, never committed or pasted), because
// record_run_ground is keyed to the calling runner's session.
//
// DRY RUN by default. It writes only with --write, and only after the
// migration is applied:
//   npm run backfill-run-ground            # report what it would record
//   npm run backfill-run-ground -- --write
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { groundOfRun } from '@/lib/enclosure';
import { MAYORSHIP_WINDOW_DAYS } from '@/lib/mayorship';
import { DEFAULT_TILE_RES, isCurrentTileRes } from '@/lib/tiles';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function env(name: string): string {
  const raw = readFileSync(path.join(ROOT, '.env.local'), 'utf8');
  const line = raw.split('\n').find((l) => l.startsWith(`${name}=`));
  const value = line?.slice(name.length + 1).trim().replace(/^["']|["']$/g, '');
  if (!value) throw new Error(`${name} missing from .env.local`);
  return value;
}

const URL_BASE = env('EXPO_PUBLIC_SUPABASE_URL');
const SECRET = env('SUPABASE_SERVICE_KEY');
if (!SECRET.startsWith('sb_secret_')) throw new Error('SUPABASE_SERVICE_KEY must be an sb_secret_ key');

async function rest(query: string, init: RequestInit = {}): Promise<unknown> {
  const res = await fetch(`${URL_BASE}/rest/v1/${query}`, {
    ...init,
    headers: { apikey: SECRET, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${query.split('?')[0]}: ${res.status} ${await res.text()}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function restAll<T>(query: string): Promise<T[]> {
  const out: T[] = [];
  for (let offset = 0; ; offset += 1000) {
    const page = (await rest(`${query}&limit=1000&offset=${offset}`)) as T[];
    out.push(...page);
    if (page.length < 1000) return out;
  }
}

async function main() {
  const write = process.argv.includes('--write');
  const since = new Date(Date.now() - MAYORSHIP_WINDOW_DAYS * 86_400_000).toISOString();
  const pending = await restAll<{ run_id: string }>(
    `run_sessions?select=run_id&enclosure_recorded=eq.false&session_at=gte.${since}&order=run_id.asc`,
  );
  console.log(`${pending.length} session(s) in the window without recorded enclosure`);

  let cellsTotal = 0;
  for (const { run_id: runId } of pending) {
    const visits = await restAll<{ h3: string }>(`tile_visits?select=h3&run_id=eq.${runId}&order=h3.asc`);
    const crossed = visits.map((v) => v.h3).filter(isCurrentTileRes);
    const own = new Set(crossed);
    let enclosed: string[] = [];
    try {
      enclosed = groundOfRun(crossed, DEFAULT_TILE_RES).filter((c) => !own.has(c));
    } catch (e) {
      console.log(`  ${runId.slice(0, 8)}  enclosure failed (${e instanceof Error ? e.message : e}); crossed tiles only`);
    }
    cellsTotal += enclosed.length;
    console.log(`  ${runId.slice(0, 8)}  crossed ${String(crossed.length).padStart(4)}  encloses ${enclosed.length}`);
    if (!write) continue;
    for (let i = 0; i < enclosed.length; i += 1000) {
      await rest('run_ground?on_conflict=run_id,h3', {
        method: 'POST',
        headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' },
        body: JSON.stringify(enclosed.slice(i, i + 1000).map((h3) => ({ run_id: runId, h3, enclosed: true }))),
      });
    }
    await rest(`run_sessions?run_id=eq.${runId}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ enclosure_recorded: true }),
    });
  }
  console.log(write ? `recorded ${cellsTotal} enclosed cell(s)` : `dry run: would record ${cellsTotal} enclosed cell(s); pass --write`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});

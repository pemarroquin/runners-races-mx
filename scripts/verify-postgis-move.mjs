#!/usr/bin/env node
// Verifies the PostGIS schema move (20261104120000_postgis_to_extensions).
//
//   node scripts/verify-postgis-move.mjs snapshot <out.json>   # run checks on the LINKED project, save
//   node scripts/verify-postgis-move.mjs compare <before.json> <after.json>
//   node scripts/verify-postgis-move.mjs api                   # stranger checks via the publishable key
//   node scripts/verify-postgis-move.mjs assert-fence-guard <after-fix.json>  # after 20261104130000
//
// HOW. scripts/verify-postgis-move.sql is one DO block that inserts test
// runs AS A REAL RUNNER through the real triggers, then raises its results
// as an error, so everything it wrote is rolled back. Nothing persists on
// production. Take a snapshot right BEFORE applying the migration and one
// right AFTER; `compare` passes only if the move changed exactly what it was
// meant to change and nothing else.
//
// Rehearsed 2026-11-03 on a local copy of production (Docker, Postgres
// 17.6, PostGIS 3.3.7): before/after differed only in the two allowed keys.
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// The only keys the move is allowed to change, and what they must become.
const ALLOWED = {
  postgis_schema: { before: 'public', after: 'extensions' },
  public_spatial_ref_sys: { before: true, after: false },
};

function snapshot(out) {
  // --file, not the SQL as an argument: the CLI reads `--` comments as flags.
  let text = '';
  try {
    text = execFileSync('npx', ['supabase', 'db', 'query', '--linked', '-f', 'scripts/verify-postgis-move.sql'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    text = `${e.stdout ?? ''}${e.stderr ?? ''}`;
  }
  // The result travels inside an error, wrapped twice: CLI JSON -> API JSON
  // -> Postgres message `ERROR:  P0001: RESULT:{...}`. Unwrap each layer.
  let json;
  try {
    const outer = JSON.parse(balancedObject(text.slice(text.indexOf('{'))));
    const msg = outer.error.message;
    const inner = JSON.parse(balancedObject(msg.slice(msg.indexOf('{')))).message;
    json = JSON.parse(balancedObject(inner.slice(inner.indexOf('RESULT:') + 'RESULT:'.length)));
  } catch {
    console.error('No RESULT in the output. The checks did not run. Raw output:\n' + text.slice(0, 2000));
    process.exit(1);
  }
  writeFileSync(out, JSON.stringify(json, null, 2) + '\n');
  console.log(`Saved ${out}`);
  summarize(json);
}

// The leading {...} of s, by brace depth (ignoring braces inside strings),
// so a trailing Postgres CONTEXT line is never part of the JSON.
function balancedObject(s) {
  let depth = 0;
  let inStr = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (c === '\\') i++;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return s.slice(0, i + 1);
  }
  throw new Error('unbalanced RESULT');
}

function summarize(r) {
  console.log(`  postgis in ${r.postgis_schema}; public.spatial_ref_sys ${r.public_spatial_ref_sys ? 'EXISTS' : 'gone'}`);
  console.log(`  runs ${r.runs_total}, fences ${r.runs_with_fence}, 4326 rows ${r.srid_4326_rows}`);
  console.log(`  C2 copy: ${JSON.stringify(r.c2_copy)}`);
  console.log(`  C2b oversize fence refused: ${r.c2b_bad_fence?.ok === false && /23514/.test(r.c2b_bad_fence.err)}`);
  console.log(`  C2c moved fence refused: ${r.c2c_moved_fence?.ok === false && /off the recorded path/.test(r.c2c_moved_fence.err ?? '')}`);
  console.log(`  C3 fast run flagged: ${r.c3_fast?.flagged === true}`);
}

function compare(beforeFile, afterFile) {
  const b = JSON.parse(readFileSync(beforeFile, 'utf8'));
  const a = JSON.parse(readFileSync(afterFile, 'utf8'));
  const fails = [];
  for (const k of new Set([...Object.keys(b), ...Object.keys(a)])) {
    const same = JSON.stringify(b[k]) === JSON.stringify(a[k]);
    if (ALLOWED[k]) {
      if (b[k] !== ALLOWED[k].before || a[k] !== ALLOWED[k].after) fails.push(`${k}: ${b[k]} -> ${a[k]} (expected ${ALLOWED[k].before} -> ${ALLOWED[k].after})`);
    } else if (!same) {
      fails.push(`${k} changed:\n    before ${JSON.stringify(b[k])}\n    after  ${JSON.stringify(a[k])}`);
    }
  }
  // Behaviour that must hold, not just stay equal.
  if (a.c2_copy?.ok !== true || a.c2_copy?.same_fence !== true || a.c2_copy?.fence_reads_back_as_geojson == null) fails.push('C2: a real run copy was not accepted intact');
  if (!(a.c2b_bad_fence?.ok === false && /23514/.test(a.c2b_bad_fence.err ?? ''))) fails.push('C2b: oversize fence was not refused by the forgery guard');
  if (a.c3_fast?.flagged !== true) fails.push('C3: a 4x-speed run was not flagged');
  if (a.srid_4326_rows !== 1) fails.push('SRID 4326 missing');

  if (fails.length) {
    console.error('FAIL\n  ' + fails.join('\n  '));
    process.exit(1);
  }
  console.log('PASS: only postgis_schema and public_spatial_ref_sys changed; fences, areas, index, triggers and runner inserts identical.');
}

async function api() {
  const env = Object.fromEntries(
    readFileSync(path.join(ROOT, '.env.local'), 'utf8').split('\n').filter((l) => /^\w+=/.test(l)).map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i), l.slice(i + 1).replace(/^["']|["']$/g, '')];
    }),
  );
  const base = process.env.EXPO_PUBLIC_SUPABASE_URL ?? env.EXPO_PUBLIC_SUPABASE_URL;
  const key = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
  const h = { apikey: key, Authorization: `Bearer ${key}` };
  const fails = [];
  const get = await fetch(`${base}/rest/v1/spatial_ref_sys?limit=1`, { headers: h });
  console.log(`  B1 GET spatial_ref_sys     -> ${get.status}`);
  if (get.ok) fails.push('B1: anon can still READ spatial_ref_sys');
  const del = await fetch(`${base}/rest/v1/spatial_ref_sys?srid=eq.-1`, { method: 'DELETE', headers: h });
  console.log(`  B2 DELETE spatial_ref_sys  -> ${del.status}`);
  if (del.ok) fails.push('B2: anon can still DELETE from spatial_ref_sys');
  const rpc = await fetch(`${base}/rest/v1/rpc/postgis_full_version`, { method: 'POST', headers: { ...h, 'Content-Type': 'application/json' }, body: '{}' });
  console.log(`  B3 RPC postgis_full_version -> ${rpc.status}`);
  if (rpc.ok) fails.push('B3: PostGIS functions are still callable through the API');
  if (fails.length) {
    console.error('FAIL\n  ' + fails.join('\n  '));
    process.exit(1);
  }
  console.log('PASS: PostGIS is out of the API.');
}

// After 20261104130000_fence_must_follow_path: a fence moved off its own
// path must be refused, and an honest copy still accepted.
function assertFenceGuard(file) {
  const r = JSON.parse(readFileSync(file, 'utf8'));
  const fails = [];
  if (!(r.c2c_moved_fence?.ok === false && /off the recorded path/.test(r.c2c_moved_fence.err ?? ''))) fails.push(`C2c: moved fence not refused: ${JSON.stringify(r.c2c_moved_fence)}`);
  if (r.c2_copy?.ok !== true) fails.push(`C2: honest copy refused: ${JSON.stringify(r.c2_copy)}`);
  if (!(r.c2b_bad_fence?.ok === false && /23514/.test(r.c2b_bad_fence.err ?? ''))) fails.push('C2b: oversize fence no longer refused');
  if (fails.length) {
    console.error('FAIL\n  ' + fails.join('\n  '));
    process.exit(1);
  }
  console.log('PASS: moved fence refused, honest run accepted, area guard intact.');
}

const [cmd, x, y] = process.argv.slice(2);
if (cmd === 'snapshot' && x) snapshot(x);
else if (cmd === 'compare' && x && y) compare(x, y);
else if (cmd === 'api') await api();
else if (cmd === 'assert-fence-guard' && x) assertFenceGuard(x);
else {
  console.error('usage: snapshot <out.json> | compare <before.json> <after.json> | api | assert-fence-guard <after-fix.json>');
  process.exit(2);
}

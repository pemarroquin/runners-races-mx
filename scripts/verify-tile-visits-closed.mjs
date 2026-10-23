#!/usr/bin/env node
// Live check that location history is closed (20261023120000 + 130000).
// Read-only apart from one throwaway anonymous sign-up, which is the point:
// an anonymous session is what anyone holding the publishable key can mint,
// so "no session sees nothing" alone proves little (PR #79's own caveat).
//
// Exits non-zero if ANY request returns another runner's rows.
//   node scripts/verify-tile-visits-closed.mjs
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const raw = readFileSync(path.join(ROOT, '.env.local'), 'utf8');
const env = (name) =>
  raw.split('\n').find((l) => l.startsWith(`${name}=`))?.slice(name.length + 1).trim().replace(/^["']|["']$/g, '');

const URL_BASE = env('EXPO_PUBLIC_SUPABASE_URL');
const KEY = env('EXPO_PUBLIC_SUPABASE_ANON_KEY');
if (!URL_BASE || !KEY) throw new Error('EXPO_PUBLIC_SUPABASE_URL / _ANON_KEY missing from .env.local');

let failed = false;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
  if (!ok) failed = true;
};

async function get(pathAndQuery, token) {
  const headers = { apikey: KEY };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${URL_BASE}/rest/v1/${pathAndQuery}`, { headers });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function rpc(fn, args, token) {
  const headers = { apikey: KEY, 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${URL_BASE}/rest/v1/rpc/${fn}`, { method: 'POST', headers, body: JSON.stringify(args) });
  return { status: res.status, body: await res.json().catch(() => null) };
}

// 1. No session.
for (const table of ['tile_visits', 'run_ground', 'run_sessions', 'runs']) {
  const r = await get(`${table}?select=*&limit=5`);
  check(`no session: ${table}`, Array.isArray(r.body) ? r.body.length === 0 : r.status >= 400, `${r.status}, ${Array.isArray(r.body) ? r.body.length + ' rows' : 'error'}`);
}
const anonRpc = await rpc('local_leaders_cells', { p_prefixes: ['8c48a2a1a'] });
check('no session: local_leaders_cells refused', anonRpc.status >= 400, String(anonRpc.status));

// 2. A brand-new anonymous session: owns nothing, so must see nothing.
const signup = await fetch(`${URL_BASE}/auth/v1/signup`, {
  method: 'POST',
  headers: { apikey: KEY, 'Content-Type': 'application/json' },
  body: JSON.stringify({}),
});
const token = (await signup.json().catch(() => ({}))).access_token;
check('anonymous sign-up', Boolean(token), String(signup.status));
if (token) {
  for (const table of ['tile_visits', 'run_ground', 'run_sessions', 'runs']) {
    const r = await get(`${table}?select=*&limit=5`, token);
    check(`fresh anonymous: ${table}`, Array.isArray(r.body) && r.body.length === 0, `${r.status}, ${Array.isArray(r.body) ? r.body.length + ' rows' : 'error'}`);
  }
  // The board itself still works for a signed-in runner: mayors only.
  const board = await rpc('local_leaders_cells', { p_prefixes: ['8c48a2a1a'] }, token);
  check(
    'fresh anonymous: local_leaders_cells answers with [h3, user, days] only',
    Array.isArray(board.body) && board.body.every((row) => Array.isArray(row) && row.length === 3),
    `${board.status}, ${Array.isArray(board.body) ? board.body.length + ' cells' : JSON.stringify(board.body)}`,
  );
}

process.exitCode = failed ? 1 : 0;

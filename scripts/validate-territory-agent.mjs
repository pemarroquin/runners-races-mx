#!/usr/bin/env node
// Validates the territory agent's tool functions against real Supabase data.
//
// Uses the anon/publishable key (already in .env.local) for reads that don't
// require service-level access — territory_tiles and park_path_cells are
// public competitive data. Also validates a full agent call if ANTHROPIC_API_KEY
// and SUPABASE_SERVICE_KEY are set.
//
// Usage:
//   node scripts/validate-territory-agent.mjs
//
// Full-agent validation (also needs service key):
//   ANTHROPIC_API_KEY=sk-ant-... SUPABASE_SERVICE_KEY=sb_secret_... node scripts/validate-territory-agent.mjs

import { readFileSync } from 'fs';
import { createClient } from '@supabase/supabase-js';
import { cellToParent, getResolution, gridDisk } from 'h3-js';
import Anthropic from '@anthropic-ai/sdk';

// ── Load .env.local ───────────────────────────────────────────────────────────
const env = {};
try {
  const raw = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
  for (const line of raw.split('\n')) {
    const m = line.match(/^([^#=]+)=(.+)$/);
    if (m) env[m[1].trim()] = m[2].trim();
  }
} catch {
  console.error('Could not read .env.local — run from running-app/');
  process.exit(1);
}

const SUPABASE_URL = env.EXPO_PUBLIC_SUPABASE_URL;
const ANON_KEY = env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY ?? env.SUPABASE_SERVICE_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY ?? env.ANTHROPIC_API_KEY;

if (!SUPABASE_URL || !ANON_KEY) {
  console.error('Missing EXPO_PUBLIC_SUPABASE_URL or EXPO_PUBLIC_SUPABASE_ANON_KEY in .env.local');
  process.exit(1);
}

const TILE_RES = 12;
const DISTRICT_RES = 7;
const PAGE = 1000;

function districtCellPattern(district) {
  return district.slice(0, 7);
}

// ── Step 1: verify anon-key reads ─────────────────────────────────────────────
console.log('\n── Step 1: Supabase connectivity with anon key ──');
const anonDb = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } });

const { data: sampleTiles, error: tilesError } = await anonDb
  .from('territory_tiles')
  .select('h3, owner_id')
  .order('h3', { ascending: false })
  .limit(5);

if (tilesError) {
  console.error('territory_tiles read failed:', tilesError.message);
  console.log('→ Table may require auth session (RLS). Service key needed for cross-user reads.');
} else {
  console.log(`✓ territory_tiles readable — ${sampleTiles.length} sample rows`);
  for (const r of sampleTiles) {
    console.log(`  h3=${r.h3}  res=${getResolution(r.h3)}  owner=${r.owner_id?.slice(0, 8)}…`);
  }
}

const { data: samplePark, error: parkError } = await anonDb
  .from('park_path_cells')
  .select('h3, municipio')
  .limit(3);

if (parkError) {
  console.error('park_path_cells read failed:', parkError.message);
} else {
  console.log(`✓ park_path_cells readable — ${samplePark.length} sample rows`);
  for (const r of samplePark) {
    console.log(`  h3=${r.h3}  municipio=${r.municipio}`);
  }
}

// ── Step 2: H3 geometry correctness ──────────────────────────────────────────
console.log('\n── Step 2: H3 geometry ──');
if (sampleTiles?.length) {
  const tile = sampleTiles[0].h3;
  const district = cellToParent(tile, DISTRICT_RES);
  const pattern = districtCellPattern(district);
  console.log(`✓ tile=${tile}  →  district=${district}  pattern=${pattern}%`);
  console.log(`  gridDisk(tile, 1) = ${gridDisk(tile, 1).length} neighbors`);
  const parentRes9 = cellToParent(tile, 9);
  console.log(`  res-9 cluster parent = ${parentRes9}`);
}

// ── Step 3: tool queries with a real userId ───────────────────────────────────
// territory_tiles and park_path_cells are publicly readable — anon key works.
// The service key is only needed in the deployed API route (to read any user's
// data server-side). For local validation we use the anon key throughout.
const db = anonDb;

console.log(`\n── Step 3: tool queries (anon key — territory_tiles is public) ──`);

// Pick the most active userId (most tiles) — most likely to have real park coverage.
let testUserId = null;
const { data: allOwners } = await db.from('territory_tiles').select('owner_id');
if (allOwners?.length) {
  const counts = new Map();
  for (const { owner_id } of allOwners) counts.set(owner_id, (counts.get(owner_id) ?? 0) + 1);
  testUserId = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
  console.log(`Most active user: ${testUserId.slice(0, 8)}… (${counts.get(testUserId)} tiles total)`);
}

if (!testUserId) {
  console.log('No rows in territory_tiles — skipping user-scoped tool tests');
} else {
  console.log(`Using userId=${testUserId.slice(0, 8)}… for tool tests`);

  // get_owned_territory — use mode district (most tiles), not alphabetical proxy
  const allUserTilesPages = [];
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await db
      .from('territory_tiles').select('h3').eq('owner_id', testUserId)
      .order('h3', { ascending: true }).range(offset, offset + PAGE - 1);
    if (error || !data || !data.length) break;
    allUserTilesPages.push(...data.map(r => r.h3).filter(h => getResolution(h) === TILE_RES));
    if (data.length < PAGE) break;
  }
  const districtCounts2 = new Map();
  for (const h of allUserTilesPages) {
    const d = cellToParent(h, DISTRICT_RES);
    districtCounts2.set(d, (districtCounts2.get(d) ?? 0) + 1);
  }

  const primaryDistrict = allUserTilesPages.length
    ? [...districtCounts2.entries()].sort((a, b) => b[1] - a[1])[0][0]
    : null;

  if (!primaryDistrict) {
    console.log('  get_owned_territory: no valid res-12 tiles for user');
  } else {
    const district = primaryDistrict;
    const pattern = `${districtCellPattern(district)}%`;

    const ownedCount = allUserTilesPages.filter(h => cellToParent(h, DISTRICT_RES) === district).length;

    let parkTotal = 0;
    for (let offset = 0; ; offset += PAGE) {
      const { data, error } = await db
        .from('park_path_cells')
        .select('h3')
        .like('h3', pattern)
        .range(offset, offset + PAGE - 1);
      if (error || !data) break;
      parkTotal += data.length;
      if (data.length < PAGE) break;
    }

    const pct = parkTotal > 0 ? Math.round((ownedCount / parkTotal) * 1000) / 10 : 0;
    console.log(`  ✓ get_owned_territory → district=${district} owned=${ownedCount} parkPaths=${parkTotal} coverage=${pct}%`);

    // get_unclaimed_park_paths
    const { data: parkCells } = await db
      .from('park_path_cells')
      .select('h3')
      .like('h3', pattern)
      .limit(5000);
    const { data: ownedCells } = await db
      .from('territory_tiles')
      .select('h3')
      .eq('owner_id', testUserId)
      .like('h3', pattern)
      .limit(5000);

    const ownedSet = new Set((ownedCells ?? []).map((r) => r.h3));
    const unclaimed = (parkCells ?? []).filter((r) => !ownedSet.has(r.h3));
    const byParent = new Map();
    for (const { h3 } of unclaimed) {
      const parent = cellToParent(h3, 9);
      byParent.set(parent, (byParent.get(parent) ?? 0) + 1);
    }
    const clusters = [...byParent.values()].sort((a, b) => b - a);
    console.log(
      `  ✓ get_unclaimed_park_paths → unclaimed=${unclaimed.length} clusters=${clusters.length} largest=${clusters[0] ?? 0}`,
    );

    // get_rival_activity
    const { data: allDistrictTiles } = await db
      .from('territory_tiles')
      .select('h3, owner_id')
      .like('h3', pattern)
      .limit(5000);
    const myTileSet = new Set(
      (allDistrictTiles ?? []).filter((r) => r.owner_id === testUserId).map((r) => r.h3),
    );
    const rivals = new Map();
    for (const { h3, owner_id } of allDistrictTiles ?? []) {
      if (owner_id === testUserId) continue;
      const cur = rivals.get(owner_id) ?? 0;
      rivals.set(owner_id, cur + 1);
    }
    console.log(`  ✓ get_rival_activity → ${rivals.size} rival(s) in district`);
    for (const [id, count] of [...rivals.entries()].slice(0, 3)) {
      console.log(`     ${id.slice(0, 8)}…  ${count} tiles`);
    }
  }
}

// ── Step 4: full agent call ───────────────────────────────────────────────────
// Uses anon key for Supabase reads (territory_tiles is public) and the full
// tool loop with Claude Haiku — mirrors what the API route does, without
// requiring the secret key locally.
console.log('\n── Step 4: full agent call ──');
if (!ANTHROPIC_KEY) {
  console.log('Skipped — set ANTHROPIC_API_KEY to test the full loop.');
} else if (!testUserId) {
  console.log('Skipped — no test user found in territory_tiles.');
} else {
  const anthropic = new Anthropic({ apiKey: ANTHROPIC_KEY });

  // Replicate the three tool functions using the anon key (public tables).
  async function getOwnedTerritory(userId) {
    const tiles = [];
    for (let offset = 0; ; offset += PAGE) {
      const { data } = await anonDb.from('territory_tiles').select('h3')
        .eq('owner_id', userId).order('h3', { ascending: true }).range(offset, offset + PAGE - 1);
      if (!data?.length) break;
      tiles.push(...data.map(r => r.h3).filter(h => getResolution(h) === TILE_RES));
      if (data.length < PAGE) break;
    }
    if (!tiles.length) return { district: '', ownedCells: 0, parkPathTotal: 0, pctOwned: 0 };
    const dc = new Map();
    for (const h of tiles) { const d = cellToParent(h, DISTRICT_RES); dc.set(d, (dc.get(d) ?? 0) + 1); }
    const district = [...dc.entries()].sort((a, b) => b[1] - a[1])[0][0];
    const pattern = `${districtCellPattern(district)}%`;
    const ownedCells = tiles.filter(h => cellToParent(h, DISTRICT_RES) === district).length;
    let parkPathTotal = 0;
    for (let offset = 0; ; offset += PAGE) {
      const { data } = await anonDb.from('park_path_cells').select('h3').like('h3', pattern).range(offset, offset + PAGE - 1);
      if (!data) break;
      parkPathTotal += data.length;
      if (data.length < PAGE) break;
    }
    const pctOwned = parkPathTotal > 0 ? Math.round((ownedCells / parkPathTotal) * 1000) / 10 : 0;
    return { district, ownedCells, parkPathTotal, pctOwned };
  }

  async function getUnclaimedParkPaths(district, userId) {
    const pattern = `${districtCellPattern(district)}%`;
    const parkCells = [], ownedSet = new Set();
    for (let offset = 0; ; offset += PAGE) {
      const { data } = await anonDb.from('park_path_cells').select('h3').like('h3', pattern).range(offset, offset + PAGE - 1);
      if (!data) break; parkCells.push(...data.map(r => r.h3)); if (data.length < PAGE) break;
    }
    for (let offset = 0; ; offset += PAGE) {
      const { data } = await anonDb.from('territory_tiles').select('h3').eq('owner_id', userId).like('h3', pattern).range(offset, offset + PAGE - 1);
      if (!data) break; for (const r of data) ownedSet.add(r.h3); if (data.length < PAGE) break;
    }
    const unclaimed = parkCells.filter(h => !ownedSet.has(h));
    const byParent = new Map();
    for (const h of unclaimed) { const p = cellToParent(h, 9); byParent.set(p, (byParent.get(p) ?? 0) + 1); }
    const clusters = [...byParent.values()].sort((a, b) => b - a);
    return { clusterCount: clusters.length, totalUnclaimed: unclaimed.length, largestCluster: clusters[0] ?? 0 };
  }

  async function getRivalActivity(district, userId) {
    const pattern = `${districtCellPattern(district)}%`;
    const allTiles = [];
    for (let offset = 0; ; offset += PAGE) {
      const { data } = await anonDb.from('territory_tiles').select('h3, owner_id').like('h3', pattern).range(offset, offset + PAGE - 1);
      if (!data) break; allTiles.push(...data); if (data.length < PAGE) break;
    }
    const myTiles = new Set(allTiles.filter(r => r.owner_id === userId).map(r => r.h3));
    const myNeighbors = new Set();
    for (const h of myTiles) for (const n of gridDisk(h, 1)) if (!myTiles.has(n)) myNeighbors.add(n);
    const byRival = new Map();
    for (const { h3, owner_id } of allTiles) {
      if (owner_id === userId) continue;
      const cur = byRival.get(owner_id) ?? { cells: 0, borderCells: 0 };
      cur.cells++; if (myNeighbors.has(h3)) cur.borderCells++;
      byRival.set(owner_id, cur);
    }
    const rivals = [...byRival.entries()].map(([, s]) => s).sort((a, b) => b.cells - a.cells).slice(0, 5);
    return { rivals };
  }

  // Run the agentic tool loop exactly as the API route does.
  const TOOLS = [
    { name: 'get_owned_territory', description: "Returns the runner's home district, owned tile count, park-path total, and coverage %.", input_schema: { type: 'object', properties: { user_id: { type: 'string' } }, required: ['user_id'] } },
    { name: 'get_unclaimed_park_paths', description: 'Counts unclaimed park-path cells and groups them into clusters.', input_schema: { type: 'object', properties: { district: { type: 'string' }, user_id: { type: 'string' } }, required: ['district', 'user_id'] } },
    { name: 'get_rival_activity', description: "Returns competitors in the district and how many of their tiles border the user's territory.", input_schema: { type: 'object', properties: { district: { type: 'string' }, user_id: { type: 'string' } }, required: ['district', 'user_id'] } },
  ];

  const systemPrompt = `Eres un asesor de rutas para una app de running que gamifica el territorio.
Los usuarios corren calles reales y reclaman "tiles" (celdas H3) como territorio propio.
Usa las herramientas para obtener datos reales. Responde en español, máximo 3 oraciones directas y concretas.`;

  const messages = [{ role: 'user', content: `Analiza el territorio del usuario ${testUserId}. ¿Dónde debería correr en su próxima salida?` }];

  let suggestion = null;
  for (let turn = 0; turn < 6; turn++) {
    const response = await anthropic.messages.create({ model: 'claude-haiku-4-5-20251001', max_tokens: 512, system: systemPrompt, tools: TOOLS, messages });
    messages.push({ role: 'assistant', content: response.content });
    if (response.stop_reason === 'end_turn') {
      suggestion = response.content.filter(b => b.type === 'text').map(b => b.text).join('');
      break;
    }
    if (response.stop_reason !== 'tool_use') break;
    const results = [];
    for (const block of response.content) {
      if (block.type !== 'tool_use') continue;
      const inp = block.input;
      let result;
      if (block.name === 'get_owned_territory') result = await getOwnedTerritory(inp.user_id);
      else if (block.name === 'get_unclaimed_park_paths') result = await getUnclaimedParkPaths(inp.district, inp.user_id);
      else if (block.name === 'get_rival_activity') result = await getRivalActivity(inp.district, inp.user_id);
      else result = { error: 'unknown tool' };
      console.log(`  tool: ${block.name} →`, JSON.stringify(result).slice(0, 120));
      results.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(result) });
    }
    messages.push({ role: 'user', content: results });
  }

  if (suggestion) {
    console.log('\n✓ Agent suggestion (es):');
    console.log(suggestion);
  } else {
    console.log('✗ Agent did not produce a suggestion');
  }
}

console.log('\nValidation complete.');

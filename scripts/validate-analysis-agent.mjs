#!/usr/bin/env node
// Validates the territory analysis agent end-to-end against real Supabase data.
// Runs both agents inline (no deployed endpoint needed).
//
// Usage:
//   node scripts/validate-analysis-agent.mjs
//
// Requires in .env.local:
//   EXPO_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_KEY, ANTHROPIC_API_KEY

import { readFileSync } from 'fs';
import { createClient } from '@supabase/supabase-js';
import { cellToCenterChild, cellToParent, getResolution, gridDisk } from 'h3-js';
import Anthropic from '@anthropic-ai/sdk';

const env = {};
try {
  for (const line of readFileSync(new URL('../.env.local', import.meta.url), 'utf8').split('\n')) {
    const m = line.match(/^([^#=]+)=(.+)$/);
    if (m) env[m[1].trim()] = m[2].trim();
  }
} catch { console.error('Could not read .env.local'); process.exit(1); }

const SUPABASE_URL = env.EXPO_PUBLIC_SUPABASE_URL;
const ANON_KEY = env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY ?? env.SUPABASE_SERVICE_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY ?? env.ANTHROPIC_API_KEY;

if (!SUPABASE_URL || !ANON_KEY) { console.error('Missing Supabase URL or anon key'); process.exit(1); }

const TILE_RES = 12;
const DISTRICT_RES = 7;
const PAGE = 1000;

// territory_tiles and park_path_cells are public — anon key works for reads.
const anonDb = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } });
const db = SERVICE_KEY
  ? createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } })
  : anonDb;

console.log('\n── Step 1: Supabase connectivity ──');
const { data: s1, error: e1 } = await anonDb.from('territory_tiles').select('h3').limit(3);
console.log(e1 ? `✗ ${e1.message}` : `✓ territory_tiles readable (${s1.length} rows)`);
const { data: s2, error: e2 } = await anonDb.from('park_path_cells').select('h3').limit(3);
console.log(e2 ? `✗ ${e2.message}` : `✓ park_path_cells readable (${s2.length} rows)`);

// Check if service key can read runs (requires secret key, not legacy JWT).
if (SERVICE_KEY) {
  const { data: s3, error: e3 } = await db.from('runs').select('id').limit(3);
  console.log(e3 ? `✗ runs (service key): ${e3.message}` : `✓ runs readable with service key (${s3.length} rows)`);
} else {
  console.log('⚠ SUPABASE_SERVICE_KEY not set — runs scan will return 0 rows (add sb_secret_... key)');
}

console.log('\n── Step 2: Analyst tool functions ──');

async function scanGpsQuality() {
  const { data } = await db.from('runs').select('distance_m, duration_s, anti_cheat_flagged').limit(5000);
  if (!data?.length) return { totalRuns: 0, flaggedRuns: 0, note: 'no rows — service key needed' };
  const rows = data;
  const flagged = rows.filter(r => r.anti_cheat_flagged).length;
  return { totalRuns: rows.length, flaggedRuns: flagged, flaggedPct: Math.round(flagged / rows.length * 1000) / 10 };
}

async function scanFenceShapes() {
  const { data } = await anonDb.from('territory_tiles').select('h3, owner_id').limit(5000);
  if (!data?.length) return { totalUsers: 0, usersWithIsolatedCells: 0 };
  const byUser = new Map();
  for (const { h3, owner_id } of data) {
    if (getResolution(h3) !== TILE_RES) continue;
    const arr = byUser.get(owner_id) ?? []; arr.push(h3); byUser.set(owner_id, arr);
  }
  let isolated = 0;
  for (const [, tiles] of byUser) {
    const set = new Set(tiles);
    const pct = tiles.filter(h => gridDisk(h, 1).filter(n => n !== h && set.has(n)).length === 0).length / tiles.length;
    if (pct > 0.1) isolated++;
  }
  return { totalUsers: byUser.size, usersWithIsolatedCells: isolated };
}

async function scanCoverage() {
  const { data: tiles } = await anonDb.from('territory_tiles').select('h3').limit(5000);
  if (!tiles?.length) return { districtsAnalyzed: 0 };
  const districts = new Set();
  for (const { h3 } of tiles) if (getResolution(h3) === TILE_RES) districts.add(cellToParent(h3, DISTRICT_RES));
  let withPaths = 0;
  for (const d of districts) {
    const pattern = `${cellToCenterChild(d, TILE_RES).slice(0, 2 + DISTRICT_RES)}%`;
    const { count } = await anonDb.from('park_path_cells').select('*', { count: 'estimated', head: true }).like('h3', pattern);
    if ((count ?? 0) > 0) withPaths++;
  }
  return { districtsAnalyzed: districts.size, districtsWithParkPaths: withPaths, districtsWithNoParkPaths: districts.size - withPaths };
}

const [gps, shapes, coverage] = await Promise.all([scanGpsQuality(), scanFenceShapes(), scanCoverage()]);
console.log('  scan_gps_quality →', JSON.stringify(gps));
console.log('  scan_fence_shapes →', JSON.stringify(shapes));
console.log('  scan_coverage_gaps →', JSON.stringify(coverage));

console.log('\n── Step 3: Full two-agent call ──');
if (!ANTHROPIC_KEY) {
  console.log('Skipped — set ANTHROPIC_API_KEY');
} else {
  const anthropic = new Anthropic({ apiKey: ANTHROPIC_KEY });
  const findings = { gps_quality: gps, fence_shapes: shapes, coverage };

  // Strategist only — analyst already ran inline above.
  const strategistSystem = `You are an internal product strategist for a running app that gamifies territory (H3 hex tiles).
You receive data findings and write 1-2 findings using the write_finding tool, then stop.
Be specific and concrete. Reference actual numbers.`;

  const writeLog = [];
  const writeFindingTool = [{
    name: 'write_finding',
    description: 'Records a finding for review.',
    input_schema: {
      type: 'object',
      properties: {
        category: { type: 'string', enum: ['gps_quality', 'fence_shapes', 'anti_cheat', 'coverage', 'h3_fit', 'summary'] },
        severity: { type: 'string', enum: ['info', 'warning', 'critical'] },
        finding: { type: 'string' },
        recommendation: { type: 'string' },
        evidence: { type: 'object' },
      },
      required: ['category', 'severity', 'finding', 'recommendation', 'evidence'],
    },
  }];

  const msgs = [{ role: 'user', content: `Findings:\n${JSON.stringify(findings, null, 2)}\n\nWrite 1-2 findings then stop.` }];
  for (let turn = 0; turn < 6; turn++) {
    const res = await anthropic.messages.create({ model: 'claude-haiku-4-5-20251001', max_tokens: 1024, system: strategistSystem, tools: writeFindingTool, messages: msgs });
    msgs.push({ role: 'assistant', content: res.content });
    if (res.stop_reason === 'end_turn') break;
    if (res.stop_reason !== 'tool_use') break;
    const results = [];
    for (const b of res.content) {
      if (b.type !== 'tool_use') continue;
      writeLog.push({ category: b.input.category, severity: b.input.severity, finding: b.input.finding.slice(0, 80) });
      results.push({ type: 'tool_result', tool_use_id: b.id, content: JSON.stringify({ ok: true, note: 'dry-run — not writing to DB in validation' }) });
    }
    msgs.push({ role: 'user', content: results });
  }

  console.log(`✓ Strategist produced ${writeLog.length} finding(s):`);
  for (const f of writeLog) console.log(`  [${f.severity}] ${f.category}: ${f.finding}…`);
}

console.log('\nValidation complete.');

#!/usr/bin/env node
// One-shot: runs the full two-agent territory analysis and writes findings to
// the agent_findings Supabase table. Same logic as the API route, runnable locally.
//
// Usage: node scripts/run-analysis-agent.mjs

import { readFileSync } from 'fs';
import { createClient } from '@supabase/supabase-js';
import { cellToCenterChild, cellToParent, getResolution, gridDisk } from 'h3-js';
import Anthropic from '@anthropic-ai/sdk';

const env = {};
for (const line of readFileSync(new URL('../.env.local', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^([^#=]+)=(.+)$/);
  if (m) env[m[1].trim()] = m[2].trim();
}

const SUPABASE_URL = env.EXPO_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY ?? env.SUPABASE_SERVICE_KEY;
const ANON_KEY = env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY ?? env.ANTHROPIC_API_KEY;

if (!SUPABASE_URL || !SERVICE_KEY || !ANTHROPIC_KEY) {
  console.error('Missing SUPABASE_SERVICE_KEY, ANTHROPIC_API_KEY, or EXPO_PUBLIC_SUPABASE_URL');
  process.exit(1);
}

const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
const anonDb = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } });
const anthropic = new Anthropic({ apiKey: ANTHROPIC_KEY });
const TILE_RES = 12;
const DISTRICT_RES = 7;
const PAGE = 1000;
const weekOf = new Date().toISOString().slice(0, 10);

// ── Analyst tools ─────────────────────────────────────────────────────────────

async function scanGpsQuality() {
  const { data, error } = await db.from('runs').select('distance_m, duration_s, flagged, flag_reason').limit(5000);
  if (error) { console.log('  runs error:', error.message); return { totalRuns: 0, flaggedRuns: 0, flaggedPct: 0, shortRunsUnder500m: 0, avgDistanceM: 0, suspiciousHighPaceCount: 0, note: error.message }; }
  if (!data?.length) return { totalRuns: 0, flaggedRuns: 0, flaggedPct: 0, shortRunsUnder500m: 0, avgDistanceM: 0, suspiciousHighPaceCount: 0 };
  const flagged = data.filter(r => r.flagged).length;
  const short = data.filter(r => r.distance_m < 500).length;
  const avg = Math.round(data.reduce((s, r) => s + (r.distance_m ?? 0), 0) / data.length);
  const suspicious = data.filter(r => r.distance_m > 200 && r.duration_s / (r.distance_m / 1000) < 120).length;
  return { totalRuns: data.length, flaggedRuns: flagged, flaggedPct: Math.round(flagged / data.length * 1000) / 10, shortRunsUnder500m: short, avgDistanceM: avg, suspiciousHighPaceCount: suspicious };
}

async function scanFenceShapes() {
  const { data } = await anonDb.from('territory_tiles').select('h3, owner_id').limit(5000);
  if (!data?.length) return { totalUsers: 0, usersWithIsolatedCells: 0, avgIsolatedPct: 0, avgConnectivity: 0 };
  const byUser = new Map();
  for (const { h3, owner_id } of data) {
    if (getResolution(h3) !== TILE_RES) continue;
    const arr = byUser.get(owner_id) ?? []; arr.push(h3); byUser.set(owner_id, arr);
  }
  let totalIsolatedPct = 0, usersWithIsolated = 0, totalConn = 0;
  for (const [, tiles] of byUser) {
    const set = new Set(tiles);
    let iso = 0, conn = 0;
    for (const h of tiles) {
      const neighbors = gridDisk(h, 1).filter(n => n !== h && set.has(n));
      conn += neighbors.length;
      if (neighbors.length === 0) iso++;
    }
    const isoPct = (iso / tiles.length) * 100;
    totalIsolatedPct += isoPct;
    totalConn += conn / tiles.length;
    if (isoPct > 10) usersWithIsolated++;
  }
  const u = byUser.size;
  return { totalUsers: u, usersWithIsolatedCells: usersWithIsolated, avgIsolatedPct: Math.round(totalIsolatedPct / u * 10) / 10, avgConnectivity: Math.round(totalConn / u * 10) / 10 };
}

async function scanAntiCheatPatterns() {
  const { data: flagged } = await db.from('runs').select('user_id, flag_reason').eq('flagged', true).limit(2000);
  const { count: totalRuns } = await db.from('runs').select('*', { count: 'estimated', head: true });
  const { count: totalUsers } = await db.from('territory_tiles').select('owner_id', { count: 'estimated', head: true });
  if (!flagged) return { totalFlaggedRuns: 0, uniqueUsersWithFlags: 0 };
  const byUser = new Map();
  for (const { user_id } of flagged) byUser.set(user_id, (byUser.get(user_id) ?? 0) + 1);
  const top = [...byUser.entries()].sort((a, b) => b[1] - a[1])[0];
  let topTiles = 0;
  if (top) { const { count } = await db.from('territory_tiles').select('*', { count: 'estimated', head: true }).eq('owner_id', top[0]); topTiles = count ?? 0; }
  // Aggregate flag reasons
  const reasons = new Map();
  for (const { flag_reason } of flagged) if (flag_reason) reasons.set(flag_reason, (reasons.get(flag_reason) ?? 0) + 1);
  return { totalFlaggedRuns: flagged.length, totalRuns: totalRuns ?? 0, uniqueUsersWithFlags: byUser.size, totalUsers: totalUsers ?? 0, topFlaggedUserRuns: top?.[1] ?? 0, topFlaggedUserTiles: topTiles, flagReasons: Object.fromEntries(reasons) };
}

async function scanCoverageGaps() {
  const { data: tiles } = await anonDb.from('territory_tiles').select('h3').limit(5000);
  if (!tiles?.length) return { districtsAnalyzed: 0 };
  const districts = new Set();
  for (const { h3 } of tiles) if (getResolution(h3) === TILE_RES) districts.add(cellToParent(h3, DISTRICT_RES));
  const results = [];
  for (const d of districts) {
    const pattern = `${cellToCenterChild(d, TILE_RES).slice(0, 2 + DISTRICT_RES)}%`;
    const [{ count: owned }, { count: paths }] = await Promise.all([
      anonDb.from('territory_tiles').select('*', { count: 'estimated', head: true }).like('h3', pattern),
      anonDb.from('park_path_cells').select('*', { count: 'estimated', head: true }).like('h3', pattern),
    ]);
    const pct = (paths ?? 0) > 0 ? Math.round((owned ?? 0) / (paths ?? 1) * 1000) / 10 : 0;
    results.push({ district: d, owned: owned ?? 0, paths: paths ?? 0, pct });
  }
  const withPaths = results.filter(r => r.paths > 0);
  const avg = withPaths.length > 0 ? Math.round(withPaths.reduce((s, r) => s + r.pct, 0) / withPaths.length * 10) / 10 : 0;
  const lowest = withPaths.sort((a, b) => a.pct - b.pct)[0];
  return { districtsAnalyzed: results.length, districtsWithNoParkPaths: results.filter(r => r.paths === 0).length, avgCoveragePct: avg, lowestCoverageDistrict: lowest?.district ?? 'n/a', lowestCoveragePct: lowest?.pct ?? 0 };
}

async function scanH3Fit() {
  const { data: runs } = await db.from('runs').select('distance_m').gt('distance_m', 0).limit(2000);
  const { count: totalTiles } = await anonDb.from('territory_tiles').select('*', { count: 'estimated', head: true });
  if (!runs?.length) return { avgTilesPerKm: 0, totalRunsAnalyzed: 0, totalTiles: totalTiles ?? 0 };
  const totalKm = runs.reduce((s, r) => s + (r.distance_m ?? 0) / 1000, 0);
  const { count: shortTiled } = await db.from('runs').select('*', { count: 'estimated', head: true }).lt('distance_m', 300).eq('flagged', false);
  return { avgTilesPerKm: totalKm > 0 ? Math.round((totalTiles ?? 0) / totalKm * 10) / 10 : 0, totalRunsAnalyzed: runs.length, totalTiles: totalTiles ?? 0, shortRunsUnder300m: shortTiled ?? 0 };
}

// ── Run Analyst ───────────────────────────────────────────────────────────────

console.log('── Agent 1: Analyst (Haiku) ──');
const ANALYST_TOOLS = [
  { name: 'scan_gps_quality', description: 'GPS quality: flagged rate, pace outliers, short runs.', input_schema: { type: 'object', properties: {}, required: [] } },
  { name: 'scan_fence_shapes', description: 'H3 tile connectivity: isolated cells, avg connectivity.', input_schema: { type: 'object', properties: {}, required: [] } },
  { name: 'scan_anti_cheat_patterns', description: 'Anti-cheat flag aggregation across all users.', input_schema: { type: 'object', properties: {}, required: [] } },
  { name: 'scan_coverage_gaps', description: 'Park-path coverage per district.', input_schema: { type: 'object', properties: {}, required: [] } },
  { name: 'scan_h3_fit', description: 'H3 resolution fit: tiles per km, noise density.', input_schema: { type: 'object', properties: {}, required: [] } },
];

const analystMsgs = [{ role: 'user', content: 'Call all five scan tools, then return combined findings as JSON.' }];
const analystSystem = `You are a data analyst for a territory running app. Call ALL five scan tools exactly once.
After receiving all results, return ONLY a JSON object with keys: gps_quality, fence_shapes, anti_cheat, coverage, h3_fit.`;

let analystFindings = {};
for (let turn = 0; turn < 8; turn++) {
  const res = await anthropic.messages.create({ model: 'claude-haiku-4-5-20251001', max_tokens: 1024, system: analystSystem, tools: ANALYST_TOOLS, messages: analystMsgs });
  analystMsgs.push({ role: 'assistant', content: res.content });
  if (res.stop_reason === 'end_turn') {
    const text = res.content.filter(b => b.type === 'text').map(b => b.text).join('');
    const m = text.match(/\{[\s\S]*\}/);
    if (m) { try { analystFindings = JSON.parse(m[0]); } catch {} }
    break;
  }
  if (res.stop_reason !== 'tool_use') break;
  const results = [];
  for (const b of res.content) {
    if (b.type !== 'tool_use') continue;
    let result;
    console.log(`  → ${b.name}`);
    if (b.name === 'scan_gps_quality') result = await scanGpsQuality();
    else if (b.name === 'scan_fence_shapes') result = await scanFenceShapes();
    else if (b.name === 'scan_anti_cheat_patterns') result = await scanAntiCheatPatterns();
    else if (b.name === 'scan_coverage_gaps') result = await scanCoverageGaps();
    else if (b.name === 'scan_h3_fit') result = await scanH3Fit();
    else result = { error: 'unknown' };
    console.log(`     ${JSON.stringify(result).slice(0, 100)}`);
    results.push({ type: 'tool_result', tool_use_id: b.id, content: JSON.stringify(result) });
  }
  analystMsgs.push({ role: 'user', content: results });
}
console.log('\nAnalyst findings collected.\n');

// ── Run Strategist ────────────────────────────────────────────────────────────

console.log('── Agent 2: Strategist (Sonnet) — writing to agent_findings ──');
const STRATEGIST_TOOLS = [{
  name: 'write_finding',
  description: 'Writes a finding + recommendation to agent_findings.',
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

const strategistSystem = `You are an internal product strategist for a running app that gamifies territory (H3 hex tiles, res-12, ~10.8m edge).
You receive data findings from an analyst and write concrete, actionable insights using the write_finding tool.

Data context:
- Anti-cheat flags are cosmetic — flagged runs still claim tiles. This is a known open item.
- Primary active district (8748a2066ffffff) has 4,292 tiles but 0 park path cells — park paths exist in adjacent districts.
- GPS recording: 2s cadence, 100m accuracy threshold (tuned to real device noise — do not suggest lowering it without device testing).
- territory_tiles has a unique constraint on h3: each cell belongs to exactly one owner.
- 30-day rolling leaderboard for mayorship per cell.

Write one finding per category that has meaningful data. End with a 'summary' category finding that names the top priority for next sprint.
Be specific: reference actual numbers. Recommendations must be concrete enough to implement.`;

const strategistMsgs = [{
  role: 'user',
  content: `Week of ${weekOf}. Analyst findings:\n\n${JSON.stringify(analystFindings, null, 2)}\n\nWrite findings and a weekly summary to the database.`,
}];

let written = 0;
for (let turn = 0; turn < 12; turn++) {
  // Force tool use on first turn so the model can't skip writing with prose.
  const toolChoice = written === 0 ? { type: 'any' } : { type: 'auto' };
  let res;
  try {
    res = await anthropic.messages.create({ model: 'claude-sonnet-5', max_tokens: 4096, system: strategistSystem, tools: STRATEGIST_TOOLS, tool_choice: toolChoice, messages: strategistMsgs });
  } catch (e) {
    console.log('  Strategist API error:', e.message);
    break;
  }
  console.log(`  turn ${turn}: stop_reason=${res.stop_reason} blocks=${res.content.length}`);
  for (const b of res.content) console.log(`    block type=${b.type}${b.type === 'text' ? ' text=' + b.text.slice(0, 80) : b.type === 'tool_use' ? ' name=' + b.name : ''}`);
  strategistMsgs.push({ role: 'assistant', content: res.content });
  if (res.stop_reason === 'end_turn') break;
  if (res.stop_reason !== 'tool_use') break;
  const results = [];
  for (const b of res.content) {
    if (b.type !== 'tool_use') continue;
    const inp = b.input;
    const { error } = await db.from('agent_findings').insert({ week_of: weekOf, category: inp.category, severity: inp.severity, finding: inp.finding, recommendation: inp.recommendation, evidence: inp.evidence ?? {} });
    if (error) { console.log(`  ✗ write_finding: ${error.message}`); console.log('    raw b.input:', JSON.stringify(b.input).slice(0, 200)); }
    else { written++; console.log(`  ✓ [${inp.severity}] ${inp.category}: ${inp.finding.slice(0, 80)}…`); }
    results.push({ type: 'tool_result', tool_use_id: b.id, content: JSON.stringify({ ok: !error }) });
  }
  strategistMsgs.push({ role: 'user', content: results });
}

console.log(`\n${written} finding(s) written to agent_findings (week_of=${weekOf}).`);
console.log('View in Supabase: Table Editor → agent_findings, or SQL: SELECT * FROM agent_findings ORDER BY created_at DESC;');

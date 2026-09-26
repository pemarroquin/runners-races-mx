// Territory Analysis — weekly internal cron (GET, Vercel cron trigger).
//
// Two-agent pipeline:
//   Agent 1 (Analyst, Haiku)   — queries all user data with tools, produces
//                                 structured JSON findings across five categories.
//   Agent 2 (Strategist, Sonnet) — receives the findings, thinks creatively about
//                                   fixes, writes each insight + a weekly summary
//                                   to the agent_findings Supabase table.
//
// Triggered every Monday at 04:30 MTY (10:30 UTC) via vercel.json crons.
// Manual trigger: GET /api/territory-analysis with Authorization: Bearer <CRON_SECRET>.
//
// Required env vars (server-only):
//   SUPABASE_SERVICE_KEY  — new sb_secret_... key; bypasses RLS for cross-user reads
//   ANTHROPIC_API_KEY
//   EXPO_PUBLIC_SUPABASE_URL
//   CRON_SECRET           — optional; required in production to gate the endpoint
import Anthropic from '@anthropic-ai/sdk';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { cellToCenterChild, cellToParent, getResolution, gridDisk } from 'h3-js';

export const maxDuration = 300;

 
type DB = SupabaseClient<any, any, any>;

const TILE_RES = 12;
const DISTRICT_RES = 7;

function serverSupabase(): DB {
  const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error('Missing SUPABASE_SERVICE_KEY or EXPO_PUBLIC_SUPABASE_URL');
  return createClient(url, key, { auth: { persistSession: false } });
}

// ─── Analyst tools ───────────────────────────────────────────────────────────

async function scanGpsQuality(db: DB): Promise<{
  totalRuns: number;
  flaggedRuns: number;
  flaggedPct: number;
  shortRunsUnder500m: number;
  avgDistanceM: number;
  suspiciousHighPaceCount: number;
}> {
  const { data, error } = await db
    .from('runs')
    .select('distance_m, duration_s, flagged')
    .limit(5000);
  if (error || !data) return { totalRuns: 0, flaggedRuns: 0, flaggedPct: 0, shortRunsUnder500m: 0, avgDistanceM: 0, suspiciousHighPaceCount: 0 };

  const rows = data as { distance_m: number; duration_s: number; flagged: boolean }[];
  const totalRuns = rows.length;
  const flaggedRuns = rows.filter((r) => r.flagged).length;
  const shortRunsUnder500m = rows.filter((r) => r.distance_m < 500).length;
  const avgDistanceM = totalRuns > 0 ? Math.round(rows.reduce((s, r) => s + (r.distance_m ?? 0), 0) / totalRuns) : 0;
  // Pace under 2:00 min/km (120 s/km) on a run longer than 200m is suspicious.
  const suspiciousHighPaceCount = rows.filter((r) => r.distance_m > 200 && r.duration_s / ((r.distance_m || 1) / 1000) < 120).length;

  return {
    totalRuns,
    flaggedRuns,
    flaggedPct: totalRuns > 0 ? Math.round((flaggedRuns / totalRuns) * 1000) / 10 : 0,
    shortRunsUnder500m,
    avgDistanceM,
    suspiciousHighPaceCount,
  };
}

async function scanFenceShapes(db: DB): Promise<{
  totalUsers: number;
  usersWithIsolatedCells: number;
  avgIsolatedPct: number;
  usersWithLargeHoles: number;
  avgConnectivity: number;
}> {
  // Sample up to 5000 tiles, compute connectivity stats per user.
  const { data, error } = await db
    .from('territory_tiles')
    .select('h3, owner_id')
    .limit(5000);
  if (error || !data) return { totalUsers: 0, usersWithIsolatedCells: 0, avgIsolatedPct: 0, usersWithLargeHoles: 0, avgConnectivity: 0 };

  const byUser = new Map<string, string[]>();
  for (const { h3, owner_id } of data as { h3: string; owner_id: string }[]) {
    if (getResolution(h3) !== TILE_RES) continue;
    const arr = byUser.get(owner_id) ?? [];
    arr.push(h3);
    byUser.set(owner_id, arr);
  }

  let totalIsolatedPct = 0;
  let usersWithIsolatedCells = 0;
  let usersWithLargeHoles = 0;
  let totalConnectivity = 0;
  let userCount = 0;

  for (const [, tiles] of byUser) {
    const tileSet = new Set(tiles);
    let isolated = 0;
    let totalNeighbors = 0;
    for (const h of tiles) {
      const neighbors = gridDisk(h, 1).filter((n) => n !== h && tileSet.has(n));
      totalNeighbors += neighbors.length;
      if (neighbors.length === 0) isolated++;
    }
    const isolatedPct = tiles.length > 0 ? (isolated / tiles.length) * 100 : 0;
    const avgNeighbors = tiles.length > 0 ? totalNeighbors / tiles.length : 0;
    totalIsolatedPct += isolatedPct;
    totalConnectivity += avgNeighbors;
    if (isolatedPct > 10) usersWithIsolatedCells++;
    // A large hole: any 3×3 gridDisk of owned tiles with a gap > 3 cells is a rough proxy.
    if (tiles.length > 20 && isolatedPct > 5) usersWithLargeHoles++;
    userCount++;
  }

  return {
    totalUsers: userCount,
    usersWithIsolatedCells,
    avgIsolatedPct: userCount > 0 ? Math.round((totalIsolatedPct / userCount) * 10) / 10 : 0,
    usersWithLargeHoles,
    avgConnectivity: userCount > 0 ? Math.round((totalConnectivity / userCount) * 10) / 10 : 0,
  };
}

async function scanAntiCheatPatterns(db: DB): Promise<{
  totalFlaggedRuns: number;
  uniqueUsersWithFlags: number;
  pctUsersWithFlags: number;
  topFlaggedUserTileCount: number;
}> {
  const { data: flagged, error: fe } = await db
    .from('runs')
    .select('user_id, flag_reason')
    .eq('flagged', true)
    .limit(2000);
  if (fe) return { totalFlaggedRuns: 0, uniqueUsersWithFlags: 0, pctUsersWithFlags: 0, topFlaggedUserTileCount: 0 };

  const rows = (flagged ?? []) as { user_id: string }[];
  const byUser = new Map<string, number>();
  for (const r of rows) { byUser.set(r.user_id, (byUser.get(r.user_id) ?? 0) + 1); }

  const topUser = [...byUser.entries()].sort((a, b) => b[1] - a[1])[0];
  let topFlaggedUserTileCount = 0;
  if (topUser) {
    const { count } = await db
      .from('territory_tiles')
      .select('*', { count: 'estimated', head: true })
      .eq('owner_id', topUser[0]);
    topFlaggedUserTileCount = count ?? 0;
  }

  const { count: totalUsers } = await db
    .from('territory_tiles')
    .select('owner_id', { count: 'estimated', head: true });

  return {
    totalFlaggedRuns: rows.length,
    uniqueUsersWithFlags: byUser.size,
    pctUsersWithFlags: totalUsers ? Math.round((byUser.size / totalUsers) * 1000) / 10 : 0,
    topFlaggedUserTileCount,
  };
}

async function scanCoverageGaps(db: DB): Promise<{
  districtsAnalyzed: number;
  districtsWithNoParkPaths: number;
  avgCoveragePct: number;
  lowestCoverageDistrict: string;
  lowestCoveragePct: number;
}> {
  const { data: tiles } = await db.from('territory_tiles').select('h3').limit(5000);
  if (!tiles?.length) return { districtsAnalyzed: 0, districtsWithNoParkPaths: 0, avgCoveragePct: 0, lowestCoverageDistrict: '', lowestCoveragePct: 0 };

  // Build district set from owned tiles.
  const districts = new Set<string>();
  for (const { h3 } of tiles as { h3: string }[]) {
    if (getResolution(h3) === TILE_RES) districts.add(cellToParent(h3, DISTRICT_RES));
  }

  const results: { district: string; owned: number; paths: number; pct: number }[] = [];
  for (const district of districts) {
    const pattern = `${cellToCenterChild(district, TILE_RES).slice(0, 2 + DISTRICT_RES)}%`;
    const [{ count: owned }, { count: paths }] = await Promise.all([
      db.from('territory_tiles').select('*', { count: 'estimated', head: true }).like('h3', pattern),
      db.from('park_path_cells').select('*', { count: 'estimated', head: true }).like('h3', pattern),
    ]);
    const pct = (paths ?? 0) > 0 ? Math.round(((owned ?? 0) / (paths ?? 1)) * 1000) / 10 : 0;
    results.push({ district, owned: owned ?? 0, paths: paths ?? 0, pct });
  }

  const withPaths = results.filter((r) => r.paths > 0);
  const avgCoveragePct = withPaths.length > 0
    ? Math.round(withPaths.reduce((s, r) => s + r.pct, 0) / withPaths.length * 10) / 10
    : 0;
  const lowest = withPaths.sort((a, b) => a.pct - b.pct)[0];

  return {
    districtsAnalyzed: results.length,
    districtsWithNoParkPaths: results.filter((r) => r.paths === 0).length,
    avgCoveragePct,
    lowestCoverageDistrict: lowest?.district ?? '',
    lowestCoveragePct: lowest?.pct ?? 0,
  };
}

async function scanH3Fit(db: DB): Promise<{
  avgTilesPerKm: number;
  runsWithHighNoiseTileDensity: number;
  runsWithLowTileDensity: number;
  totalRunsAnalyzed: number;
}> {
  // Tiles claimed per km run is the key signal. Expected ~3-10 tiles/km for
  // a coherent run. Very high = GPS noise being promoted to tiles.
  // Very low = routing mismatch or very fast transit run.
  const { data: runs } = await db
    .from('runs')
    .select('distance_m')
    .gt('distance_m', 0)
    .limit(2000);
  const { data: tiles } = await db
    .from('territory_tiles')
    .select('owner_id, h3')
    .limit(5000);

  if (!runs?.length || !tiles?.length) {
    return { avgTilesPerKm: 0, runsWithHighNoiseTileDensity: 0, runsWithLowTileDensity: 0, totalRunsAnalyzed: 0 };
  }

  const tilesByUser = new Map<string, number>();
  for (const { owner_id } of tiles as { owner_id: string }[]) {
    tilesByUser.set(owner_id, (tilesByUser.get(owner_id) ?? 0) + 1);
  }
  const runsByUser = new Map<string, number[]>();
  for (const r of runs as { distance_m: number; owner_id?: string }[]) {
    // runs doesn't expose owner_id in this select — approximate globally
    const km = (r.distance_m ?? 0) / 1000;
    if (km > 0) {
      const arr = runsByUser.get('__all__') ?? [];
      arr.push(km);
      runsByUser.set('__all__', arr);
    }
  }

  const allKm = runsByUser.get('__all__') ?? [];
  const totalKm = allKm.reduce((s, v) => s + v, 0);
  const totalTiles = [...tilesByUser.values()].reduce((s, v) => s + v, 0);
  const avgTilesPerKm = totalKm > 0 ? Math.round((totalTiles / totalKm) * 10) / 10 : 0;

  // Proxy for high noise: runs under 300m that still claimed tiles.
  const { data: shortTiled } = await db
    .from('runs')
    .select('id')
    .lt('distance_m', 300)
    .eq('flagged', false)
    .limit(500);

  return {
    avgTilesPerKm,
    runsWithHighNoiseTileDensity: shortTiled?.length ?? 0,
    runsWithLowTileDensity: 0,
    totalRunsAnalyzed: runs.length,
  };
}

// ─── Strategist write tools ───────────────────────────────────────────────────

async function writeFinding(
  db: DB,
  weekOf: string,
  category: string,
  severity: string,
  finding: string,
  recommendation: string,
  evidence: Record<string, unknown>,
): Promise<{ ok: boolean }> {
  const { error } = await db.from('agent_findings').insert({
    week_of: weekOf,
    category,
    severity,
    finding,
    recommendation,
    evidence,
  });
  return { ok: !error };
}

// ─── Tool definitions ─────────────────────────────────────────────────────────

const ANALYST_TOOLS: Anthropic.Tool[] = [
  {
    name: 'scan_gps_quality',
    description: 'Scans all runs for GPS quality signals: flagged anti-cheat rate, short runs, suspicious pace outliers.',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'scan_fence_shapes',
    description: 'Analyzes H3 tile connectivity per user: isolated cells (no owned neighbors), average connectivity, proxy for large holes.',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'scan_anti_cheat_patterns',
    description: 'Aggregates anti-cheat flags across all users: how many users have flagged runs, concentration patterns.',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'scan_coverage_gaps',
    description: 'Per-district park-path coverage: which districts have no park path data, which have the lowest coverage %.',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'scan_h3_fit',
    description: 'Analyzes whether H3 res-12 tiles match the granularity of actual runs: tiles per km, noise tile density.',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
];

const STRATEGIST_TOOLS: Anthropic.Tool[] = [
  {
    name: 'write_finding',
    description: 'Writes one finding + recommendation to the agent_findings table for Pedro to review.',
    input_schema: {
      type: 'object' as const,
      properties: {
        category: {
          type: 'string',
          enum: ['gps_quality', 'fence_shapes', 'anti_cheat', 'coverage', 'h3_fit', 'summary'],
          description: 'Which analysis category this finding belongs to',
        },
        severity: {
          type: 'string',
          enum: ['info', 'warning', 'critical'],
          description: 'How urgent this finding is',
        },
        finding: {
          type: 'string',
          description: 'Concrete, specific description of what was found in the data',
        },
        recommendation: {
          type: 'string',
          description: 'Specific, actionable fix or improvement to implement in the codebase or data pipeline',
        },
        evidence: {
          type: 'object',
          description: 'Key metrics from the data that support this finding',
        },
      },
      required: ['category', 'severity', 'finding', 'recommendation', 'evidence'],
    },
  },
];

// ─── Handler ──────────────────────────────────────────────────────────────────

export async function GET(request: Request): Promise<Response> {
  // Gate with CRON_SECRET when set (required in production).
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const auth = request.headers.get('authorization');
    if (auth !== `Bearer ${cronSecret}`) {
      return new Response('Unauthorized', { status: 401 });
    }
  }

  const missingVars = ['SUPABASE_SERVICE_KEY', 'ANTHROPIC_API_KEY', 'EXPO_PUBLIC_SUPABASE_URL'].filter(
    (v) => !process.env[v],
  );
  if (missingVars.length > 0) {
    return new Response(
      JSON.stringify({ error: `Server misconfigured: missing ${missingVars.join(', ')}` }),
      { status: 503 },
    );
  }

  const db = serverSupabase();
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const weekOf = new Date().toISOString().slice(0, 10);

  // ── Agent 1: Analyst (Haiku — cheap, tool-heavy) ──────────────────────────
  const analystSystem = `You are an internal data analyst for a running app that gamifies territory.
Users run real streets and claim H3 hex tiles. Your job is to call ALL five scan tools,
collect their results, and return a structured JSON object with the findings.

Call every tool exactly once. After all five tool calls complete, return ONLY a JSON object
with keys: gps_quality, fence_shapes, anti_cheat, coverage, h3_fit — each containing the
raw tool result. No prose, no commentary — just the JSON.`;

  const analystMessages: Anthropic.MessageParam[] = [
    { role: 'user', content: 'Run all five scans and return the combined findings as JSON.' },
  ];

  let analystFindings: Record<string, unknown> = {};
  for (let turn = 0; turn < 8; turn++) {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      system: analystSystem,
      tools: ANALYST_TOOLS,
      messages: analystMessages,
    });
    analystMessages.push({ role: 'assistant', content: response.content });

    if (response.stop_reason === 'end_turn') {
      const text = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('');
      try {
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) analystFindings = JSON.parse(jsonMatch[0]);
      } catch { /* keep empty */ }
      break;
    }
    if (response.stop_reason !== 'tool_use') break;

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type !== 'tool_use') continue;
      let result: unknown;
      try {
        if (block.name === 'scan_gps_quality') result = await scanGpsQuality(db);
        else if (block.name === 'scan_fence_shapes') result = await scanFenceShapes(db);
        else if (block.name === 'scan_anti_cheat_patterns') result = await scanAntiCheatPatterns(db);
        else if (block.name === 'scan_coverage_gaps') result = await scanCoverageGaps(db);
        else if (block.name === 'scan_h3_fit') result = await scanH3Fit(db);
        else result = { error: 'unknown tool' };
      } catch (e) {
        result = { error: String(e) };
      }
      toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(result) });
    }
    analystMessages.push({ role: 'user', content: toolResults });
  }

  // ── Agent 2: Strategist (Sonnet — creative synthesis, writes to DB) ────────
  const strategistSystem = `You are an internal product strategist for a running app that gamifies territory (H3 hex tiles).
You receive structured data findings from an analyst agent and your job is to:
1. Interpret each finding critically — what does it actually mean for the system?
2. Think outside the box about fixes — not just obvious patches, but architectural improvements.
3. Write every meaningful finding using the write_finding tool.
4. End with one 'summary' category finding that synthesizes the week's key themes and top priority.

Data context:
- H3 resolution 12 (~10.8m hex edge) for tiles, resolution 7 for districts (~5.16 km²)
- Anti-cheat: live pace guard + p90 server trigger; flagged is still cosmetic (no tiles withheld)
- Park paths: 36,193 cells loaded in Monterrey; primary active district has 0 park paths
- GPS recording: 2s cadence, 100m accuracy threshold (tuned against real device noise)
- Territory is first-to-claim, 30-day rolling leaderboard for mayorship
- Runs table has RLS 'select own' — anon key returns [] for other users

Be specific. Reference actual numbers from the data. Your recommendations must be concrete
enough that a developer could implement them next sprint.`;

  const strategistMessages: Anthropic.MessageParam[] = [
    {
      role: 'user',
      content: `Week of ${weekOf}. Here are the analyst findings:\n\n${JSON.stringify(analystFindings, null, 2)}\n\nWrite all meaningful findings and a weekly summary.`,
    },
  ];

  let findingsWritten = 0;
  for (let turn = 0; turn < 10; turn++) {
    const response = await client.messages.create({
      model: 'claude-sonnet-5',
      max_tokens: 4096,
      system: strategistSystem,
      tools: STRATEGIST_TOOLS,
      messages: strategistMessages,
    });
    strategistMessages.push({ role: 'assistant', content: response.content });

    if (response.stop_reason === 'end_turn') break;
    if (response.stop_reason !== 'tool_use') break;

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type !== 'tool_use') continue;
      const inp = block.input as Record<string, unknown>;
      let result: unknown;
      try {
        const ok = await writeFinding(
          db,
          weekOf,
          inp.category as string,
          inp.severity as string,
          inp.finding as string,
          inp.recommendation as string,
          (inp.evidence as Record<string, unknown>) ?? {},
        );
        result = ok;
        if (ok.ok) findingsWritten++;
      } catch (e) {
        result = { ok: false, error: String(e) };
      }
      toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(result) });
    }
    strategistMessages.push({ role: 'user', content: toolResults });
  }

  return new Response(
    JSON.stringify({ ok: true, weekOf, findingsWritten }),
    { headers: { 'Content-Type': 'application/json' } },
  );
}

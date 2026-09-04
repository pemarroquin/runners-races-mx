#!/usr/bin/env node
// Audits every saved territory for cheat signatures, and ranks them.
//
// Built from measured evidence, not guesses — see
// `Source Data/Outputs/Running App/ANTI-CHEAT-EVIDENCE.md` for the three
// runs these thresholds were derived from (two drives and one real walk/jog)
// and why each one is shaped the way it is. The short version:
//
//   - Never judge on MAX speed. A genuine run in that sample contains a
//     single 171 km/h GPS glitch. Sustained windows and percentiles only.
//   - A 30 s window at 20 km/h separated drives from the real run with a 5x
//     margin (12.1 vs 58.7 / 60.2 km/h).
//   - area > perimeter^2 / 4*pi is arithmetically impossible for a closed
//     loop. Zero false positives — but it caught only one of the two drives,
//     so it is never the only check.
//   - The fabricated area came from closing a 2 489 m gap between the first
//     and last fix. That is the highest-leverage geometric signal.
//
// Read-only. Uses the anon key and the `runs: read all` policy; it cannot
// modify or delete anything. Run it after any batch of new runs:
//
//   npm run audit-territories            # summary, worst first
//   npm run audit-territories -- --json  # machine-readable
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Thresholds. Each cites the evidence that set it — change them against new
 *  measurements, never against intuition. */
const RULES = {
  // Real run peaked at 12.1 km/h over 30 s; both drives exceeded 58.
  SUSTAINED_WINDOW_S: 30,
  SUSTAINED_KMH: 20,
  // Real run: 387 m. Drives: 1 402 m and 2 489 m.
  MAX_CLOSURE_GAP_M: 750,
  // Real 12 m2/m; drives 91 and 296. A sort key, not a verdict.
  AREA_PER_METRE_REVIEW: 40,
};

function env(name) {
  const raw = readFileSync(path.join(ROOT, '.env.local'), 'utf8');
  const line = raw.split('\n').find((l) => l.startsWith(`${name}=`));
  return line?.slice(name.length + 1).trim().replace(/^["']|["']$/g, '');
}

const R = 6371000;
const rad = (d) => (d * Math.PI) / 180;
function haversine(a, b) {
  const dLat = rad(b[0] - a[0]);
  const dLng = rad(b[1] - a[1]);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Fastest average speed (km/h) sustained over any `windowS`-second window.
 *  This is the measurement that matters — see the header. */
function maxSustainedKmh(path_, windowS) {
  if (!Array.isArray(path_) || path_.length < 2) return 0;
  const t = path_.map((p) => p[2] / 1000);
  const cum = [0];
  for (let i = 1; i < path_.length; i++) cum.push(cum[i - 1] + haversine(path_[i - 1], path_[i]));
  let best = 0;
  let j = 0;
  for (let i = 0; i < path_.length; i++) {
    while (t[i] - t[j] > windowS) j++;
    const dt = t[i] - t[j];
    // Require most of a full window, or a couple of fixes at the very start
    // of a run would each look like an instantaneous reading.
    if (dt >= windowS * 0.8) best = Math.max(best, ((cum[i] - cum[j]) / dt) * 3.6);
  }
  return best;
}

/** Outer-ring area and perimeter in m^2 / m, equirectangular about `lat0`
 *  (accurate well past the scale of any single run). */
function ringMetrics(ring, lat0) {
  const mx = 111320 * Math.cos(rad(lat0));
  const my = 110540;
  const pts = ring.map(([lng, lat]) => [lng * mx, lat * my]);
  let area = 0;
  let per = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % pts.length];
    area += x1 * y2 - x2 * y1;
    per += Math.hypot(x2 - x1, y2 - y1);
  }
  return { area: Math.abs(area) / 2, perimeter: per };
}

function audit(run) {
  const p = run.raw_path ?? [];
  const reasons = [];
  const sustained = maxSustainedKmh(p, RULES.SUSTAINED_WINDOW_S);
  if (sustained > RULES.SUSTAINED_KMH) {
    reasons.push(`sustained ${sustained.toFixed(1)} km/h over ${RULES.SUSTAINED_WINDOW_S}s`);
  }

  // Arithmetically impossible area for the distance travelled. No false
  // positives are possible here, so it is stated as a fact, not a suspicion.
  const ceiling = run.distance_m ** 2 / (4 * Math.PI);
  const ratio = ceiling > 0 ? run.area_m2 / ceiling : 0;
  if (ratio > 1) reasons.push(`area is ${ratio.toFixed(2)}x the most its own path can enclose`);

  let gap = null;
  if (p.length >= 2) {
    gap = haversine(p[0], p[p.length - 1]);
    if (gap > RULES.MAX_CLOSURE_GAP_M) {
      reasons.push(`fence closed across a ${Math.round(gap)} m gap`);
    }
  }

  const perMetre = run.distance_m > 0 ? run.area_m2 / run.distance_m : 0;
  if (perMetre > RULES.AREA_PER_METRE_REVIEW) {
    reasons.push(`${perMetre.toFixed(0)} m2 banked per metre run`);
  }

  let fence = null;
  if (run.fence?.coordinates) {
    const rings =
      run.fence.type === 'Polygon' ? run.fence.coordinates : run.fence.coordinates.map((c) => c[0]);
    fence = ringMetrics(rings[0], p[0]?.[0] ?? 25.67);
  }

  return {
    id: run.id,
    startedAt: run.started_at,
    distanceM: run.distance_m,
    durationS: run.duration_s,
    areaM2: Math.round(run.area_m2),
    avgKmh: run.duration_s > 0 ? +((run.distance_m / run.duration_s) * 3.6).toFixed(1) : 0,
    sustainedKmh: +sustained.toFixed(1),
    closureGapM: gap === null ? null : Math.round(gap),
    areaPerMetre: +perMetre.toFixed(1),
    impossibleAreaRatio: +ratio.toFixed(2),
    fencePerimeterM: fence ? Math.round(fence.perimeter) : null,
    flaggedInDb: run.flagged,
    reasons,
  };
}

const url = env('EXPO_PUBLIC_SUPABASE_URL');
const key = env('EXPO_PUBLIC_SUPABASE_ANON_KEY');
if (!url || !key) {
  console.error('Missing EXPO_PUBLIC_SUPABASE_URL / _ANON_KEY in .env.local');
  process.exit(1);
}

const res = await fetch(`${url}/rest/v1/runs?select=*&order=started_at.desc`, {
  headers: { apikey: key, Authorization: `Bearer ${key}` },
});
if (!res.ok) {
  console.error(`Supabase returned ${res.status}: ${await res.text()}`);
  process.exit(1);
}

const runs = await res.json();
const audited = runs.map(audit);
const suspect = audited
  .filter((a) => a.reasons.length > 0)
  .sort((a, b) => b.reasons.length - a.reasons.length || b.sustainedKmh - a.sustainedKmh);

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ total: audited.length, suspect }, null, 2));
} else {
  console.log(`\n${audited.length} runs audited — ${suspect.length} with at least one signal.\n`);
  for (const a of suspect) {
    console.log(`${a.startedAt.slice(0, 16).replace('T', ' ')}  ${a.id.slice(0, 8)}`);
    console.log(
      `   ${a.distanceM} m in ${Math.round(a.durationS / 60)} min · avg ${a.avgKmh} km/h · ` +
        `sustained ${a.sustainedKmh} km/h · ${a.areaM2.toLocaleString()} m2` +
        (a.closureGapM === null ? '' : ` · gap ${a.closureGapM} m`),
    );
    for (const r of a.reasons) console.log(`   - ${r}`);
    if (a.flaggedInDb) console.log('   (already flagged in the database)');
    console.log();
  }
  // An empty `flagged` column reads exactly like "no cheating happened".
  // Say what was actually checked so a clean report cannot be misread.
  console.log(
    `Checked: sustained speed over ${RULES.SUSTAINED_WINDOW_S}s > ${RULES.SUSTAINED_KMH} km/h, ` +
      `impossible area, closure gap > ${RULES.MAX_CLOSURE_GAP_M} m, ` +
      `> ${RULES.AREA_PER_METRE_REVIEW} m2 per metre.`,
  );
}

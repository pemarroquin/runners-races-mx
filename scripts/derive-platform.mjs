// Write `platform` on every race in races.json from its signupUrl/sourceUrl.
// Idempotent. `npm run derive-platform [-- --dry-run]`. verify-sweep fails if
// a record's platform disagrees with this, so run it after editing URLs.
import { readFileSync, writeFileSync } from 'node:fs';
import { platformOf } from './lib/platforms.mjs';

const DATA_PATH = 'assets/data/races.json';
const dryRun = process.argv.includes('--dry-run');
const doc = JSON.parse(readFileSync(DATA_PATH, 'utf8'));

let changed = 0;
doc.races = doc.races.map((r) => {
  const platform = platformOf(r);
  if (r.platform === platform) return r;
  changed++;
  // Keep key order readable: platform sits right after organizer.
  const out = {};
  for (const [k, v] of Object.entries(r)) {
    if (k === 'platform') continue;
    out[k] = v;
    if (k === 'organizer') out.platform = platform;
  }
  if (!('platform' in out)) out.platform = platform;
  return out;
});

const counts = {};
for (const r of doc.races) counts[r.platform ?? 'null'] = (counts[r.platform ?? 'null'] ?? 0) + 1;
console.log(`derive-platform: ${changed} race(s) updated${dryRun ? ' (dry run)' : ''}`);
console.log(Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([k, v]) => `  ${k}: ${v}`).join('\n'));
if (!dryRun && changed > 0) writeFileSync(DATA_PATH, JSON.stringify(doc, null, 2) + '\n');

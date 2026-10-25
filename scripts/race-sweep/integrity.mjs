// Independent before/after integrity check for the races.json merge.
// usage: node integrity.mjs <before.json> <after.json> <found-dir>
import { readFileSync, readdirSync } from 'node:fs';
const [,, beforeP, afterP, foundDir] = process.argv;
const before = JSON.parse(readFileSync(beforeP, 'utf8'));
const after = JSON.parse(readFileSync(afterP, 'utf8'));
const errs = [], warns = [];
const TAGS = new Set(['3K','5K','10K','15K','Half','30K','Full','Ultra','TBD']);
const STATES = new Set(['Nuevo León','Ciudad de México','Estado de México','Jalisco','Querétaro','Puebla','Yucatán','Baja California','Guanajuato','Quintana Roo','San Luis Potosí','Coahuila','Chihuahua']);
const safe = (u) => typeof u === 'string' && !/[\u0000-\u001f\u007f]/.test(u) && /^https?:\/\/[^\s]+$/i.test(u);
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// expected changes, from the agents' files
let expNew = 0; const expUpdated = new Set(); const explicitNull = new Set();
for (const f of readdirSync(foundDir).filter(f => f.endsWith('.json'))) {
  for (const it of JSON.parse(readFileSync(`${foundDir}/${f}`, 'utf8'))) {
    if (it.kind === 'new' || it.kind === 'next-edition') expNew++;
    else if (it.existingId) { expUpdated.add(it.existingId); if (it.kind === 'correction') for (const k of Object.keys(it)) if (it[k] === null) explicitNull.add(`${it.existingId}.${k}`); }
    // route pass (found/routes-<State>.json): rows keyed by `id`, an update only when it supplies a pin/map
    else if (f.startsWith('routes-') && it.id && (it.start || it.courseMapUrl || it.routeCoords)) expUpdated.add(it.id);
  }
}

if (!eq(Object.keys(before), Object.keys(after))) errs.push('top-level keys changed');
const B = new Map(before.races.map(r => [r.id, r]));
const A = new Map(); for (const r of after.races) { if (A.has(r.id)) errs.push(`duplicate id ${r.id}`); A.set(r.id, r); }

// 1. no loss: every old row still present; untouched rows byte-identical; updated rows lose no data
let changed = 0;
for (const [id, b] of B) {
  const a = A.get(id);
  if (!a) { errs.push(`LOST row ${id}`); continue; }
  if (eq(a, b)) continue;
  changed++;
  if (!expUpdated.has(id)) errs.push(`row ${id} changed but no agent asked to update it`);
  for (const k of Object.keys(b)) {
    if (!(k in a)) { if (k === 'start') warns.push(`${id}: start dropped (venue moved?)`); else errs.push(`${id}: field ${k} removed`); }
    else if (b[k] !== null && a[k] === null) (k === 'signupUrl' && explicitNull.has(`${id}.${k}`) ? warns : errs).push(`${id}: ${k} nulled (was ${JSON.stringify(b[k])})`);
  }
  for (const k of Object.keys(b)) if (Array.isArray(b[k]) && Array.isArray(a[k]) && k !== 'distanceTags') {
    const gone = b[k].filter(v => !a[k].some(w => JSON.stringify(w) === JSON.stringify(v)));
    if (gone.length) warns.push(`${id}: ${k} lost ${JSON.stringify(gone)} (now ${JSON.stringify(a[k])}) — review`);
  }
  for (const k of ['notes','notesEs']) if (typeof b[k] === 'string' && b[k] && typeof a[k] === 'string' && !a[k].includes(b[k])) warns.push(`${id}: ${k} replaced, old text gone — review ("${b[k].slice(0,60)}")`);
  if (a.state !== b.state) errs.push(`${id}: state changed ${b.state} -> ${a.state}`);
}
// 2. every row valid (mirrors isValidRace + verify-sweep basics)
for (const r of after.races) {
  const id = r.id;
  if (!id || !r.name) errs.push(`row missing id/name: ${JSON.stringify(r).slice(0,80)}`);
  if (typeof r.city !== 'string' || !r.city) errs.push(`${id}: bad city`);
  if (!STATES.has(r.state)) errs.push(`${id}: bad state ${r.state}`);
  if (!safe(r.sourceUrl)) errs.push(`${id}: bad sourceUrl`);
  for (const k of ['signupUrl','courseMapUrl']) if (r[k] != null && !safe(r[k])) errs.push(`${id}: bad ${k}`);
  if (r.signupUrl && /[?&](utm_|fbclid|gclid)/.test(r.signupUrl)) errs.push(`${id}: tracking params in signupUrl`);
  if (!Array.isArray(r.distances)) errs.push(`${id}: distances not array`);
  if (!Array.isArray(r.distanceTags) || !r.distanceTags.length || !r.distanceTags.every(t => TAGS.has(t))) errs.push(`${id}: bad distanceTags ${JSON.stringify(r.distanceTags)}`);
  if (r.date !== null && !/^\d{4}-\d{2}-\d{2}$/.test(r.date ?? '')) errs.push(`${id}: bad date ${r.date}`);
  if (r.date && !B.has(id) && r.date < '2026-10-20') errs.push(`${id}: new row dated in the past ${r.date}`);
  if (r.time != null && !/^\d{2}:\d{2}$/.test(r.time)) errs.push(`${id}: bad time ${r.time}`);
  if (!['high','medium','low'].includes(r.confidence)) errs.push(`${id}: bad confidence`);
  if ('kind' in r || 'existingId' in r) errs.push(`${id}: internal field leaked`);
  if ((!B.has(id) || !eq(r, B.get(id))) && r.notes && /(could not verify|as of 20|sourceUrl|calendario de|según (el|la) (calendario|fuente)|single-calendar|tritour|runera)/i.test(r.notes)) warns.push(`${id}: notes may contain research talk`);
  if (r.status && r.status !== 'ok' && !r.statusNoteEs) errs.push(`${id}: ${r.status} without statusNoteEs`);
}
// 3. counts reconcile
const added = [...A.keys()].filter(id => !B.has(id)).length;
if (added !== expNew) errs.push(`added ${added} rows, agents supplied ${expNew} new/next-edition`);
for (const id of expUpdated) if (!B.has(id)) errs.push(`agent referenced unknown existingId ${id}`);

console.log(`rows ${before.races.length} -> ${after.races.length} | added ${added} (expected ${expNew}) | updated ${changed} (requested ${expUpdated.size})`);
warns.forEach(w => console.log('WARN', w));
errs.forEach(e => console.log('ERROR', e));
console.log(errs.length ? `FAIL (${errs.length} errors)` : 'PASS');
process.exit(errs.length ? 1 : 0);

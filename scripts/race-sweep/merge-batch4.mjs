// 2027 calendar sweep merge, batch 4.
// usage: node merge-batch4.mjs <before.json> <out races.json> <found-dir> <State> [<State> ...]
// Rebuilds <out> from <before> (2-space JSON + trailing newline, the file's canonical form).
import { readFileSync, writeFileSync } from 'node:fs';

const [,, beforePath, racesPath, foundDir, ...states] = process.argv;
const TODAY = '2026-10-24';
const doc = JSON.parse(readFileSync(beforePath, 'utf8'));
const races = doc.races;
const ids = new Set(races.map((r) => r.id));
const byId = new Map(races.map((r) => [r.id, r]));
const ORDER = ['id', 'name', 'date', 'time', 'distances', 'distanceTags', 'city', 'state', 'venue', 'organizer', 'signupUrl', 'sourceUrl', 'confidence', 'notes', 'notesEs', 'sourceNotes'];
const TAG_ORDER = ['3K', '5K', '10K', '15K', 'Half', '30K', 'Full', 'Ultra'];

// Per-row overrides for corrections (status banner copy) — the agent files don't carry these.
const STATUS = {
  '3a-carrera-pericos': {
    statusNote: 'New date: Sunday 13 December 2026 at 7:00 a.m. (was 6 December).',
    statusNoteEs: 'Nueva fecha: domingo 13 de diciembre de 2026 a las 7:00 a.m. (antes 6 de diciembre).',
  },
};
// Rows removed outright (main-session ruling). Ultra X has no Mexico edition on the organizer's
// 2026-27 calendar; the old source 404s; the only ITRA listing is 2019 (also Nov 2) — a 2019 date
// carried forward, not a cancelled 2026 race, so a "canceled" banner would be false too.
const REMOVE = new Set();
const KEEP_OLD_NOTES = new Set(['medio-maraton-21k-coahuila-edicion-2027']);
// Venue text refined, same spot: the existing start pin (25.6757,-100.2820) IS the Grúa Portal.
const SAME_PLACE = new Set(['3a-carrera-pericos', 'medio-maraton-21k-coahuila-edicion-2027']);
// Notes rewritten by hand on in-place rows: Batman's "Registration open" sentence is now false.
const NOTES_OVERRIDE = {
  '3a-carrera-pericos': {
    notes: '3K, 5K and 10K at the Hermanos Serdán baseball stadium, a race by the Pericos de Puebla baseball club. $418 MXN per distance.',
    notesEs: 'Carrera de 3K, 5K y 10K en el Estadio de Béisbol Hermanos Serdán, del club de béisbol Pericos de Puebla. $418 MXN por distancia.',
  },
  'maraton-internacional-lala-comarca-lagunera-edic': {
    notes: 'XXXVIII edition. Flagship Comarca Lagunera marathon. Starts in Gómez Palacio, Durango; finishes in Torreón (tagged under Coahuila for the finish city). Capped at 4,500 runners, 6 h 30 min time limit. Registration 15 October to 13 November 2026: $1,275 MXN until 31 October, $1,450 after. Kit pickup 5 and 6 March at the Centro de Convenciones Torreón.',
    notesEs: 'XXXVIII edición. Maratón insignia de la Comarca Lagunera. Sale de Gómez Palacio, Durango, y termina en Torreón (etiquetada bajo Coahuila por la ciudad de meta). Cupo de 4,500 corredores, tiempo límite de 6 h 30 min. Inscripciones del 15 de octubre al 13 de noviembre de 2026: $1,275 MXN hasta el 31 de octubre, $1,450 después. Entrega de kits el 5 y 6 de marzo en el Centro de Convenciones Torreón.',
  },
};
// Aggregator-only source (haid.app listing, official Spartan page not found): downgrade the agent's medium.
// 21K Coahuila: the agent's "correction" keeps the same date and only fills time/venue, so it is an enrichment (no banner).
const KIND_OVERRIDE = { 'medio-maraton-21k-coahuila-edicion-2027': 'date-undated' };
const CONF_OVERRIDE = { 'Spartan San Luis Potosí Parque Tangamanga 2026': 'low' };

const ID_OVERRIDE = {};
// Fields an in-place update may write, per kind. No 'name' this batch: the agents' names carry
// "(cancelada)" / year suffixes that would rename stable rows.
const UPDATE_FIELDS = {
  'date-undated': ['date', 'time', 'distances', 'venue', 'signupUrl', 'sourceUrl', 'confidence', 'notes', 'notesEs'],
  correction: ['date', 'time', 'venue', 'city', 'signupUrl', 'organizer', 'distances', 'sourceUrl', 'confidence', 'notes', 'notesEs'],
};
const SOURCE_NOTES_OVERRIDE = {};
// The NL and Jalisco agents wrote Spanish into the English `notes` field (notes === notesEs).
const NOTES_EN = {};
const usedNotesEn = new Set();
function fixNotesLang(it) {
  if (it.notes && it.notes === it.notesEs) {
    if (!NOTES_EN[it.name]) throw new Error(`Spanish in notes, no English for ${it.name}`);
    usedNotesEn.add(it.name);
    return { ...it, notes: NOTES_EN[it.name] };
  }
  return it;
}

const LEAK = /(could not verify|as of 20|sourceUrl|calendario de|según (el|la) (calendario|fuente)|single-calendar|tritour|runera|\bsource\b|fuente|verif)/i;

function km(d) {
  const s = d.toLowerCase();
  if (/infantil|caminata|kids|walk/.test(s)) return 1;
  if (/backyard/.test(s)) return 100;
  let m;
  if ((m = s.match(/^([\d.]+)\s*m$/))) return Number(m[1]) / 1000;
  if ((m = s.match(/^([\d.]+)\s*millas?\b/))) return Number(m[1]) * 1.609;
  if ((m = s.match(/^([\d.]+)\s*k/))) return Number(m[1]);
  throw new Error(`unparsed distance ${d}`);
}
function tagFor(d) {
  if (/loop/i.test(d)) return 'Ultra'; // timed multi-lap event (LOOP 12 Horas): the lap length isn't the race distance
  const k = km(d);
  if (k < 4) return '3K';
  if (k <= 7) return '5K';
  if (k < 11.5) return '10K';
  if (k < 18) return '15K';
  if (k < 25) return 'Half';
  if (k < 38) return '30K';
  if (k <= 45) return 'Full';
  return 'Ultra';
}
const sortD = (ds) => [...ds].sort((a, b) => km(a) - km(b));
const tags = (ds) => (ds.length ? TAG_ORDER.filter((t) => ds.map(tagFor).includes(t)) : ['TBD']);

function cleanUrl(u) {
  if (!u) return u;
  const url = new URL(u);
  let hit = false;
  for (const k of [...url.searchParams.keys()]) if (/^utm_|^fbclid$|^gclid$/i.test(k)) { hit = true; url.searchParams.delete(k); }
  return hit ? url.toString() : u;
}
const slug = (s) => {
  let x = s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[®°ª]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (x.length > 48) x = x.slice(0, 48).replace(/-[^-]*$/, '');
  return x;
};
const norm = (s) => slug(s).replace(/-?20\d\d-?/g, '');

// move research-talk sentences out of notes
function splitNotes(notes, sourceNotes, id, log) {
  if (!notes) return [notes, sourceNotes];
  const sentences = notes.split(/(?<=[.!?])\s+/);
  const keep = sentences.filter((s) => !LEAK.test(s));
  const moved = sentences.filter((s) => LEAK.test(s));
  if (!moved.length) return [notes, sourceNotes];
  log.push(`${id}: moved from notes to sourceNotes: ${JSON.stringify(moved.join(' '))}`);
  return [keep.join(' ') || null, [sourceNotes, ...moved].filter(Boolean).join(' ')];
}

const report = {};
const batchKeys = new Set();
for (const state of states) {
  const items = JSON.parse(readFileSync(`${foundDir}/${state.replace(/ /g, '_')}.json`, 'utf8'));
  const r = (report[state] = { new: 0, nextEdition: 0, dateUndated: 0, correction: 0, rejected: [], collisions: [], log: [] });
  for (const it0 of items) {
    const it = fixNotesLang(it0);
    if (it.existingId && KIND_OVERRIDE[it.existingId]) it.kind = KIND_OVERRIDE[it.existingId];
    if (it.state !== state) { r.rejected.push(`${it.name}: state ${it.state} != ${state}`); continue; }
    const key = `${norm(it.name)}|${it.date}|${it.state}`;
    if (it.kind === 'new' || it.kind === 'next-edition') {
      if (batchKeys.has(key)) { r.rejected.push(`${it.name}: duplicate within batch`); continue; }
      batchKeys.add(key);
      if (it.date && it.date < TODAY) { r.rejected.push(`${it.name}: new row dated in the past (${it.date})`); continue; }
      let id = ID_OVERRIDE[it.name] ?? slug(it.name);
      if (ids.has(id) || (it.kind === 'next-edition' && id === it.existingId)) {
        const base = id;
        const yr = it.date?.slice(0, 4);
        id = yr && !base.endsWith(yr) ? `${base}-${yr}` : `${base}-${slug(it.city).split('-')[0]}`;
        for (let n = 2; ids.has(id); n++) id = `${base}-${n}`;
        r.collisions.push(`${base} -> ${id}`);
      }
      ids.add(id);
      const [notes, sourceNotes] = splitNotes(it.notes ?? null, it.sourceNotes ?? null, id, r.log);
      const row = {
        id, name: it.name, date: it.date ?? null, time: it.time ?? null, distances: sortD(it.distances ?? []),
        distanceTags: tags(it.distances ?? []), city: it.city, state: it.state, venue: it.venue ?? null,
        organizer: it.organizer ?? null, signupUrl: cleanUrl(it.signupUrl ?? null), sourceUrl: it.sourceUrl,
        confidence: CONF_OVERRIDE[it.name] ?? it.confidence, notes, notesEs: it.notesEs ?? null, sourceNotes,
      };
      for (const [k, v] of Object.entries(it)) if (!(k in row) && k !== 'kind' && k !== 'existingId' && !/^status/.test(k)) row[k] = v;
      races.push(row);
      r[it.kind === 'new' ? 'new' : 'nextEdition']++;
      continue;
    }
    // in-place updates
    if (REMOVE.has(it.existingId)) { r.log.push(`${it.existingId}: removed (see REMOVE)`); continue; }
    const row = byId.get(it.existingId);
    if (!row) { r.rejected.push(`${it.name}: existingId ${it.existingId} not found`); continue; }
    const isCorr = it.kind === 'correction';
    const FIELDS = UPDATE_FIELDS[it.kind];
    if (!FIELDS) { r.rejected.push(`${it.name}: unknown kind ${it.kind}`); continue; }
    for (const f of FIELDS) {
      if (!(f in it)) continue;
      let v = f === 'signupUrl' ? cleanUrl(it[f]) : it[f];
      if (v === null) { if (isCorr && f === 'signupUrl') row[f] = null; continue; } // explicit null only for a correction's signupUrl
      if (Array.isArray(v) && !v.length) continue;
      if (f === 'notes' && KEEP_OLD_NOTES.has(row.id) && row.notes && !v.includes(row.notes)) v = `${v} ${row.notes}`;
      if (f === 'notesEs' && KEEP_OLD_NOTES.has(row.id) && row.notesEs && !v.includes(row.notesEs)) v = `${v} ${row.notesEs}`;
      if (f === 'venue' && isCorr && row.start && row.venue !== v && !SAME_PLACE.has(row.id)) { delete row.start; r.log.push(`${row.id}: dropped start (venue changed)`); }
      row[f] = f === 'distances' ? sortD(v) : v;
    }
    if (NOTES_OVERRIDE[row.id]) Object.assign(row, NOTES_OVERRIDE[row.id]);
    row.distanceTags = tags(row.distances);
    const sn = SOURCE_NOTES_OVERRIDE[row.id] ?? it.sourceNotes;
    if (sn) row.sourceNotes = row.sourceNotes ? `${sn} (Earlier: ${row.sourceNotes})` : sn;
    if (!isCorr && it.city && it.city !== row.city) r.log.push(`${row.id}: kept city ${row.city} (agent said ${it.city})`);
    const [n2, s2] = splitNotes(row.notes, row.sourceNotes, row.id, r.log);
    row.notes = n2; row.sourceNotes = s2;
    const st = STATUS[row.id];
    if (isCorr || st) {
      if (!st) throw new Error(`no status copy for correction ${row.id}`);
      row.status = st.status ?? 'changed';
      row.statusNote = st.statusNote;
      row.statusNoteEs = st.statusNoteEs;
      row.lastVerified = TODAY;
    }
    r[isCorr ? 'correction' : 'dateUndated']++;
  }
}

// canonical key order for appended rows only (existing rows keep their order → minimal diff)
const added = Object.values(report).reduce((a, r) => a + r.new + r.nextEdition, 0);
for (const row of races.slice(races.length - added)) {
  if (!ORDER.every((k, i) => Object.keys(row)[i] === k)) throw new Error(`key order ${row.id}`);
}
for (const n of Object.keys(NOTES_EN)) if (!usedNotesEn.has(n)) throw new Error(`unused NOTES_EN ${n}`);
for (const n of Object.keys(ID_OVERRIDE)) if (!ids.has(ID_OVERRIDE[n])) throw new Error(`unused ID_OVERRIDE ${n}`);
const removed = [];
for (let i = races.length - 1; i >= 0; i--) if (REMOVE.has(races[i].id)) removed.push(races.splice(i, 1)[0].id);
for (const id of REMOVE) if (!removed.includes(id)) throw new Error(`REMOVE id not found ${id}`);
for (const id of Object.keys(NOTES_OVERRIDE)) if (!byId.has(id)) throw new Error(`unused NOTES_OVERRIDE ${id}`);
doc._meta.count = races.length;
doc._meta.description += ` 2027 calendar sweep 2026-10-20: ${states.join(', ')}.`;
writeFileSync(racesPath, JSON.stringify(doc, null, 2) + '\n');

for (const [s, r] of Object.entries(report)) {
  console.log(`${s}: new ${r.new}, next-edition ${r.nextEdition}, date-undated ${r.dateUndated}, correction ${r.correction}, rejected ${r.rejected.length}, collisions ${r.collisions.length}`);
  for (const x of [...r.rejected.map((x) => 'REJECT ' + x), ...r.collisions.map((x) => 'COLLIDE ' + x), ...r.log]) console.log('  ' + x);
}
console.log(`removed: ${removed.join(', ') || 'none'}`);
console.log(`rows ${races.length - added + removed.length} -> ${races.length}`);

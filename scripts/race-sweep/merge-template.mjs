// 2027 calendar sweep merge, batch 3 (adapted from merge-batch2.mjs).
// usage: node merge-batch3.mjs <before.json> <out races.json> <found-dir> <State> [<State> ...]
// Rebuilds <out> from <before> (2-space JSON + trailing newline, the file's canonical form).
import { readFileSync, writeFileSync } from 'node:fs';

const [,, beforePath, racesPath, foundDir, ...states] = process.argv;
const TODAY = '2026-10-20';
const doc = JSON.parse(readFileSync(beforePath, 'utf8'));
const races = doc.races;
const ids = new Set(races.map((r) => r.id));
const byId = new Map(races.map((r) => [r.id, r]));
const ORDER = ['id', 'name', 'date', 'time', 'distances', 'distanceTags', 'city', 'state', 'venue', 'organizer', 'signupUrl', 'sourceUrl', 'confidence', 'notes', 'notesEs', 'sourceNotes'];
const TAG_ORDER = ['3K', '5K', '10K', '15K', 'Half', '30K', 'Full', 'Ultra'];

// Per-row overrides for corrections (status banner copy) — the agent files don't carry these.
const STATUS = {
  'carrera-batman-2026': {
    status: 'canceled',
    statusNote: 'This race was canceled by the organizer. If you registered, contact Asdeporte about your entry.',
    statusNoteEs: 'El organizador canceló esta carrera. Si te inscribiste, contacta a Asdeporte sobre tu inscripción.',
  },
  'bob-esponja-2026': {
    statusNote: 'New date and place: Sunday 22 November 2026 at Parque Fundidora (Grúa Portal), 6:45 a.m.',
    statusNoteEs: 'Nueva fecha y sede: domingo 22 de noviembre de 2026 en Parque Fundidora (Grúa Portal), 6:45 a.m.',
  },
  'shrek-run-guadalajara-2027': {
    statusNote: 'New date: Sunday 24 January 2027 (was 17 January).',
    statusNoteEs: 'Nueva fecha: domingo 24 de enero de 2027 (antes 17 de enero).',
  },
};
// Rows removed outright (main-session ruling). Ultra X has no Mexico edition on the organizer's
// 2026-27 calendar; the old source 404s; the only ITRA listing is 2019 (also Nov 2) — a 2019 date
// carried forward, not a cancelled 2026 race, so a "canceled" banner would be false too.
const REMOVE = new Set(['ultra-x-mexico-2026']);
const KEEP_OLD_NOTES = new Set();
// Venue text refined, same spot: the existing start pin (25.6757,-100.2820) IS the Grúa Portal.
const SAME_PLACE = new Set(['carrera-batman-2026']);
// Notes rewritten by hand on in-place rows: Batman's "Registration open" sentence is now false.
const NOTES_OVERRIDE = {
  'carrera-batman-2026': {
    notes: "The 2026 edition was co-branded 'Superman & Supergirl Run MTY'. Parque Fundidora (Grúa Portal), from $799 MXN.",
    notesEs: "La edición 2026 iba co-marca con 'Superman & Supergirl Run MTY'. Parque Fundidora (Grúa Portal), desde $799 MXN.",
  },
};

const ID_OVERRIDE = {};
// Fields an in-place update may write, per kind. No 'name' this batch: the agents' names carry
// "(cancelada)" / year suffixes that would rename stable rows.
const UPDATE_FIELDS = {
  'date-undated': ['date', 'time', 'distances', 'venue', 'signupUrl', 'sourceUrl', 'confidence', 'notes', 'notesEs'],
  correction: ['date', 'time', 'venue', 'city', 'signupUrl', 'organizer', 'distances', 'sourceUrl', 'confidence', 'notes', 'notesEs'],
};
const SOURCE_NOTES_OVERRIDE = {};
// The NL and Jalisco agents wrote Spanish into the English `notes` field (notes === notesEs).
const NOTES_EN = {
  'Triple Maratón Internacional Monterrey 2026 (5ª Edición)': 'Three days in a row (Friday 30 October to Sunday 1 November): run a marathon or half marathon each day, or complete the triple. Paved, shaded loop closed to traffic. Marathon per day $1,200, half marathon per day $1,000, triple half marathon $2,999.',
  'Bob Esponja Monterrey 2026': 'First SpongeBob race in Monterrey, for the whole family. 10K and 5K with overall prizes, plus a 3K recreational walk. From $969.',
  'Berrendo Bakpak Race Trail Nocturno 2026': 'Night mountain trail race in Chipinque. Starts: 18K at 18:00, 14K at 18:05 and 6K at 18:10. No registration changes after 21 October.',
  'Corre x la Diabetes 2026': 'Benefits the Asociación Mexicana de Diabetes in Nuevo León. Entry $350. Packet pickup on 31 October at the Monterrey Palacio Municipal.',
  '2ª Carrera Unidos 2026': 'Inclusive race: the 1K and 5K have wheelchair, visually impaired and assisted-wheelchair categories. Entry $450. Same day as the Simicarrera and adidas Splits 15K/30K.',
  'lululemon 10K MTY 2026': 'Chip-timed 10K with prizes for the top three overall per category. Entry $1,250 plus fees; closes 19 November or when sold out. Kit pickup at Punto Valle on 20 and 21 November.',
  'Carrera Reto Solidario 2026': 'Benefits Casa INDI. Entry $400. Cash prizes for the top three overall per category.',
  'Carrera Run 4 Mind 2026': 'Benefits Comenzar de Nuevo (eating disorders and mental health). General $450; VIP "Corredor con Valor" $1,000. Same day as the Circuito de las Estaciones Invierno.',
  'Corremos Contigo Conchita 2026 (2ª Edición)': "Family race for Hospital Conchita CHRISTUS's 80th anniversary; you can run with your dog. Entry $250.",
  'Mini Maratón Monterrey 2026': 'Family 4.2 km course on the same day as the Maratón Powerade, to run, jog or walk. Capped at 800. Entry $400; strollers and costumes allowed. Packet pickup at the marathon Expo.',
  'Shrek Run Monterrey 2027': 'Shrek-themed race, 15K and 5K, with a finisher medal. From $899.',
  '21K Las Desgraciadas 2027 (4ª Edición)': '21K at 7:30 and 5K at 7:40. 21K $500, 5K $300. Bib pickup on Saturday 23 January at Soy Runner.',
  '5K-10K Club Deportivo El Fénix 2027': 'First edition. Cash prizes for the top three overall and per category, plus a special purse for Nuevo León-born athletes who break 30 min in the 10K or 15 min in the 5K. From $500.',
  'Shrek Run Guadalajara 2027': 'Shrek-themed race with 5K and 15K. From $899 MXN. Time limit: 2 h 15 min for the 15K and 45 min for the 5K.',
  'V Carrera Top Care Store October Urban Park 2026': '10K and 5K, with canicross (run with your dog) and stroller categories in the 5K.',
  '3ra. Carrera Neufeld 2026': '5K and 10K, plus a 3K kids\' race and a walk. From $450 MXN. Capped at 1,200 runners.',
  '14ª Carrera Contra el Cáncer de Mama GDL 2026': 'Race supporting the fight against breast cancer. 5K with a walk, a 400 m kids\' race and inclusive categories. $440 MXN. Registration until Friday 23 October.',
  '4ª Carrera Move Wellness 5K y 10K': '5K and 10K through Chapalita. $500 MXN in the final stage. Capped at 3,000 runners.',
  'Carrera MTQ Run 2026 (25 Aniversario)': '5K on the Los Colomos trails, 25th-anniversary edition. $319 MXN. Registration until Friday 30 October.',
  'X Maratón por Relevos Guadalajara 2026': 'Team relay over the 42.195 km marathon distance, on the same day as the Maratón Internacional de Guadalajara. $1,600 MXN.',
  'G15K Gatorade Guadalajara 2026': "Fourth edition of Gatorade's 15K. From $1,200 MXN.",
  'Hello Kitty and Friends Fun Run Guadalajara 2026': 'Hello Kitty-themed race: 5K and a 3K walk. $600 MXN for the 5K and $450 MXN for the walk, plus fees. Registration until Friday 20 November or until sold out.',
  '3ª Carrera Día Mundial de la Diabetes 2026': 'Race for World Diabetes Day: competitive 5K and recreational 3K, plus a kids\' race. $400 MXN adults, $350 MXN kids. Capped at 300.',
  'VIVO 47 Family Run 2026': 'Second edition. 5K and 10K, a 3K Pet Run with your dog, and kids\' races. $490 MXN for 5K and 10K, $349 MXN Pet Run. Capped at 1,000 runners.',
  'adidas Split 10K GDL 2026': 'New 10K in the adidas Splits series, presented by Samsung. $780 MXN. Capped at 4,500 runners. Kit pickup on Saturday 28 November at PALCCO, Zapopan.',
  'Carrera MVS Radio Guadalajara 2026': '10K at 6:30 and 5K at 6:45. $550 MXN plus fees. Capped at 2,000. Registration until Friday 27 November, no race-day registration.',
  '13ª Carrera Hecho UDG 2026': "UdeG's university 6K, plus kids' races of 40 to 100 m. $350 MXN general, $90 MXN kids. Capped at 1,000. Kit pickup the Saturday before, none on race day.",
  'Carrera Ruba Race Guadalajara 2026': '5K and a special 4K wheelchair race benefiting Vida Independiente para Personas con Discapacidad. $407 to $429 MXN with fees. Capped at 200, no race-day registration.',
  '17 Aniversario Panteras Tlaquepaque 2026': 'Anniversary race of the Panteras Tlaquepaque club. $385 MXN. Registration until Friday 18 December.',
  'El Reto Final Guadalajara 2026': 'The last race of the year, on 31 December. 5K and 10K. $490 MXN plus fees. Personalized bib and medal if you register before 15 November.',
  "Carrera McDonald's Guadalajara 2026": 'Moved to 31 January 2027 but keeps the 2026 name. 10K at 6:30, 5K and 2.5K recreational at 6:40, wheelchair athletes at 6:25. From $700 MXN.',
};
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
        confidence: it.confidence, notes, notesEs: it.notesEs ?? null, sourceNotes,
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

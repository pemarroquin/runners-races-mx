#!/usr/bin/env node
// Data gate for assets/data/races.json.
//
// Why this exists: the Mon+Fri race-watch routine's output surface used to be
// `status`/`statusNote`/`lastVerified` only, so every fact it discovered landed
// in a prose paragraph while the field the UI actually renders stayed stale.
// The 2026-08-10 audit found six records like that, two of them user-facing
// errors: a race whose start had moved to another municipality still showed the
// old venue and map pin, and a race that had already been run still showed as
// upcoming with a live signup link.
//
// The rule this file enforces: a sweep writes the CORRECTED FIELD first, and
// `statusNote` explains it. The note is the audit trail for a change — never
// the change itself.
//
// Usage:
//   node scripts/verify-sweep.mjs                 # static invariants
//   node scripts/verify-sweep.mjs --base <ref>    # + diff-aware checks vs ref
//
// Exits non-zero on any error. Warnings are printed but never fail the build.
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_PATH = 'assets/data/races.json';

const DISTANCE_TAGS = new Set(['3K', '5K', '10K', '15K', 'Half', '30K', 'Full', 'Ultra', 'TBD']);
const CONFIDENCE = new Set(['high', 'medium', 'low']);
const STATUS = new Set(['ok', 'changed', 'canceled']);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Mirrors isSafeUrl() in src/lib/races.ts. Every URL here reaches a WebView,
// an iframe or Linking.openURL, and the sweep agent harvests signupUrl from
// third-party race-calendar sites — so a hostile scheme has a real path in.
// The app sanitizes at the trust boundary; this stops one being COMMITTED.
const URL_FIELDS = ['sourceUrl', 'signupUrl', 'courseMapUrl'];
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const isSafeUrl = (u) =>
  typeof u === 'string' && !CONTROL_RE.test(u.trim()) && /^https?:\/\/[^\s]+$/i.test(u.trim());

// Fields a sweep is allowed to touch WITHOUT that counting as a real data
// change. If `status: 'changed'` is declared and only these moved, the sweep
// recorded a finding it never applied — the exact defect this gate exists for.
const PROSE_FIELDS = new Set(['status', 'statusNote', 'statusNoteEs', 'sourceNotes', 'lastVerified']);

const errors = [];
const warnings = [];
const err = (id, msg) => errors.push(`${id}: ${msg}`);
const warn = (id, msg) => warnings.push(`${id}: ${msg}`);

// ── load ────────────────────────────────────────────────────────────────────
const raw = readFileSync(resolve(ROOT, DATA_PATH), 'utf8');
let doc;
try {
  doc = JSON.parse(raw);
} catch (e) {
  console.error(`FATAL: ${DATA_PATH} is not valid JSON — ${e.message}`);
  process.exit(1);
}
if (!Array.isArray(doc.races)) {
  console.error(`FATAL: ${DATA_PATH} has no .races array`);
  process.exit(1);
}
const races = doc.races;

// The app re-serialises this file on every sweep; keeping it canonical means a
// sweep diff shows only real edits instead of a whole-file reformat.
if (JSON.stringify(doc, null, 2) + '\n' !== raw) {
  warn('_file', 'not canonically formatted (expected 2-space JSON + trailing newline)');
}

// ── 1. payload-level invariants ─────────────────────────────────────────────
// _meta.count silently drifted to 114 against 195 real records because sweeps
// never touched _meta.
if (doc._meta?.count !== races.length) {
  err('_meta', `count is ${doc._meta?.count} but there are ${races.length} races`);
}

const seen = new Map();
for (const r of races) {
  if (seen.has(r.id)) err(r.id, 'duplicate id');
  else seen.set(r.id, r);
}

// ── 2. per-record schema ────────────────────────────────────────────────────
// Mirrors isValidRace() in src/lib/races.ts. A record failing there is silently
// DROPPED at runtime, so a schema slip reads as "races vanished", not an error.
const str = (v) => typeof v === 'string' && v !== '';
for (const r of races) {
  const id = r.id || '<no id>';
  if (!str(r.id)) err(id, 'id must be a non-empty string');
  if (!str(r.name)) err(id, 'name must be a non-empty string');
  if (typeof r.city !== 'string') err(id, 'city must be a string');
  if (typeof r.state !== 'string') err(id, 'state must be a string');
  if (!str(r.sourceUrl)) err(id, 'sourceUrl is required — no race without a fetched source');
  // A non-http(s) URL here is a live sink, not a typo: these values are handed
  // to a WebView, an iframe and Linking.openURL. `isValidRace` drops a race
  // with an unsafe sourceUrl and nulls an unsafe signupUrl/courseMapUrl at
  // runtime, so committing one means silently losing a listing or a link.
  for (const f of URL_FIELDS) {
    const u = r[f];
    if (u == null) continue;
    if (!isSafeUrl(u)) {
      err(id, `${f} must be an absolute http(s) URL with no control characters, got ${JSON.stringify(String(u).slice(0, 60))}`);
    }
  }
  if (!Array.isArray(r.distances)) err(id, 'distances must be an array');
  if (!Array.isArray(r.distanceTags)) err(id, 'distanceTags must be an array');
  else {
    for (const t of r.distanceTags) {
      if (!DISTANCE_TAGS.has(t)) err(id, `unknown distanceTag ${JSON.stringify(t)}`);
    }
  }
  if (r.date !== null && !(typeof r.date === 'string' && DATE_RE.test(r.date))) {
    err(id, `date must be null or YYYY-MM-DD, got ${JSON.stringify(r.date)}`);
  }
  if (!CONFIDENCE.has(r.confidence)) err(id, `confidence must be high|medium|low, got ${JSON.stringify(r.confidence)}`);
  if (r.status != null && !STATUS.has(r.status)) err(id, `status must be ok|changed|canceled, got ${JSON.stringify(r.status)}`);
  if (r.lastVerified != null && !DATE_RE.test(r.lastVerified)) {
    err(id, `lastVerified must be YYYY-MM-DD, got ${JSON.stringify(r.lastVerified)}`);
  }
}

// ── 3. verification-record coherence ────────────────────────────────────────
const todayISO = new Date().toISOString().slice(0, 10);

for (const r of races) {
  const id = r.id;
  // A verdict with no date can't be aged out or trusted.
  if (r.status != null && !r.lastVerified) err(id, `status ${JSON.stringify(r.status)} set without lastVerified`);
  // The banner in race/[id].tsx only renders for changed|canceled, so a note
  // attached to anything else is written but never seen by a user.
  if (r.statusNote && r.status == null) err(id, 'statusNote written with no status — it will never render');
  // Never let someone pay for a canceled race. race/[id].tsx gates the CTA on
  // status === 'canceled' already; this keeps the DATA honest too.
  if (r.status === 'canceled' && r.signupUrl) err(id, 'canceled race still carries a signupUrl');
  // `changed` conflates "the date moved, still buy it" with "postponed
  // indefinitely". The second kind has no usable date — and the checkout gate
  // only looks at `canceled`, so it stayed purchasable. Null the signupUrl and
  // the CTA disables itself (race/[id].tsx gates on !race.signupUrl too).
  if (r.status === 'changed' && r.signupUrl && (r.date === null || r.date < todayISO)) {
    err(id, `status "changed" with ${r.date === null ? 'no date' : `a past date (${r.date})`} but still carries a signupUrl — a runner can pay for a race that is not happening`);
  }
  if (r.statusNoteEs && !r.statusNote) warn(id, 'statusNoteEs with no statusNote');

  // Only changed|canceled render the banner, and the app's default locale is
  // Spanish — an untranslated banner is an English wall of text for most users.
  if ((r.status === 'changed' || r.status === 'canceled') && r.statusNote && !r.statusNoteEs) {
    err(id, 'banner-rendering statusNote has no statusNoteEs — Spanish is the default locale');
  }
  // The banner is user-facing: research trail belongs in sourceNotes. Length is
  // a blunt proxy, but every note that blew past this was an audit paragraph.
  if (r.statusNote && r.statusNote.length > 420) {
    warn(id, `statusNote is ${r.statusNote.length} chars — move the research trail to sourceNotes`);
  }
}

// ── 4. prose-vs-field cross-check ───────────────────────────────────────────
// The Ensenada class: the sweep PROVED the race had already been run, wrote it
// in the note, and left `date` in the future — so the app kept advertising it.
const HELD = /\b(already (ran|held|took place)|race (is )?over|ya se (corrió|celebró|llevó a cabo)|ya (tuvo lugar|se realizó))\b/i;
const POSTPONED = /\b(postponed|pospuest[oa]|posponer|aplazad[oa])\b/i;
const CANCELED = /\b(cancel(l?ed|ada|ado)|suspendid[oa])\b/i;
const VENUE_MOVED = /\b(venue chang|start\/finish moved|moved to|cambio de sede|nueva sede|not Parque|no Parque)\b/i;

for (const r of races) {
  const note = r.statusNote || '';
  if (!note) continue;
  const id = r.id;
  const future = typeof r.date === 'string' && r.date > todayISO;

  if (HELD.test(note) && future) {
    err(id, `statusNote says the race already happened, but date is ${r.date} (future) — correct the date field, don't only narrate it`);
  }
  if (POSTPONED.test(note) && future && r.status !== 'changed' && r.status !== 'canceled') {
    err(id, `statusNote reports a postponement but status is ${JSON.stringify(r.status)} — no banner will render`);
  }
  if (CANCELED.test(note) && r.status !== 'canceled' && !/no cancel|sin cancel|not a cancellation|no signals/i.test(note)) {
    warn(id, 'statusNote mentions a cancellation but status is not "canceled" — confirm this is a negative finding');
  }
  if (VENUE_MOVED.test(note) && !r.venue) {
    err(id, 'statusNote describes a venue change but venue is null — write the corrected venue into the field');
  }
}

// ── 5. diff-aware: "declared changed but only prose moved" ──────────────────
// Runs when a base ref is available (in CI: the PR base). This is the direct
// test of the rule — if a sweep says `status: 'changed'`, something a user can
// see must actually differ.
const baseIdx = process.argv.indexOf('--base');
if (baseIdx !== -1 && process.argv[baseIdx + 1]) {
  const base = process.argv[baseIdx + 1];
  let prev = null;
  try {
    const out = execFileSync('git', ['show', `${base}:${DATA_PATH}`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    prev = new Map(JSON.parse(out).races.map((r) => [r.id, r]));
  } catch {
    warn('_diff', `could not read ${DATA_PATH} at ${base} — skipping diff-aware checks`);
  }
  if (prev) {
    for (const r of races) {
      const before = prev.get(r.id);
      if (!before) continue; // new race — nothing to compare
      const bumped = r.lastVerified && r.lastVerified !== before.lastVerified;
      if (!bumped || r.status !== 'changed') continue;
      const moved = [...new Set([...Object.keys(r), ...Object.keys(before)])].filter(
        (k) => !PROSE_FIELDS.has(k) && JSON.stringify(r[k]) !== JSON.stringify(before[k]),
      );
      if (moved.length === 0) {
        err(r.id, 'status is "changed" and lastVerified advanced, but no user-visible field differs — the finding was narrated, not applied');
      }
    }
  }
}

// ── forward coverage ────────────────────────────────────────────────────────
// The catalog decays on its own. Every race has a date, that date passes, and
// the feed hides it — so a dataset nobody extends silently empties out while
// every per-record check here still passes. As of 2026-08-12 the calendar ran
// Aug 39 / Sep 30 / Oct 25 / Nov 15 / Dec 12 and then fell off a cliff: 6 in
// January, ZERO in February (peak half-marathon season in Mexico), 2 in March.
//
// Nothing in this gate could see that, because it is not a defect in any
// record — it is the absence of records. These two checks are the alarm.
//
// They are warnings, not errors, on purpose: a sweep that fixes a venue must
// not be blocked by a data-gathering shortfall it has nothing to do with.
// The point is that the shortfall becomes visible in CI output every run,
// instead of being noticed when a user opens an empty app.
const MIN_UPCOMING_PER_REGION = 5;
// Six months. Deliberately longer than it needs to be to describe "soon":
// race registration opens months ahead, and a research pass takes real time,
// so the alarm is only useful if it fires while there is still room to act.
// At 120 days this check stayed silent through an entirely empty February.
const FORWARD_HORIZON_DAYS = 180;

const REGION_STATES = {
  Monterrey: ['Nuevo León'],
  'Ciudad de México': ['Ciudad de México', 'Estado de México'],
  Guadalajara: ['Jalisco'],
  Querétaro: ['Querétaro'],
  Puebla: ['Puebla'],
  Mérida: ['Yucatán'],
  Tijuana: ['Baja California'],
  León: ['Guanajuato'],
  Cancún: ['Quintana Roo'],
  'San Luis Potosí': ['San Luis Potosí'],
  Saltillo: ['Coahuila'],
  Chihuahua: ['Chihuahua'],
};

const horizon = new Date(Date.now() + FORWARD_HORIZON_DAYS * 86_400_000)
  .toISOString()
  .slice(0, 10);

for (const [region, states] of Object.entries(REGION_STATES)) {
  // Undated races count as upcoming — they are real listings awaiting a date.
  const upcoming = races.filter(
    (r) => states.includes(r.state) && (!r.date || r.date >= todayISO),
  ).length;
  if (upcoming < MIN_UPCOMING_PER_REGION) {
    warn(
      '_coverage',
      `${region} has only ${upcoming} upcoming ${upcoming === 1 ? 'race' : 'races'} (min ${MIN_UPCOMING_PER_REGION}) — that region's feed is nearly empty; needs a research pass`,
    );
  }
}

// Month-by-month holes inside the horizon, which is how "February is empty"
// shows up before anyone opens the app in February.
for (let i = 0; i <= FORWARD_HORIZON_DAYS / 30; i += 1) {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() + i);
  const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  if (key > horizon.slice(0, 7)) break;
  const count = races.filter((r) => r.date && r.date.slice(0, 7) === key).length;
  if (count === 0) {
    warn('_coverage', `no races anywhere in ${key} — a whole month is empty inside the ${FORWARD_HORIZON_DAYS}-day horizon`);
  }
}

// ── report ──────────────────────────────────────────────────────────────────
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
for (const w of warnings) console.warn(`  warn  ${w}`);
for (const e of errors) console.error(`  ERROR ${e}`);

if (errors.length) {
  console.error(`\nverify-sweep: FAILED — ${plural(errors.length, 'error')}, ${plural(warnings.length, 'warning')} across ${races.length} races.`);
  process.exit(1);
}
console.log(`verify-sweep: OK — ${races.length} races, ${plural(warnings.length, 'warning')}.`);

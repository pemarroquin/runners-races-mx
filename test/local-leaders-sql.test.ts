// Local Leaders' SQL, run for real. 20261023120000 moves the board's scoring
// into Postgres so tile_visits can close; the TypeScript it replaced
// (mayorship.ts mayorByCell, local-leaders.ts daysPresent / runnerTotals /
// sessionGroundVisits) stays as the reference, and these tests hold the two
// equal on random data. Plus the access rules a migration can get wrong and
// still apply cleanly: plpgsql plans lazily, so only running it proves it.
//
// PGlite is Postgres compiled to WASM: real planner, real RLS, real
// plpgsql. What it lacks is Supabase itself, so the few pieces the
// migrations lean on (auth.uid(), the anon/authenticated roles, default
// grants, the runs/tile_visits tables as production has them) are stubbed
// below with the same definitions Supabase uses.
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { PGlite } from '@electric-sql/pglite';
import { gridDisk, gridRingUnsafe, latLngToCell } from 'h3-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { districtCellPattern, districtOfCell } from '../src/lib/district';
import { groundOfRun } from '../src/lib/enclosure';
import { daysPresent, runnerTotals, sessionGroundVisits } from '../src/lib/local-leaders';
import { mayorByCell, type RunStats, type TileVisitRow } from '../src/lib/mayorship';

const MIGRATIONS = path.resolve(__dirname, '../supabase/migrations');
const sql = (file: string) => readFileSync(path.join(MIGRATIONS, file), 'utf8');

const SUPABASE_STUB = `
  create schema auth;
  create table auth.users (id uuid primary key);
  create function auth.uid() returns uuid language sql stable as
    $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  create role anon nologin;
  create role authenticated nologin;
  grant usage on schema public, auth to anon, authenticated;
  grant execute on function auth.uid() to anon, authenticated;
  alter default privileges in schema public grant select, insert, update, delete on tables to anon, authenticated;

  create table public.runs (
    id uuid primary key,
    user_id uuid not null references auth.users(id),
    distance_m numeric not null,
    duration_s integer not null,
    laps integer not null default 0,
    flagged boolean not null default false
  );
  alter table public.runs enable row level security;
  create policy "runs: select own" on public.runs for select using (auth.uid() = user_id);

  create table public.tile_visits (
    h3 text not null,
    user_id uuid not null references auth.users(id),
    run_id uuid not null references public.runs(id),
    visited_at timestamptz not null default now(),
    primary key (h3, run_id)
  );
  alter table public.tile_visits enable row level security;
  create policy "tile_visits: read all" on public.tile_visits for select using (true);
  create policy "tile_visits: insert own" on public.tile_visits for insert with check (auth.uid() = user_id);
`;

/** Deterministic PRNG, so a failure reproduces. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const USERS = [
  '00000000-0000-4000-8000-00000000000a',
  '00000000-0000-4000-8000-00000000000b',
  '00000000-0000-4000-8000-00000000000c',
  '00000000-0000-4000-8000-00000000000d',
];
const runId = (i: number) => `10000000-0000-4000-8000-${String(i).padStart(12, '0')}`;

// A small patch of Monterrey, so runners keep landing on the same cells.
const CENTRE = latLngToCell(25.6866, -100.3161, 12);
const POOL = gridDisk(CENTRE, 14);

interface Session {
  id: string;
  userId: string;
  at: Date;
  visited: string[];
  enclosed: string[];
  distanceM: number;
  durationS: number;
  laps: number;
  flagged: boolean;
}

/** Random sessions: loops (which enclose) and lines (which don't), spread
 *  over 40 days so the window cuts some off. Days, laps and distance are
 *  drawn from small ranges so every tiebreaker actually gets exercised. */
function makeSessions(seed: number, now: number): Session[] {
  const r = rng(seed);
  const out: Session[] = [];
  for (let i = 0; i < 40; i++) {
    const centre = POOL[Math.floor(r() * POOL.length)];
    const visited =
      r() < 0.6
        ? gridRingUnsafe(centre, 1 + Math.floor(r() * 3))
        : gridDisk(centre, 1).slice(0, 2 + Math.floor(r() * 5));
    const ground = groundOfRun(visited, 12);
    const visitedSet = new Set(visited);
    // Whole days, plus an hour offset, kept clear of the 30-day edge so the
    // JS clock and Postgres's now() can't disagree about the window.
    let day = Math.floor(r() * 40);
    if (day === 30) day = 29;
    const at = new Date(now - day * 86_400_000 - (1 + Math.floor(r() * 20)) * 3_600_000);
    out.push({
      id: runId(i + 1),
      userId: USERS[Math.floor(r() * USERS.length)],
      at,
      visited,
      enclosed: ground.filter((c) => !visitedSet.has(c)),
      distanceM: 1000 * (1 + Math.floor(r() * 3)),
      durationS: 600 * (1 + Math.floor(r() * 4)),
      laps: Math.floor(r() * 2),
      flagged: r() < 0.1,
    });
  }
  return out;
}

async function as(db: PGlite, userId: string | null, fn: () => Promise<void>) {
  await db.exec(`set role ${userId ? 'authenticated' : 'anon'}`);
  await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [userId ?? '']);
  try {
    await fn();
  } finally {
    await db.exec('reset role');
  }
}

async function freshDb(sessions: Session[], { narrowed }: { narrowed: boolean }) {
  const db = new PGlite();
  await db.exec(SUPABASE_STUB);
  await db.exec(sql('20261023120000_local_leaders_server_side.sql'));
  if (narrowed) await db.exec(sql('20261023130000_tile_visits_select_own.sql'));
  for (const u of USERS) await db.query('insert into auth.users values ($1)', [u]);
  for (const s of sessions) {
    await db.query(
      'insert into runs (id, user_id, distance_m, duration_s, laps, flagged) values ($1, $2, $3, $4, $5, $6)',
      [s.id, s.userId, s.distanceM, s.durationS, s.laps, s.flagged],
    );
    // As the runner, the way claim_run_tiles writes them, then the device's
    // own enclosure record. visited_at is set explicitly to the session's
    // time instead of now(), to spread sessions over the window.
    await as(db, s.userId, async () => {
      await db.query(
        'insert into tile_visits (h3, user_id, run_id, visited_at) select unnest($1::text[]), $2, $3, $4',
        [s.visited, s.userId, s.id, s.at.toISOString()],
      );
      await db.query('select record_run_ground($1, $2)', [s.id, s.enclosed]);
    });
  }
  return db;
}

/** What the old client built from raw visits: each session's ground,
 *  stamped with its day, plus run stats with flagged runs left out. */
function reference(sessions: Session[]) {
  const visits: TileVisitRow[] = sessions.flatMap((s) =>
    s.visited.map((h3) => ({ h3, userId: s.userId, displayName: null, visitedAt: s.at.toISOString(), runId: s.id })),
  );
  const stats = new Map<string, RunStats>();
  for (const s of sessions) {
    if (!s.flagged) stats.set(s.id, { distanceM: s.distanceM, durationS: s.durationS, laps: s.laps });
  }
  return { ground: sessionGroundVisits(visits), stats };
}

const prefixesOf = (cells: string[]) => [
  ...new Set(cells.map((c) => districtCellPattern(districtOfCell(c)!))),
];

describe('Local Leaders SQL matches the TypeScript it replaced', () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    it(`mayors, days and totals agree (seed ${seed})`, async () => {
      const now = Date.now();
      const sessions = makeSessions(seed, now);
      const db = await freshDb(sessions, { narrowed: true });
      const { ground, stats } = reference(sessions);

      const expected = mayorByCell(ground, now, stats);
      let cellsJson: [string, string, number][] = [];
      await as(db, USERS[0], async () => {
        const res = await db.query<{ c: [string, string, number][] }>('select local_leaders_cells($1) c', [
          prefixesOf(POOL),
        ]);
        cellsJson = res.rows[0].c;
      });
      const actual = new Map(cellsJson.map(([h3, userId, days]) => [h3, { userId, days }]));
      expect(actual).toEqual(expected);

      // An "arena": a random half of the ground cells, as a subdivision cut
      // would leave. Days and totals are per mayor over those cells.
      const r = rng(seed * 97);
      const arena = [...expected.keys()].filter(() => r() < 0.5);
      const arenaSet = new Set(arena);
      const scope = { contains: (h3: string) => arenaSet.has(h3), totalCells: arena.length };
      const mayorsInArena = new Set(arena.map((h3) => expected.get(h3)!.userId));
      const days = daysPresent(ground, scope, now);
      const totals = runnerTotals(ground, scope, stats, now);

      let runners: { user_id: string; days: number; runs: number; distance_m: number; duration_s: number; laps: number }[] = [];
      await as(db, USERS[1], async () => {
        runners = (await db.query<{ r: typeof runners }>('select local_leaders_runners($1) r', [arena])).rows[0].r;
      });
      expect(new Set(runners.map((x) => x.user_id))).toEqual(mayorsInArena);
      for (const row of runners) {
        expect(row.days).toBe(days.get(row.user_id));
        const t = totals.get(row.user_id);
        if (row.runs === 0) expect(t).toBeUndefined();
        else
          expect({ distanceM: Number(row.distance_m), durationS: row.duration_s, laps: row.laps, runs: row.runs }).toEqual(t);
      }

      // my_mayor_cells: every cell each runner is mayor of, anywhere.
      for (const u of USERS) {
        let mine: string[] = [];
        await as(db, u, async () => {
          mine = (await db.query<{ m: string[] }>('select my_mayor_cells() m')).rows[0].m;
        });
        const want = [...expected].filter(([, m]) => m.userId === u).map(([h3]) => h3).sort();
        expect(mine).toEqual(want);
      }
      await db.close();
    });
  }
});

describe('access', () => {
  const now = Date.now();
  const sessions = makeSessions(42, now);
  let db: PGlite;
  beforeAll(async () => {
    db = await freshDb(sessions, { narrowed: true });
  });
  afterAll(async () => {
    await db.close();
  });

  it('tile_visits, run_sessions and run_ground show a runner only their own rows', async () => {
    for (const u of USERS) {
      await as(db, u, async () => {
        for (const table of ['tile_visits', 'run_sessions']) {
          const others = await db.query(`select 1 from ${table} where user_id <> $1`, [u]);
          expect(others.rows).toEqual([]);
        }
        const ground = await db.query<{ n: number }>(
          'select count(*)::int n from run_ground g join runs r on r.id = g.run_id where r.user_id <> $1',
          [u],
        );
        expect(ground.rows[0].n).toBe(0);
      });
    }
    await as(db, null, async () => {
      expect((await db.query('select 1 from tile_visits')).rows).toEqual([]);
    });
  });

  it('the anon role cannot call the scoring functions, and nobody can call the internal one', async () => {
    await as(db, null, async () => {
      await expect(db.query("select local_leaders_cells(array['8c48a2'])")).rejects.toThrow(/permission denied/);
      await expect(db.query('select my_mayor_cells()')).rejects.toThrow(/permission denied/);
    });
    await as(db, USERS[0], async () => {
      await expect(db.query('select * from local_leader_mayors(null, null)')).rejects.toThrow(/permission denied/);
      await expect(db.query('select mirror_run_visits(null)')).rejects.toThrow(/permission denied/);
    });
  });

  it('nobody writes ground directly', async () => {
    await as(db, sessions[0].userId, async () => {
      await expect(
        db.query('insert into run_ground (run_id, h3, enclosed) values ($1, $2, true)', [sessions[0].id, POOL[0]]),
      ).rejects.toThrow(/row-level security/);
      await db.query('update run_sessions set enclosure_recorded = false where run_id = $1', [sessions[0].id]);
      const row = await db.query<{ e: boolean }>('select enclosure_recorded e from run_sessions where run_id = $1', [
        sessions[0].id,
      ]);
      // No update policy: the update silently matched nothing.
      expect(row.rows[0].e).toBe(true);
    });
  });

  it('records enclosure once, for the owner only, bounded and local', async () => {
    const owner = USERS[0];
    const other = USERS[1];
    const id = runId(900);
    await db.query('insert into runs (id, user_id, distance_m, duration_s) values ($1, $2, 1000, 600)', [id, owner]);
    const visited = gridRingUnsafe(CENTRE, 2);
    await as(db, owner, async () => {
      await db.query('insert into tile_visits (h3, user_id, run_id) select unnest($1::text[]), $2, $3', [
        visited,
        owner,
        id,
      ]);
    });

    await as(db, other, async () => {
      await expect(db.query('select record_run_ground($1, $2)', [id, []])).rejects.toThrow(/does not belong/);
    });

    await as(db, owner, async () => {
      await expect(db.query('select record_run_ground($1, $2)', [id, ['not-a-cell']])).rejects.toThrow(
        /GROUND_IMPLAUSIBLE/,
      );
      // Far beyond what a 1 km loop can surround.
      await expect(db.query('select record_run_ground($1, $2)', [id, gridDisk(CENTRE, 40)])).rejects.toThrow(
        /GROUND_IMPLAUSIBLE/,
      );

      const far = latLngToCell(19.4326, -99.1332, 12); // CDMX
      const inside = [CENTRE];
      const n = await db.query<{ n: number }>('select record_run_ground($1, $2) n', [id, [...inside, far]]);
      // The far cell shares no res-6 ancestor with the loop: dropped.
      expect(n.rows[0].n).toBe(1);
      const again = await db.query<{ n: number }>('select record_run_ground($1, $2) n', [id, gridDisk(CENTRE, 1)]);
      expect(again.rows[0].n).toBe(0);

      const enclosed = await db.query<{ h3: string }>('select h3 from run_ground where run_id = $1 and enclosed', [id]);
      expect(enclosed.rows.map((x) => x.h3)).toEqual(inside);
    });
  });

  it('a claim mirrors into ground without the device doing anything', async () => {
    const owner = USERS[2];
    const id = runId(901);
    await db.query('insert into runs (id, user_id, distance_m, duration_s) values ($1, $2, 500, 300)', [id, owner]);
    await as(db, owner, async () => {
      await db.query('insert into tile_visits (h3, user_id, run_id) values ($1, $2, $3)', [POOL[3], owner, id]);
      const s = await db.query<{ e: boolean }>('select enclosure_recorded e from run_sessions where run_id = $1', [id]);
      expect(s.rows).toEqual([{ e: false }]);
      const g = await db.query<{ h3: string }>('select h3 from run_ground where run_id = $1', [id]);
      expect(g.rows).toEqual([{ h3: POOL[3] }]);
    });
  });
});

describe('the backfill in 20261023120000', () => {
  it('mirrors visits that existed before the migration', async () => {
    const db = new PGlite();
    await db.exec(SUPABASE_STUB);
    await db.query('insert into auth.users values ($1)', [USERS[0]]);
    await db.query('insert into runs (id, user_id, distance_m, duration_s) values ($1, $2, 1000, 600)', [
      runId(1),
      USERS[0],
    ]);
    await db.query(
      "insert into tile_visits (h3, user_id, run_id, visited_at) values ($1, $2, $3, now() - interval '2 days'), ($4, $2, $3, now() - interval '1 day')",
      [POOL[0], USERS[0], runId(1), POOL[1]],
    );
    await db.exec(sql('20261023120000_local_leaders_server_side.sql'));
    const s = await db.query<{ n: number; days_ago: number }>(
      "select count(*)::int n, min(extract(day from now() - session_at))::int days_ago from run_sessions",
    );
    // One session, dated by its EARLIEST visit.
    expect(s.rows[0]).toEqual({ n: 1, days_ago: 2 });
    const g = await db.query<{ n: number }>('select count(*)::int n from run_ground where not enclosed');
    expect(g.rows[0].n).toBe(2);
    await db.close();
  });
});

// The leaderboard. ONE screen, TWO tabs.
//
// This file used to open with "ONE screen, ONE arena, no mode toggles" and a
// long argument against a tab/toggle UI here, after an EARLIER toggle
// (`Territory`/`Regulars` × `Monterrey`/`Global`) confused Pedro badly enough
// that he asked for it gone entirely ("What is Regulars? Why does regulars
// have Monterrey and Global territory?"). That argument doesn't apply to
// THIS tab split, and it's worth saying why, since a future reader will find
// the two side by side in git blame:
//
//   The old toggle crossed two unrelated, easily-confused axes on unlabelled
//   pills. These tabs are one axis — WHICH BOARD — and each is
//   self-explanatory by name: Leaderboard (Board 1, live conquest) and
//   Local Leaders (Board 2, mayorship). Nothing here recreates "Regulars."
//
//   WHERE still collapses to the district you're standing in (district.ts).
//
// 2026-09-30: My Achievements moved to Profile › Places I've been, so the screen is only the two boards now — Leaderboard (Board 1,
// conquest) and Local Leaders (Board 2, mayorship). Local Leaders is a
// full-bleed map with the ranking in a floating card; both tabs share one
// floating glass capsule so switching never moves the control.
//
// The share bar, not the list, is still the thing you look at first inside
// Municipio — "having leaderboard with only cards is boring and i do not
// like it at all". See share-bar.tsx for why a bar survives having one
// player and a card list does not.
import { useIsFocused } from 'expo-router';
import type { AndroidSymbol, SFSymbol } from 'expo-symbols';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useColorScheme,
  View,
} from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { DistrictMap, type DistrictHolding } from '@/components/district-map';
import { MapErrorBoundary } from '@/components/map-error-boundary';
import { ProfilePill } from '@/components/profile-pill';
import { PULL_PILL_H, PullPill } from '@/components/pull-pill';
import { GlassSurface } from '@/components/ui/glass-surface';
import { Icon } from '@/components/ui/icon';
import { GlassRadii } from '@/constants/glass';
import { FENCE_COLOR_SETS } from '@/constants/map';
import { BottomTabInset, Colors, Spacing, type ThemeColor } from '@/constants/theme';
import { onIdentityChanged } from '@/lib/auth-events';
import {
  fetchDistrictParkCells,
  fetchDistrictVisits,
  fetchRunStats,
  fetchRunVisits,
  type ParkCell,
} from '@/lib/boards';
import { districtLabel } from '@/lib/district';
import { nearestRegion } from '@/lib/regions';
import { useI18n } from '@/lib/i18n';
import { districtConquest, type TileOwnerRow } from '@/lib/leaderboard';
import { daysPresent, holdingsOf, runnerTotals, sessionGroundVisits } from '@/lib/local-leaders';
import {
  MAYORSHIP_WINDOW_DAYS,
  mayorByCell,
  namesOf,
  rankMayorMap,
  scopeVisits,
  type RunStats,
  type TileVisitRow,
} from '@/lib/mayorship';
import { formatDistance, formatPace } from '@/lib/tracking';
import {
  BUNDLED_SUBDIVISIONS,
  arenasFor,
  fetchRemoteSubdivisions,
  type Arena,
} from '@/lib/subdivisions';
import { useCurrentLocation } from '@/lib/use-current-location';
import { useLiveTerritory } from '@/lib/use-live-territory';
import { fetchTileLeaderboard } from '@/lib/territory-sync';

/** Everything the screen needs, resolved together. `null` is "not loaded
 *  yet"; a failed visits read keeps the rest — Local Leaders going empty
 *  must not take the conquest board with it. */
interface BoardData {
  /** Which arena this was loaded for. A load for the previous arena is
   *  never shown under the next one's name. */
  arenaKey: string;
  tiles: TileOwnerRow[] | null;
  meUserId: string | null;
  /** For districtLabel's caption only — a failed or empty read just means
   *  the arena falls back to the metro region name, never a failed board. */
  parkCells: ParkCell[];
  visits: Parameters<typeof mayorByCell>[0];
  /** Distance/duration/laps per run, for Local Leaders' tiebreakers and row
   *  totals. null when the run_stats read failed (e.g. before its migration
   *  is applied): rows then show days only and ties go to the incumbent —
   *  never everyone at zero. */
  runStats: Map<string, RunStats> | null;
  /** Local Leaders' raw material: each recent session's GROUND (tiles it
   *  crossed plus the inside of loops it closed), one row per tile, stamped
   *  with the session's day — see sessionGroundVisits. null when the
   *  sessions' paths couldn't be read: the card says so rather than ranking
   *  on crossed streets alone, which reads as broken enclosure. */
  leaderVisits: TileVisitRow[] | null;
  failed: boolean;
}

export default function LeaderboardScreen() {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const c = Colors[scheme];
  const { t } = useI18n();
  const isFocused = useIsFocused();
  const insets = useSafeAreaInsets();

  // Two sub-tabs (2026-09-30): Leaderboard (Board 1, conquest) and Local
  // Leaders (Board 2, mayorship). Both need a place, so location is asked
  // for as soon as the screen opens.
  const [activeBoard, setActiveBoard] = useState<Board>('municipio');
  // The arena follows the runner. A real fix or nothing — never a region
  // fallback, for the same reason the Track map refuses to place its pin on a
  // city centre: this decides which ground a runner is being ranked on, and
  // a guess would rank them somewhere they have never been.
  const { coords, status: locationStatus, request: requestLocation } = useCurrentLocation({
    autoRequest: true,
  });

  const [data, setData] = useState<BoardData | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  // The runner picked on the Local Leaders card; their ground is highlighted.
  const [focusUserId, setFocusUserId] = useState<string | null>(null);


  // The city's subdivisions (subdivisions.ts): bundled, then the GitHub copy
  // once per mount, like races. A failed refresh keeps the bundled list.
  const [subdivisions, setSubdivisions] = useState(BUNDLED_SUBDIVISIONS);
  useEffect(() => {
    let stale = false;
    fetchRemoteSubdivisions().then((remote) => {
      // Only a real change: a new object rebuilds every arena and refetches
      // the board, and the remote copy almost always matches the bundle.
      if (!stale && remote && JSON.stringify(remote) !== JSON.stringify(BUNDLED_SUBDIVISIONS)) {
        setSubdivisions(remote);
      }
    });
    return () => {
      stale = true;
    };
  }, []);

  // The switcher's list: where you stand first, then the rest of the city
  // nearest first (arenasFor). One fix, not a watch, so this is built once
  // per location rather than per GPS tick.
  const arenas = useMemo<Arena[] | null>(() => {
    if (!coords) return null;
    const region = nearestRegion(coords.lat, coords.lng);
    return arenasFor(region ? (subdivisions[region.id] ?? []) : [], coords);
  }, [coords, subdivisions]);
  const [arenaKey, setArenaKey] = useState<string | null>(null);
  const arena = useMemo(
    () => arenas?.find((a) => a.key === arenaKey) ?? arenas?.[0] ?? null,
    [arenas, arenaKey],
  );
  const stepArena = (delta: number) => {
    if (!arenas || !arena || arenas.length < 2) return;
    const i = arenas.indexOf(arena);
    setArenaKey(arenas[(i + delta + arenas.length) % arenas.length].key);
    setFocusUserId(null);
  };

  const [identitySignal, setIdentitySignal] = useState(0);
  useEffect(() => onIdentityChanged(() => setIdentitySignal((v) => v + 1)), []);

  const load = useCallback(async (forArena: Arena): Promise<BoardData> => {
    // Three independent reads, no ordering between them.
    //
    // The park-path read is back, `park_path_cells` having been loaded into
    // production 2026-09-09 — but ONLY for districtLabel's caption. The
    // denominator it used to feed stays gone (see ConquestEntry.share); a
    // failed or empty read here must never fail the board, just fall back
    // the caption to the metro region name.
    const [board, parks, visits] = await Promise.all([
      // Scoped to this district server-side, like the two reads beside it —
      // see fetchTileLeaderboard's own `district` param for what the
      // unscoped version cost.
      // A subdivision reads every district covering it; the exact outline
      // is cut on device by forArena.contains.
      fetchTileLeaderboard(forArena.districts),
      // Only a district needs a derived caption; a subdivision has a name.
      forArena.kind === 'district'
        ? fetchDistrictParkCells(forArena.key)
        : Promise.resolve({ ok: true as const, parkCells: [] as ParkCell[] }),
      fetchDistrictVisits(forArena.districts),
    ]);
    // After the visits, because it needs their run ids: the sessions inside
    // the window mayorship reads that came near this arena (the padding ring
    // included, so a loop around ground at the edge still counts). Visits
    // are all-time, so passing every id would grow with history for nothing.
    // Then, together: their numbers (tiebreakers) and their WHOLE paths, so
    // each session's enclosure can be rebuilt even where it crosses the edge.
    const cutoff = Date.now() - MAYORSHIP_WINDOW_DAYS * 24 * 60 * 60 * 1000;
    const runIds = visits.ok
      ? visits.visits.flatMap((v) => (v.runId && Date.parse(v.visitedAt) >= cutoff ? [v.runId] : []))
      : [];
    const [runStats, runVisits] = visits.ok
      ? await Promise.all([fetchRunStats(runIds), fetchRunVisits(runIds, namesOf(visits.visits))])
      : [null, null];
    return {
      arenaKey: forArena.key,
      runStats: runStats?.ok ? runStats.stats : null,
      leaderVisits: runVisits?.ok ? sessionGroundVisits(runVisits.visits) : null,
      tiles: board.ok ? board.tiles : null,
      meUserId: board.ok ? board.meUserId : null,
      parkCells: parks.ok ? parks.parkCells : [],
      visits: visits.ok ? visits.visits : [],
      // Only the ownership read failing is a failed BOARD; missing park
      // cells or visits just means a decorative fallback / an empty Local
      // Leaders section.
      failed: !board.ok,
    };
  }, []);

  // Bumped by every load that starts; a result is applied only if its ticket
  // is still the newest. Without it two overlapping refreshes — or one that
  // outlives a district change — apply out of order, and a pull-to-refresh
  // can clobber a fresher result from the focus effect.
  //
  // Declared and mutated BEFORE the focus effect that also reads it: the
  // React Compiler rejects modifying a value an effect above it depends on
  // ("This value cannot be modified"), which is the same class of rule as
  // the updater-purity trap this codebase already documents.
  const loadTicketRef = useRef(0);

  const onRefresh = useCallback(async () => {
    if (arena === null) return;
    const ticket = ++loadTicketRef.current;
    setRefreshing(true);
    const next = await load(arena);
    if (loadTicketRef.current === ticket) setData(next);
    setRefreshing(false);
  }, [arena, load]);

  // Refetches on every focus, not just first mount: expo-router keeps tab
  // screens mounted, so a `[]`-deps effect would fetch once early in the
  // session and never again. Same reasoning — and the same identity signal —
  // as the screen this replaced.
  useEffect(() => {
    if (!isFocused || arena === null) return;
    const ticket = ++loadTicketRef.current;
    const id = setTimeout(() => {
      load(arena).then((next) => {
        // Same ticket as onRefresh, not a local `stale` flag: the two paths
        // race each other, so one shared notion of "newest" is the only thing
        // that orders them.
        if (loadTicketRef.current === ticket) setData(next);
      });
    }, 0);
    return () => clearTimeout(id);
  }, [isFocused, arena, identitySignal, load]);

  // Live: someone's claim just landed in this arena (live-territory.ts), so
  // refetch quietly — no spinner, same ticket as every other load so it can
  // never clobber a fresher result. Subscribed only while this tab is on top.
  const reloadSilently = useCallback(() => {
    if (arena === null) return;
    const ticket = ++loadTicketRef.current;
    load(arena).then((next) => {
      if (loadTicketRef.current === ticket) setData(next);
    });
  }, [arena, load]);
  useLiveTerritory({ active: isFocused, districts: arena?.districts ?? null, onChange: reloadSilently });

  // Only a load for the arena on screen counts. Stepping to the next
  // municipio shows loading until its own read lands, never the previous
  // place's numbers under the new name.
  const board = data && arena && data.arenaKey === arena.key ? data : null;
  // While the next place loads, keep showing the previous one, dimmed — the
  // map flies there and the card swaps when the new rows land, instead of
  // blanking to a spinner on every arrow tap. Always paired with ITS OWN
  // arena, so old rows are never cut by the new outline or shown as the new
  // place's numbers.
  const shownArena = board ? arena : (data && arenas?.find((a) => a.key === data.arenaKey)) ?? null;
  const shown = board ?? (shownArena ? data : null);
  const stale = board === null && shown !== null;

  // ---- Board 1: who holds the claimed ground in this arena -------------
  //
  // Needs no data beyond the tiles themselves. See ConquestEntry.share for
  // why the denominator is claimed ground rather than the arena.
  const conquest = useMemo(() => {
    if (!shown?.tiles || shownArena === null) return null;
    return districtConquest(shown.tiles, shownArena);
  }, [shown, shownArena]);

  // ---- Board 2: mayorship over ground people keep coming back to ----------
  // Decided ONCE per load; the ranking and the map shapes both read it, so
  // they can't disagree.
  const leaderScoped = useMemo(
    () => (shown?.leaderVisits && shownArena ? scopeVisits(shown.leaderVisits, shownArena) : null),
    [shown, shownArena],
  );
  const mayors = useMemo(
    () => (leaderScoped ? mayorByCell(leaderScoped, undefined, shown?.runStats ?? undefined) : null),
    [leaderScoped, shown],
  );
  const leaders = useMemo(
    () => (mayors && leaderScoped ? rankMayorMap(mayors, namesOf(leaderScoped)) : null),
    [mayors, leaderScoped],
  );
  const leaderDays = useMemo(
    () => (leaderScoped ? daysPresent(leaderScoped, null) : new Map<string, number>()),
    [leaderScoped],
  );
  const leaderTotals = useMemo(
    () =>
      shown?.runStats && shown.leaderVisits && shownArena
        ? runnerTotals(shown.leaderVisits, shownArena, shown.runStats)
        : null,
    [shown, shownArena],
  );

  // The arena's caption — always the place being switched TO, so the pill
  // names the destination the moment an arrow is tapped. A subdivision has
  // its own name; a district takes districtLabel, then the metro region.
  const label = useMemo(() => {
    if (arena?.name) return arena.name;
    if (arena && board) {
      const fromParks = districtLabel(arena.key, board.parkCells);
      if (fromParks) return fromParks;
    }
    return coords ? (nearestRegion(coords.lat, coords.lng)?.name ?? null) : null;
  }, [arena, board, coords]);

  // ONE colour assignment for the screen, over everyone on either board, so
  // a runner is the same colour on both tabs, their shape and their row.
  const tints = useMemo(() => {
    const ids = [
      ...(conquest?.entries ?? []).map((e) => e.userId),
      ...(leaders ?? []).map((e) => e.userId),
    ];
    return assignTints([...new Set(ids)]);
  }, [conquest, leaders]);
  const tintOf = useCallback(
    (userId: string) => tints.get(userId) ?? FENCE_COLOR_SETS[0].color,
    [tints],
  );

  const holdings = useMemo<DistrictHolding[]>(() => {
    if (!shown?.tiles || shownArena === null) return [];
    const byOwner = new Map<string, string[]>();
    for (const tile of shown.tiles) {
      if (!shownArena.contains(tile.h3)) continue;
      const cells = byOwner.get(tile.ownerId);
      if (cells) cells.push(tile.h3);
      else byOwner.set(tile.ownerId, [tile.h3]);
    }
    return [...byOwner.entries()].map(([userId, cells]) => ({
      userId,
      cells,
      color: tintOf(userId),
      isMe: userId === shown.meUserId,
    }));
  }, [shown, shownArena, tintOf]);

  const leaderHoldings = useMemo<DistrictHolding[]>(() => {
    if (!mayors || !shown) return [];
    return [...holdingsOf(mayors).entries()].map(([userId, cells]) => ({
      userId,
      cells,
      color: tintOf(userId),
      isMe: userId === shown.meUserId,
    }));
  }, [mayors, shown, tintOf]);

  const chromeTop = insets.top + Spacing.two;
  const belowChrome = chromeTop + CAPSULE_H + Spacing.two;
  // Where the board is, the switcher, and the pull-to-refresh handle — one
  // pill, same place on both tabs. On Local Leaders' full-bleed map every
  // drag belongs to the map, and react-native-web's RefreshControl renders
  // nothing, so this is the refresh on both tabs on web. Arrows only when
  // the city has somewhere else to go.
  const canStep = (arenas?.length ?? 0) > 1;
  const pill = arena && (
    <PullPill
      top={belowChrome}
      label={label ?? t('leaderboard.arenaHere')}
      releaseLabel={t('leaderboard.pullRelease')}
      refreshingLabel={t('leaderboard.pullRefreshing')}
      a11yHint={t('leaderboard.pullHint')}
      refreshing={refreshing}
      onRefresh={() => void onRefresh()}
      onPrev={canStep ? () => stepArena(-1) : undefined}
      onNext={canStep ? () => stepArena(1) : undefined}
      prevLabel={t('leaderboard.arenaPrev')}
      nextLabel={t('leaderboard.arenaNext')}
      onPressLabel={arena === arenas?.[0] ? undefined : () => setArenaKey(null)}
      pressLabelHint={t('leaderboard.arenaHome')}
    />
  );
  const shell = (children: React.ReactNode) => (
    <Shell c={c} top={chromeTop} activeBoard={activeBoard} onChangeBoard={setActiveBoard}>
      {children}
      {pill}
    </Shell>
  );

  if (arena === null) {
    // Three different states, not one message. Before this branched, the
    // "we need your location" copy showed during the ordinary permission
    // probe and first fix — on every cold open of the tab — where it reads as
    // a refusal rather than as work in progress. And a denied permission was
    // a dead end: autoRequest fires once on mount, expo-router keeps this
    // screen mounted, so nothing ever asked again and there was no control to
    // ask with.
    if (locationStatus === 'idle' || locationStatus === 'locating') {
      return shell(
        <View style={styles.centre}>
          <ActivityIndicator color={c.textSecondary} />
          <Text style={[styles.emptyText, { color: c.textSecondary }]}>
            {t('leaderboard.locating')}
          </Text>
        </View>,
      );
    }
    return shell(
      <Empty
        icon="location.fill"
        android="my_location"
        text={
          locationStatus === 'unavailable'
            ? t('leaderboard.locationUnavailable')
            : t('leaderboard.needLocation')
        }
        c={c}
        action={
          // Only where asking again can actually help. 'unavailable' means
          // the device has no geolocation at all, and a button that cannot
          // work is worse than none.
          locationStatus === 'denied'
            ? { label: t('leaderboard.enableLocation'), onPress: () => void requestLocation() }
            : undefined
        }
      />,
    );
  }

  // Both tabs, one layout (Pedro, 2026-09-30): a full-bleed map of who
  // holds what, and a floating card of the top contenders. Same map
  // instance across tabs AND across places — switching tabs swaps whose
  // ground is drawn, switching places flies the camera — so neither tears
  // down a WebGL map and builds another.
  const isLocal = activeBoard === 'local';
  const cardBottom = insets.bottom + BottomTabInset - Spacing.two;
  const ranked = isLocal ? (leaders ?? []) : (conquest?.entries ?? []);
  // A pick that fell off the board after a refresh or a switch just clears.
  const focus = focusUserId && ranked.some((e) => e.userId === focusUserId) ? focusUserId : null;

  const rows: BoardCardRow[] = isLocal
    ? (leaders ?? []).map((entry) => {
        // Days, then the 30-day effort that breaks ties on them: distance,
        // pace (shown, never ranked) and laps.
        const tot = leaderTotals?.get(entry.userId);
        return {
          userId: entry.userId,
          name: entry.displayName ?? t('leaderboard.anonymous'),
          score: String(entry.cellsHeld),
          detail: [
            t('leaderboard.leaderDays', { count: leaderDays.get(entry.userId) ?? 0 }),
            tot ? formatDistance(tot.distanceM) : null,
            tot ? formatPace(tot.distanceM, tot.durationS) : null,
            tot && tot.laps > 0 ? t('leaderboard.leaderLaps', { count: tot.laps }) : null,
          ]
            .filter(Boolean)
            .join(' · '),
        };
      })
    : (conquest?.entries ?? []).map((entry) => {
        // Ground held right now — no days, no laps. Share of claimed ground,
        // then the same 30-day distance and pace Local Leaders shows, so one
        // runner reads the same on both tabs.
        const tot = leaderTotals?.get(entry.userId);
        return {
          userId: entry.userId,
          name: entry.displayName ?? t('leaderboard.anonymous'),
          score: String(entry.cellsHeld),
          detail: [
            pct(entry.share),
            tot ? formatDistance(tot.distanceM) : null,
            tot ? formatPace(tot.distanceM, tot.durationS) : null,
            entry.flaggedCellsHeld > 0
              ? t('leaderboard.flaggedTiles', { count: entry.flaggedCellsHeld })
              : null,
          ]
            .filter(Boolean)
            .join(' · '),
        };
      });

  const cardState: BoardCardState =
    shown === null
      ? 'loading'
      : shown.failed || (isLocal && shown.leaderVisits === null)
        ? 'failed'
        : 'ready';

  return shell(
    <>
      <MapErrorBoundary
        message={t('track.mapUnavailable')}
        color={c.textSecondary}
        background={c.background}>
        <DistrictMap
          arena={arena}
          holdings={isLocal ? leaderHoldings : holdings}
          focusUserId={focus}
          full={{
            padding: {
              top: belowChrome + PULL_PILL_H + Spacing.three,
              bottom: cardBottom + CARD_H + Spacing.three,
              left: Spacing.four,
              // Clears the zoom stack on the right edge.
              right: Spacing.three + 44 + Spacing.three,
            },
            controlsTop: belowChrome + PULL_PILL_H + Spacing.three,
            controls: {
              zoomInLabel: t('track.zoomIn'),
              zoomOutLabel: t('track.zoomOut'),
              refitLabel: t('leaderboard.leadersRefit'),
            },
          }}
        />
      </MapErrorBoundary>
      <BoardCard
        bottom={cardBottom}
        title={
          isLocal ? t('leaderboard.leadersTitle', { days: MAYORSHIP_WINDOW_DAYS }) : t('leaderboard.conquestTitle')
        }
        note={isLocal ? t('leaderboard.leadersNote') : t('leaderboard.conquestNote')}
        empty={
          isLocal
            ? t('leaderboard.leadersEmpty', { days: MAYORSHIP_WINDOW_DAYS })
            : t('leaderboard.conquestEmpty')
        }
        state={cardState}
        stale={stale}
        rows={rows}
        meUserId={shown?.meUserId ?? null}
        tintOf={tintOf}
        focusUserId={focus}
        onFocus={(userId) => setFocusUserId((cur) => (cur === userId ? null : userId))}
      />
    </>,
  );
}

type Board = 'municipio' | 'local';

/** Glass capsule height; content below it offsets by this. */
const CAPSULE_H = 40;
/** Ranking card: header + about three rows, the rest scrolls inside. */
const CARD_HEADER_H = 36;
const ROW_H = 44;
const CARD_H = CARD_HEADER_H + ROW_H * 3 + Spacing.two * 2;

function Shell({
  c,
  top,
  activeBoard,
  onChangeBoard,
  children,
}: {
  c: Record<ThemeColor, string>;
  top: number;
  activeBoard: Board;
  onChangeBoard: (b: Board) => void;
  children: React.ReactNode;
}) {
  return (
    <View style={[styles.root, { backgroundColor: c.background }]}>
      {children}
      <BoardTabs active={activeBoard} onChange={onChangeBoard} top={top} />
      <ProfilePill />
    </View>
  );
}

/** The two sub-tabs as one floating glass capsule, left of the profile
 *  pill and level with it. Same position on both tabs, so switching never
 *  moves the control — Local Leaders' map runs under it, Leaderboard's
 *  scroll starts below it. Always dark glass, like the pill beside it. */
function BoardTabs({
  active,
  onChange,
  top,
}: {
  active: Board;
  onChange: (b: Board) => void;
  top: number;
}) {
  const { t } = useI18n();
  const tabs: { key: Board; label: string }[] = [
    { key: 'municipio', label: t('leaderboard.tabMunicipio') },
    { key: 'local', label: t('leaderboard.tabLocal') },
  ];
  return (
    <View style={[styles.capsuleWrap, { top }]} pointerEvents="box-none">
      <GlassSurface scheme="dark" radius={GlassRadii.pill} contentStyle={styles.capsule}>
        {tabs.map((tab) => {
          const selected = active === tab.key;
          return (
            <Pressable
              key={tab.key}
              onPress={() => onChange(tab.key)}
              accessibilityRole="tab"
              accessibilityState={{ selected }}
              style={[styles.capsuleItem, selected && styles.capsuleItemOn]}>
              <Text
                numberOfLines={1}
                style={[styles.capsuleLabel, { color: selected ? '#ffffff' : 'rgba(255,255,255,0.6)' }]}>
                {tab.label}
              </Text>
            </Pressable>
          );
        })}
      </GlassSurface>
    </View>
  );
}

type BoardCardState = 'loading' | 'failed' | 'ready';

interface BoardCardRow {
  userId: string;
  name: string;
  /** Tiles held — the number each board ranks by. */
  score: string;
  detail: string;
}

/** The ranking, floating over the map — the same card on both tabs, rows
 *  prepared by the caller. Rank, colour (the link to the shape on the map),
 *  name, detail, score. Your row is highlighted and scrolled into view; a
 *  tap highlights that runner's ground. While the next place loads the
 *  previous rows stay, dimmed, instead of blanking to a spinner. */
function BoardCard({
  bottom,
  title,
  note,
  empty,
  state,
  stale,
  rows,
  meUserId,
  tintOf,
  focusUserId,
  onFocus,
}: {
  bottom: number;
  title: string;
  note: string;
  empty: string;
  state: BoardCardState;
  stale: boolean;
  rows: BoardCardRow[];
  meUserId: string | null;
  tintOf: (userId: string) => string;
  focusUserId: string | null;
  onFocus: (userId: string) => void;
}) {
  const { t } = useI18n();
  const [showNote, setShowNote] = useState(false);
  const listRef = useRef<ScrollView | null>(null);
  const myIndex = rows.findIndex((r) => r.userId === meUserId);

  useEffect(() => {
    // One row of context above your own, so you see who you're chasing.
    if (myIndex > 0) listRef.current?.scrollTo({ y: (myIndex - 1) * ROW_H, animated: false });
  }, [myIndex]);

  return (
    <View style={[styles.cardWrap, { bottom }]} pointerEvents="box-none">
      <GlassSurface scheme="dark" radius={GlassRadii.card} contentStyle={styles.card}>
        <Pressable
          onPress={() => setShowNote((v) => !v)}
          accessibilityRole="button"
          accessibilityState={{ expanded: showNote }}
          accessibilityLabel={t('leaderboard.leadersNoteToggle')}
          style={styles.cardHeader}>
          <Text style={styles.cardTitle} numberOfLines={1}>
            {title}
          </Text>
          <View style={styles.cardHeaderEnd}>
            {stale && <ActivityIndicator size="small" color="rgba(255,255,255,0.7)" />}
            <Icon ios="info.circle" android="info" size={16} color="rgba(255,255,255,0.6)" />
          </View>
        </Pressable>
        {showNote && <Text style={styles.cardNote}>{note}</Text>}
        {state === 'loading' ? (
          <View style={styles.cardState}>
            <ActivityIndicator color="rgba(255,255,255,0.7)" />
          </View>
        ) : state === 'failed' ? (
          <Text style={[styles.cardNote, styles.cardState]}>{t('leaderboard.error')}</Text>
        ) : rows.length === 0 ? (
          <Text style={[styles.cardNote, styles.cardState]}>{empty}</Text>
        ) : (
          <Animated.View key={rows.map((r) => r.userId).join(',')} entering={FadeIn.duration(220)}>
            <ScrollView
              ref={listRef}
              style={{ maxHeight: ROW_H * 3, opacity: stale ? 0.45 : 1 }}
              showsVerticalScrollIndicator>
              {rows.map((row, i) => {
                const isMe = row.userId === meUserId;
                const focused = row.userId === focusUserId;
                return (
                  <Pressable
                    key={row.userId}
                    onPress={() => onFocus(row.userId)}
                    style={[styles.leaderRow, isMe && styles.leaderRowMe, focused && styles.leaderRowFocused]}
                    accessibilityRole="button"
                    accessibilityState={{ selected: focused }}
                    accessibilityHint={t('leaderboard.leaderFocusHint')}
                    accessibilityLabel={`${i + 1}. ${row.name}, ${row.score}. ${row.detail}`}>
                    <Text style={styles.leaderRank}>{i + 1}</Text>
                    <View style={[styles.leaderSwatch, { backgroundColor: tintOf(row.userId) }]} />
                    <View style={styles.leaderText}>
                      <Text style={styles.leaderName} numberOfLines={1}>
                        {isMe ? t('leaderboard.leaderMe', { name: row.name }) : row.name}
                      </Text>
                      <Text style={styles.leaderDays} numberOfLines={1}>
                        {row.detail}
                      </Text>
                    </View>
                    <Text style={styles.leaderScore}>{row.score}</Text>
                  </Pressable>
                );
              })}
            </ScrollView>
          </Animated.View>
        )}
      </GlassSurface>
    </View>
  );
}

function Empty({
  icon,
  android,
  text,
  c,
  action,
}: {
  icon: SFSymbol;
  android: AndroidSymbol;
  text: string;
  c: Record<ThemeColor, string>;
  /** A way out of the state, where one exists. */
  action?: { label: string; onPress: () => void };
}) {
  return (
    <Animated.View entering={FadeIn.duration(400)} style={styles.centre}>
      <View style={[styles.iconWrap, { backgroundColor: c.backgroundElement }]}>
        <Icon ios={icon} android={android} size={28} color={c.textSecondary} />
      </View>
      <Text style={[styles.emptyText, { color: c.textSecondary }]}>{text}</Text>
      {action && (
        <Pressable
          onPress={action.onPress}
          accessibilityRole="button"
          style={[styles.action, { backgroundColor: c.accent }]}>
          <Text style={styles.actionLabel}>{action.label}</Text>
        </Pressable>
      )}
    </Animated.View>
  );
}

/**
 * A share as a percentage string.
 *
 * Two decimals below 1%, because that is the range this app actually lives
 * in — one 5.7 km run is 5.5% of a municipio's park paths, and a district is
 * smaller still, but a runner's FIRST run can easily be 0.4%. Rounding that
 * to "0%" would tell them their run did nothing.
 */
function pct(share: number): string {
  if (!Number.isFinite(share) || share <= 0) return '0%';
  if (share < 0.01) return `${(share * 100).toFixed(2)}%`;
  if (share < 0.1) return `${(share * 100).toFixed(1)}%`;
  return `${Math.round(share * 100)}%`;
}

/** A runner's preferred accent — stable for the life of their account, keyed
 *  on the user id rather than their fence colour (which is per-run by
 *  design). */
function preferredTint(userId: string): number {
  let h = 0;
  for (let i = 0; i < userId.length; i++) h = (h * 31 + userId.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/**
 * Distinct colours for everyone on screen.
 *
 * Colour is the ONLY thing linking a runner across the three views — their
 * slice of the share bar, their shape on the map, and their row. A collision
 * merges two people's territory into one apparent colour, which is worse
 * than either of them being a colour they did not pick.
 *
 * FENCE_COLOR_SETS holds six colours, so hashing alone collides ~72% of the
 * time with four runners in a district (review, 2026-09-09). This keeps the
 * hash as a PREFERENCE — so a runner's colour is stable as long as nobody
 * else wants it — and walks to the next free one when it is taken. Ties
 * resolve by rank order, which is stable between loads because both boards
 * are total orders.
 *
 * Past six runners colours must repeat; the wrap is deterministic rather
 * than arbitrary so at least the repeat is consistent between renders.
 */
function assignTints(userIds: string[]): Map<string, string> {
  const palette = FENCE_COLOR_SETS.length;
  const taken = new Set<number>();
  const out = new Map<string, string>();
  for (const userId of userIds) {
    const wanted = preferredTint(userId) % palette;
    let slot = wanted;
    for (let step = 0; step < palette && taken.has(slot); step++) {
      slot = (wanted + step + 1) % palette;
    }
    taken.add(slot);
    out.set(userId, FENCE_COLOR_SETS[slot].color);
  }
  return out;
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  // Centred on the viewport, level with the 40pt profile pill
  // (profile-pill.tsx). Equal side insets that clear the pill keep it both
  // centred and off the pill on a narrow phone.
  capsuleWrap: {
    position: 'absolute',
    left: Spacing.three + 40 + Spacing.two,
    right: Spacing.three + 40 + Spacing.two,
    zIndex: 10,
    alignItems: 'center',
  },
  capsule: { flexDirection: 'row', height: CAPSULE_H, padding: 3, gap: 2 },
  capsuleItem: {
    flexShrink: 1,
    paddingHorizontal: Spacing.three,
    borderRadius: 999,
    justifyContent: 'center',
  },
  capsuleItemOn: { backgroundColor: 'rgba(255,255,255,0.18)' },
  capsuleLabel: { fontSize: 14, fontWeight: '700' },
  cardWrap: { position: 'absolute', left: Spacing.three, right: Spacing.three },
  card: { paddingVertical: Spacing.two, paddingHorizontal: Spacing.three },
  cardHeader: {
    height: CARD_HEADER_H,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.two,
  },
  cardHeaderEnd: { flexDirection: 'row', alignItems: 'center', gap: Spacing.two },
  cardTitle: {
    flexShrink: 1,
    color: 'rgba(255,255,255,0.7)',
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 0.8,
  },
  cardNote: { color: 'rgba(255,255,255,0.75)', fontSize: 13, lineHeight: 18, paddingBottom: Spacing.two },
  cardState: { minHeight: ROW_H, justifyContent: 'center', paddingVertical: Spacing.two },
  leaderRow: {
    height: ROW_H,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    paddingHorizontal: Spacing.two,
    borderRadius: 12,
  },
  leaderRowMe: { backgroundColor: 'rgba(255,255,255,0.14)' },
  leaderRowFocused: { borderWidth: 1.5, borderColor: 'rgba(255,255,255,0.85)' },
  leaderRank: {
    width: 22,
    color: 'rgba(255,255,255,0.6)',
    fontSize: 13,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
  leaderSwatch: { width: 10, height: 10, borderRadius: 3 },
  leaderText: { flex: 1, minWidth: 0 },
  leaderName: { color: '#ffffff', fontSize: 15, fontWeight: '700' },
  leaderDays: { color: 'rgba(255,255,255,0.6)', fontSize: 12 },
  leaderScore: { color: '#ffffff', fontSize: 16, fontWeight: '800', fontVariant: ['tabular-nums'] },
  centre: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.three,
    paddingHorizontal: Spacing.five,
    paddingBottom: BottomTabInset,
  },
  iconWrap: { width: 64, height: 64, borderRadius: 32, alignItems: 'center', justifyContent: 'center' },
  action: { paddingVertical: Spacing.two, paddingHorizontal: Spacing.four, borderRadius: 999 },
  actionLabel: { color: '#ffffff', fontSize: 15, fontWeight: '700' },
  emptyText: { fontSize: 15, lineHeight: 22, textAlign: 'center' },
});

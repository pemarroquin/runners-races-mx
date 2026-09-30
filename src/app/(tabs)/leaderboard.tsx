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
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  useColorScheme,
  View,
} from 'react-native';
import Animated, { FadeIn, FadeInDown } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { BoardRow } from '@/components/board-row';
import { DistrictMap, type DistrictHolding } from '@/components/district-map';
import { MapErrorBoundary } from '@/components/map-error-boundary';
import { ProfilePill } from '@/components/profile-pill';
import { PULL_PILL_H, PullPill } from '@/components/pull-pill';
import { ShareBar, type ShareSegment } from '@/components/share-bar';
import { GlassSurface } from '@/components/ui/glass-surface';
import { Icon } from '@/components/ui/icon';
import { GlassRadii } from '@/constants/glass';
import { FENCE_COLOR_SETS } from '@/constants/map';
import { BottomTabInset, Colors, Spacing, type ThemeColor } from '@/constants/theme';
import { onIdentityChanged } from '@/lib/auth-events';
import { fetchDistrictParkCells, fetchDistrictVisits, type ParkCell } from '@/lib/boards';
import { districtLabel, districtOf, districtOfCell } from '@/lib/district';
import { nearestRegion } from '@/lib/regions';
import { useI18n } from '@/lib/i18n';
import { districtConquest, type TileOwnerRow } from '@/lib/leaderboard';
import { daysPresent, mayorHoldings } from '@/lib/local-leaders';
import {
  MAYORSHIP_WINDOW_DAYS,
  contestedCells,
  mayorByCell,
  rankMayors,
  type MayorshipEntry,
} from '@/lib/mayorship';
import { useCurrentLocation } from '@/lib/use-current-location';
import { fetchTileLeaderboard } from '@/lib/territory-sync';

/** Everything the screen needs, resolved together. `null` is "not loaded
 *  yet"; a failed visits read keeps the rest — Local Leaders going empty
 *  must not take the conquest board with it. */
interface BoardData {
  tiles: TileOwnerRow[] | null;
  meUserId: string | null;
  /** For districtLabel's caption only — a failed or empty read just means
   *  the arena falls back to the metro region name, never a failed board. */
  parkCells: ParkCell[];
  visits: Parameters<typeof mayorByCell>[0];
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

  const district = useMemo(() => (coords ? districtOf(coords) : null), [coords]);

  const [data, setData] = useState<BoardData | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  // The runner picked on the Local Leaders card; their ground is highlighted.
  const [focusUserId, setFocusUserId] = useState<string | null>(null);
  const [identitySignal, setIdentitySignal] = useState(0);
  useEffect(() => onIdentityChanged(() => setIdentitySignal((v) => v + 1)), []);

  const load = useCallback(async (forDistrict: string): Promise<BoardData> => {
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
      fetchTileLeaderboard(forDistrict),
      fetchDistrictParkCells(forDistrict),
      fetchDistrictVisits(forDistrict),
    ]);
    return {
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
    if (district === null) return;
    const ticket = ++loadTicketRef.current;
    setRefreshing(true);
    const next = await load(district);
    if (loadTicketRef.current === ticket) setData(next);
    setRefreshing(false);
  }, [district, load]);

  // Refetches on every focus, not just first mount: expo-router keeps tab
  // screens mounted, so a `[]`-deps effect would fetch once early in the
  // session and never again. Same reasoning — and the same identity signal —
  // as the screen this replaced.
  useEffect(() => {
    if (!isFocused || district === null) return;
    const ticket = ++loadTicketRef.current;
    const id = setTimeout(() => {
      load(district).then((next) => {
        // Same ticket as onRefresh, not a local `stale` flag: the two paths
        // race each other, so one shared notion of "newest" is the only thing
        // that orders them.
        if (loadTicketRef.current === ticket) setData(next);
      });
    }, 0);
    return () => clearTimeout(id);
  }, [isFocused, district, identitySignal, load]);

  // ---- Board 1: who holds the claimed ground in this district ------------
  //
  // Needs no data beyond the tiles themselves — no park table, no
  // hand-applied migration, nothing that can be forgotten. See
  // ConquestEntry.share for why the denominator is claimed ground rather
  // than the district.
  const conquest = useMemo(() => {
    if (!data?.tiles || district === null) return null;
    return districtConquest(data.tiles, district);
  }, [data, district]);

  // ---- Board 2: mayorship over ground people keep coming back to ----------
  const mayors = useMemo(() => (data ? mayorByCell(data.visits) : null), [data]);
  const leaders = useMemo(
    () => (data && district !== null ? rankMayors(data.visits, district) : null),
    [data, district],
  );

  // The arena's caption. districtLabel first — the real municipio name by
  // majority vote over this district's park cells, matching what the Saved
  // tab's progress screen shows for the same ground — falling back to the
  // metro region where no park data has been extracted for this district
  // (most of the planet). Decorative either way: the district id is what
  // scores, never this string.
  const label = useMemo(() => {
    if (district !== null && data) {
      const fromParks = districtLabel(district, data.parkCells);
      if (fromParks) return fromParks;
    }
    return coords ? (nearestRegion(coords.lat, coords.lng)?.name ?? null) : null;
  }, [district, data, coords]);

  // ---- Your own standing, which is the hero ------------------------------
  const me = conquest?.entries.find((e) => e.userId === data?.meUserId) ?? null;
  const myRank = me ? (conquest?.entries.indexOf(me) ?? -1) + 1 : 0;
  const contested = useMemo(() => {
    if (!data?.tiles || !mayors || !data.meUserId || district === null) return 0;
    const mine = data.tiles
      .filter((tile) => tile.ownerId === data.meUserId)
      .map((tile) => tile.h3);
    return contestedCells(mine, mayors, data.meUserId).length;
  }, [data, mayors, district]);

  // The map's input. Same source as the share bar and the rows — one fetch,
  // three views of it, so they can never disagree about who holds what.
  // ONE assignment for the screen, over everyone who appears on either
  // board, so the map, the bar and both lists agree — and so a runner who is
  // on Local Leaders but holds no ground still gets a distinct colour.
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
    if (!data?.tiles || district === null) return [];
    const byOwner = new Map<string, string[]>();
    for (const tile of data.tiles) {
      if (districtOfCell(tile.h3) !== district) continue;
      const cells = byOwner.get(tile.ownerId);
      if (cells) cells.push(tile.h3);
      else byOwner.set(tile.ownerId, [tile.h3]);
    }
    return [...byOwner.entries()].map(([userId, cells]) => ({
      userId,
      cells,
      color: tintOf(userId),
      isMe: userId === data.meUserId,
    }));
  }, [data, district, tintOf]);

  // Board 2 on the map: each runner's mayor cells, scoped exactly as
  // rankMayors scopes them, so a shape and its row always hold the same
  // count (test/local-leaders.test.ts).
  const leaderHoldings = useMemo<DistrictHolding[]>(() => {
    if (!data || district === null) return [];
    return [...mayorHoldings(data.visits, district).entries()].map(([userId, cells]) => ({
      userId,
      cells,
      color: tintOf(userId),
      isMe: userId === data.meUserId,
    }));
  }, [data, district, tintOf]);
  const leaderDays = useMemo(
    () => (data && district !== null ? daysPresent(data.visits, district) : new Map<string, number>()),
    [data, district],
  );

  const shareSegments = useMemo<ShareSegment[]>(() => {
    if (!conquest) return [];
    return conquest.entries.map((entry) => ({
      key: entry.userId,
      share: entry.share,
      color: tintOf(entry.userId),
      label: `${entry.displayName ?? t('leaderboard.anonymous')} ${pct(entry.share)}`,
      isMe: entry.userId === data?.meUserId,
    }));
  }, [conquest, data, t, tintOf]);

  const chromeTop = insets.top + Spacing.two;
  const shell = (children: React.ReactNode) => (
    <Shell c={c} top={chromeTop} activeBoard={activeBoard} onChangeBoard={setActiveBoard}>
      {children}
    </Shell>
  );

  if (district === null) {
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

  if (activeBoard === 'local') {
    // Full-bleed. The district is known, so the map draws even while the
    // board loads or after it fails — loading and errors live in the card.
    const cardBottom = insets.bottom + BottomTabInset - Spacing.two;
    // A pick that fell off the board after a refresh just clears.
    const focus = focusUserId && leaders?.some((e) => e.userId === focusUserId) ? focusUserId : null;
    const belowChrome = chromeTop + CAPSULE_H + Spacing.two;
    return shell(
      <>
        <MapErrorBoundary
          message={t('track.mapUnavailable')}
          color={c.textSecondary}
          background={c.background}>
          <DistrictMap
            // A new arena remounts with a new camera frame, same as Municipio.
            key={district}
            district={district}
            holdings={leaderHoldings}
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
        {/* Where this board is, and the pull-to-refresh handle: on a
            full-bleed map every drag belongs to the map, so the pull lives
            on the one piece of chrome at the top that isn't map. The arrows
            that step through the city's subdivisions arrive with the
            boundary data. The name is decorative: the district id scores. */}
        <PullPill
          top={belowChrome}
          label={label ?? t('leaderboard.arenaHere')}
          releaseLabel={t('leaderboard.pullRelease')}
          refreshingLabel={t('leaderboard.pullRefreshing')}
          a11yHint={t('leaderboard.pullHint')}
          refreshing={refreshing}
          onRefresh={() => void onRefresh()}
        />
        <LeadersCard
          bottom={cardBottom}
          state={data === null ? 'loading' : data.failed ? 'failed' : 'ready'}
          leaders={leaders ?? []}
          days={leaderDays}
          meUserId={data?.meUserId ?? null}
          tintOf={tintOf}
          focusUserId={focus}
          onFocus={(userId) => setFocusUserId((cur) => (cur === userId ? null : userId))}
        />
      </>,
    );
  }

  if (data === null) {
    return shell(
      <View style={styles.centre}>
        <ActivityIndicator color={c.textSecondary} />
      </View>,
    );
  }

  if (data.failed) {
    return shell(<Empty icon="exclamationmark.triangle" android="warning" text={t('leaderboard.error')} c={c} />);
  }

  return shell(
      <ScrollView
        contentContainerStyle={[styles.scroll, { paddingTop: chromeTop + CAPSULE_H + Spacing.three }]}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={c.textSecondary} />
        }>
        {/* THE ARENA. A caption, not a control — there is nothing to pick.
            `label` is the real municipio where park data covers this
            district, else the metro region, and null before the first fix —
            the fallback says "where you are" rather than inventing a place
            name. Decorative: the district id is what scores. */}
        <Animated.View entering={FadeIn.duration(300)} style={styles.arena}>
          <Text style={[styles.arenaKicker, { color: c.textSecondary }]}>
            {t('leaderboard.arenaKicker')}
          </Text>
          <Text style={[styles.arenaName, { color: c.text }]} numberOfLines={1}>
            {label ?? t('leaderboard.arenaHere')}
          </Text>
        </Animated.View>

        {/* THE HERO — your own standing, as the biggest thing on screen. */}
        <Animated.View
          entering={FadeInDown.duration(340)}
          style={[styles.hero, { backgroundColor: c.backgroundElement }]}>
          <Text style={[styles.heroValue, { color: c.text }]}>
            {pct(me?.share ?? 0)}
          </Text>
          <Text style={[styles.heroCaption, { color: c.textSecondary }]}>
            {/* Share of the ground anyone holds here — the competitive
                number. How much of the district is untouched is a different
                question and is answered under the bar. */}
            {t('leaderboard.heroClaimedShare')}
          </Text>
          <View style={styles.heroChips}>
            <Chip
              text={myRank > 0 ? t('leaderboard.rankOf', { rank: myRank, total: conquest?.entries.length ?? 0 }) : t('leaderboard.unranked')}
              c={c}
            />
            {contested > 0 && (
              <Chip text={t('leaderboard.contested', { count: contested })} c={c} tone={c.accent} />
            )}
          </View>
        </Animated.View>

        {/* WHERE the ground is. Keyed on the district so a new arena
            remounts with a new camera frame rather than animating there —
            see the map's own mount-effect comment. Hidden when nobody holds
            anything: an empty frame is not a picture of a contest. */}
        {holdings.length > 0 && (
          <Animated.View entering={FadeInDown.duration(340).delay(40)}>
            <DistrictMap key={district} district={district} holdings={holdings} />
          </Animated.View>
        )}

        {/* WHO HOLDS THIS PLACE, as one bar. Only where there is a real
            denominator — a bar of nothing is not a picture of anything. */}
        {shareSegments.length > 0 && (
          <Animated.View entering={FadeInDown.duration(340).delay(60)} style={styles.block}>
            {/* Segments sum to 1 — every claimed cell has exactly one
                holder — so there is no remainder to draw. */}
            <ShareBar segments={shareSegments} c={c} unclaimedLabel={null} />
            {/* The frontier, as a caption rather than a slice. It is a
                different question with a different denominator (the whole
                district, buildings and all), and drawing it in the same bar
                would squash every runner into an invisible sliver — which is
                what it did. Small here is the honest answer and the point:
                it is how much is left to take. */}
            <Text style={[styles.frontier, { color: c.textSecondary }]}>
              {t('leaderboard.frontier', {
                pct: pct((conquest?.claimedTotal ?? 0) / (conquest?.districtTotal || 1)),
              })}
            </Text>
          </Animated.View>
        )}

        {/* BOARD 1 */}
        <Section
          title={t('leaderboard.conquestTitle')}
          note={t('leaderboard.conquestNote')}
          c={c}>
          {conquest && conquest.entries.length > 0 ? (
            conquest.entries.map((entry, i) => (
              <BoardRow
                key={entry.userId}
                rank={i + 1}
                name={entry.displayName ?? t('leaderboard.anonymous')}
                score={pct(entry.share)}
                detail={t('leaderboard.cellsDetail', { count: entry.cellsHeld })}
                tint={tintOf(entry.userId)}
                isMe={entry.userId === data?.meUserId}
                flaggedLabel={
                  entry.flaggedCellsHeld > 0
                    ? t('leaderboard.flaggedTiles', { count: entry.flaggedCellsHeld })
                    : undefined
                }
                c={c}
              />
            ))
          ) : (
            <Text style={[styles.note, { color: c.textSecondary }]}>
              {t('leaderboard.conquestEmpty')}
            </Text>
          )}
        </Section>
      </ScrollView>,
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

/** Board 2's ranking, floating over its own map. Rank, colour (the link to
 *  the shape on the map), name, days present, cells held. Your row is
 *  highlighted and scrolled into view. */
function LeadersCard({
  bottom,
  state,
  leaders,
  days,
  meUserId,
  tintOf,
  focusUserId,
  onFocus,
}: {
  bottom: number;
  state: 'loading' | 'failed' | 'ready';
  leaders: MayorshipEntry[];
  days: Map<string, number>;
  meUserId: string | null;
  tintOf: (userId: string) => string;
  focusUserId: string | null;
  onFocus: (userId: string) => void;
}) {
  const { t } = useI18n();
  const [showNote, setShowNote] = useState(false);
  const listRef = useRef<ScrollView | null>(null);
  const myIndex = leaders.findIndex((e) => e.userId === meUserId);

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
            {t('leaderboard.leadersTitle', { days: MAYORSHIP_WINDOW_DAYS })}
          </Text>
          <View>
            <Icon ios="info.circle" android="info" size={16} color="rgba(255,255,255,0.6)" />
          </View>
        </Pressable>
        {showNote && <Text style={styles.cardNote}>{t('leaderboard.leadersNote')}</Text>}
        {state === 'loading' ? (
          <View style={styles.cardState}>
            <ActivityIndicator color="rgba(255,255,255,0.7)" />
          </View>
        ) : state === 'failed' ? (
          <Text style={[styles.cardNote, styles.cardState]}>{t('leaderboard.error')}</Text>
        ) : leaders.length === 0 ? (
          <Text style={[styles.cardNote, styles.cardState]}>
            {t('leaderboard.leadersEmpty', { days: MAYORSHIP_WINDOW_DAYS })}
          </Text>
        ) : (
          <ScrollView ref={listRef} style={{ maxHeight: ROW_H * 3 }} showsVerticalScrollIndicator>
            {leaders.map((entry, i) => {
              const isMe = entry.userId === meUserId;
              const name = entry.displayName ?? t('leaderboard.anonymous');
              const focused = entry.userId === focusUserId;
              return (
                <Pressable
                  key={entry.userId}
                  onPress={() => onFocus(entry.userId)}
                  style={[styles.leaderRow, isMe && styles.leaderRowMe, focused && styles.leaderRowFocused]}
                  accessibilityRole="button"
                  accessibilityState={{ selected: focused }}
                  accessibilityHint={t('leaderboard.leaderFocusHint')}
                  accessibilityLabel={t('leaderboard.leaderRowA11y', {
                    rank: i + 1,
                    name,
                    count: entry.cellsHeld,
                    days: days.get(entry.userId) ?? 0,
                  })}>
                  <Text style={styles.leaderRank}>{i + 1}</Text>
                  <View style={[styles.leaderSwatch, { backgroundColor: tintOf(entry.userId) }]} />
                  <View style={styles.leaderText}>
                    <Text style={styles.leaderName} numberOfLines={1}>
                      {isMe ? t('leaderboard.leaderMe', { name }) : name}
                    </Text>
                    <Text style={styles.leaderDays} numberOfLines={1}>
                      {t('leaderboard.leaderDays', { count: days.get(entry.userId) ?? 0 })}
                    </Text>
                  </View>
                  <Text style={styles.leaderScore}>{entry.cellsHeld}</Text>
                </Pressable>
              );
            })}
          </ScrollView>
        )}
      </GlassSurface>
    </View>
  );
}

function Section({
  title,
  note,
  c,
  children,
}: {
  title: string;
  note: string;
  c: Record<ThemeColor, string>;
  children: React.ReactNode;
}) {
  return (
    <View style={styles.block}>
      <Text style={[styles.sectionTitle, { color: c.text }]}>{title}</Text>
      {/* Every section states what it measures. This is what lets both
          boards share one screen — see this file's header. */}
      <Text style={[styles.sectionNote, { color: c.textSecondary }]}>{note}</Text>
      <View style={styles.rows}>{children}</View>
    </View>
  );
}

function Chip({
  text,
  c,
  tone,
}: {
  text: string;
  c: Record<ThemeColor, string>;
  tone?: string;
}) {
  return (
    <View style={[styles.chip, { backgroundColor: c.backgroundSelected }]}>
      <Text style={[styles.chipText, { color: tone ?? c.textSecondary }]}>{text}</Text>
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
  // Left of the 40pt profile pill, level with it (profile-pill.tsx).
  capsuleWrap: {
    position: 'absolute',
    left: Spacing.three,
    right: Spacing.three + 40 + Spacing.two,
    zIndex: 10,
    alignItems: 'flex-start',
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
  scroll: { padding: Spacing.three, gap: Spacing.four, paddingBottom: BottomTabInset },
  arena: { gap: 2 },
  arenaKicker: { fontSize: 12, fontWeight: '700', letterSpacing: 0.8 },
  arenaName: { fontSize: 22, fontWeight: '700' },
  hero: { borderRadius: Spacing.three, padding: Spacing.four, gap: Spacing.one },
  heroValue: { fontSize: 52, fontWeight: '800', fontVariant: ['tabular-nums'] },
  heroCaption: { fontSize: 14, lineHeight: 19 },
  heroChips: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.one, paddingTop: Spacing.two },
  chip: { paddingVertical: 4, paddingHorizontal: Spacing.two, borderRadius: 999 },
  chipText: { fontSize: 12, fontWeight: '700' },
  block: { gap: Spacing.two },
  frontier: { fontSize: 12, fontWeight: '600' },
  sectionTitle: { fontSize: 13, fontWeight: '800', letterSpacing: 0.8 },
  sectionNote: { fontSize: 13, lineHeight: 18 },
  rows: { gap: Spacing.two, paddingTop: Spacing.one },
  note: { fontSize: 13, lineHeight: 19 },
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

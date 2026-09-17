// The leaderboard. ONE screen, THREE tabs (2026-09-17 nav restructure).
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
//   pills. These three tabs are one axis — WHICH BOARD — and each is
//   self-explanatory by name: My Achievements (a personal record, no
//   location needed), Municipio (Board 1, live conquest), Local Leaders
//   (Board 2, mayorship). Nothing here recreates "Regulars."
//
//   WHERE still collapses to the district you're standing in (district.ts)
//   for the two boards that need a place at all — that reasoning is
//   untouched. My Achievements needs no district: it's everything you've
//   ever taken, not what you hold in any one place right now.
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
import { SafeAreaView } from 'react-native-safe-area-context';

import { AchievementsView } from '@/components/achievements-view';
import { BoardRow } from '@/components/board-row';
import { DistrictMap, type DistrictHolding } from '@/components/district-map';
import { ProfilePill } from '@/components/profile-pill';
import { ShareBar, type ShareSegment } from '@/components/share-bar';
import { Icon } from '@/components/ui/icon';
import { FENCE_COLOR_SETS } from '@/constants/map';
import { BottomTabInset, Colors, Spacing, type ThemeColor } from '@/constants/theme';
import { onIdentityChanged } from '@/lib/auth-events';
import { fetchDistrictParkCells, fetchDistrictVisits, type ParkCell } from '@/lib/boards';
import { districtLabel, districtOf, districtOfCell } from '@/lib/district';
import { nearestRegion } from '@/lib/regions';
import { useI18n } from '@/lib/i18n';
import { districtConquest, type TileOwnerRow } from '@/lib/leaderboard';
import {
  MAYORSHIP_WINDOW_DAYS,
  contestedCells,
  mayorByCell,
  rankMayors,
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
  const { t, locale } = useI18n();
  const isFocused = useIsFocused();

  // Three sub-tabs, one screen (2026-09-17 nav restructure, Pedro's ask,
  // in his own A/B/C order): My Achievements (A — a personal record, needs
  // no location or district data at all, see the branch below), Municipio
  // (B — Board 1, the old file's "conquest" section) and Local Leaders
  // (C — Board 2, "mayorship"). Defaults to the first tab, same as any
  // segmented control.
  const [activeBoard, setActiveBoard] = useState<'mine' | 'municipio' | 'local'>('mine');
  // The arena follows the runner. A real fix or nothing — never a region
  // fallback, for the same reason the Track map refuses to place its pin on a
  // city centre: this decides which ground a runner is being ranked on, and
  // a guess would rank them somewhere they have never been.
  //
  // `autoRequest` is OFF while My Achievements is the visible tab: that
  // board needs no location at all (see the district gate below), so a
  // runner whose default landing tab is now 'mine' should never see a
  // location permission prompt just for opening Leaderboard. Flips reactive
  // — the moment they tap Municipio or Local Leaders, `autoRequest` goes
  // true and useCurrentLocation's own effect fires the request then.
  const { coords, status: locationStatus, request: requestLocation } = useCurrentLocation({
    autoRequest: activeBoard !== 'mine',
  });

  const district = useMemo(() => (coords ? districtOf(coords) : null), [coords]);

  const [data, setData] = useState<BoardData | null>(null);
  const [refreshing, setRefreshing] = useState(false);
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

  // My Achievements needs neither location nor a district fetch — it's a
  // personal record, not a place-scoped board (see achievements-view.tsx) —
  // so none of the three gates below apply to it. They only run for
  // Municipio/Local Leaders, which both need `district`/`data`.
  if (activeBoard !== 'mine' && district === null) {
    // Three different states, not one message. Before this branched, the
    // "we need your location" copy showed during the ordinary permission
    // probe and first fix — on every cold open of the tab — where it reads as
    // a refusal rather than as work in progress. And a denied permission was
    // a dead end: autoRequest fires once on mount, expo-router keeps this
    // screen mounted, so nothing ever asked again and there was no control to
    // ask with.
    if (locationStatus === 'idle' || locationStatus === 'locating') {
      return (
        <Shell c={c} title={t('leaderboard.title')} activeBoard={activeBoard} onChangeBoard={setActiveBoard}>
          <View style={styles.centre}>
            <ActivityIndicator color={c.textSecondary} />
            <Text style={[styles.emptyText, { color: c.textSecondary }]}>
              {t('leaderboard.locating')}
            </Text>
          </View>
        </Shell>
      );
    }
    return (
      <Shell c={c} title={t('leaderboard.title')} activeBoard={activeBoard} onChangeBoard={setActiveBoard}>
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
        />
      </Shell>
    );
  }

  if (activeBoard !== 'mine' && data === null) {
    return (
      <Shell c={c} title={t('leaderboard.title')} activeBoard={activeBoard} onChangeBoard={setActiveBoard}>
        <View style={styles.centre}>
          <ActivityIndicator color={c.textSecondary} />
        </View>
      </Shell>
    );
  }

  if (activeBoard !== 'mine' && data?.failed) {
    return (
      <Shell c={c} title={t('leaderboard.title')} activeBoard={activeBoard} onChangeBoard={setActiveBoard}>
        <Empty icon="exclamationmark.triangle" android="warning" text={t('leaderboard.error')} c={c} />
      </Shell>
    );
  }

  if (activeBoard === 'mine') {
    return (
      <Shell c={c} title={t('leaderboard.title')} activeBoard={activeBoard} onChangeBoard={setActiveBoard}>
        <AchievementsView locale={locale} scheme={scheme} />
      </Shell>
    );
  }

  // From here on activeBoard is 'municipio' or 'local', and the three gates
  // above already guarantee district/data are ready for that case — but
  // they're compound conditions (`activeBoard !== 'mine' && …`), which
  // TypeScript can't narrow across. This makes the same guarantee explicit
  // so `district`/`data` type as non-null below instead of needing `!`.
  if (district === null || data === null || data.failed) return null;

  return (
    <Shell c={c} title={t('leaderboard.title')} activeBoard={activeBoard} onChangeBoard={setActiveBoard}>
      <ScrollView
        contentContainerStyle={styles.scroll}
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

        {activeBoard === 'municipio' && (
        <>
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
        </>
        )}

        {/* BOARD 2 */}
        {activeBoard === 'local' && (
        <Section
          title={t('leaderboard.leadersTitle', { days: MAYORSHIP_WINDOW_DAYS })}
          note={t('leaderboard.leadersNote')}
          c={c}>
          {leaders && leaders.length > 0 ? (
            leaders.map((entry, i) => (
              <BoardRow
                key={entry.userId}
                rank={i + 1}
                name={entry.displayName ?? t('leaderboard.anonymous')}
                score={String(entry.cellsHeld)}
                detail={t('leaderboard.bestDays', { count: entry.bestDays })}
                tint={tintOf(entry.userId)}
                isMe={entry.userId === data?.meUserId}
                c={c}
              />
            ))
          ) : (
            <Text style={[styles.note, { color: c.textSecondary }]}>
              {t('leaderboard.leadersEmpty', { days: MAYORSHIP_WINDOW_DAYS })}
            </Text>
          )}
        </Section>
        )}
      </ScrollView>
    </Shell>
  );
}

function Shell({
  c,
  title,
  activeBoard,
  onChangeBoard,
  children,
}: {
  c: Record<ThemeColor, string>;
  title: string;
  activeBoard: 'mine' | 'municipio' | 'local';
  onChangeBoard: (b: 'mine' | 'municipio' | 'local') => void;
  children: React.ReactNode;
}) {
  const { t } = useI18n();
  return (
    <View style={styles.root}>
    <SafeAreaView style={{ flex: 1, backgroundColor: c.background }} edges={['top']}>
      <Text style={[styles.title, { color: c.text }]}>{title}</Text>
      <BoardTabs active={activeBoard} onChange={onChangeBoard} c={c} t={t} />
      {children}
    </SafeAreaView>
    <ProfilePill />
    </View>
  );
}

/** The three sub-tabs (2026-09-17 nav restructure): My Achievements,
 *  Municipio and Local Leaders, one screen. Plain segmented row, not a
 *  floating glass capsule — unlike the old Saved tab's map-overlay switch,
 *  every one of these three bodies is (or starts as) a ScrollView with its
 *  own solid background, so the switch can sit in normal flow. */
function BoardTabs({
  active,
  onChange,
  c,
  t,
}: {
  active: 'mine' | 'municipio' | 'local';
  onChange: (b: 'mine' | 'municipio' | 'local') => void;
  c: Record<ThemeColor, string>;
  t: ReturnType<typeof useI18n>['t'];
}) {
  const tabs: { key: 'mine' | 'municipio' | 'local'; label: string }[] = [
    { key: 'mine', label: t('leaderboard.tabMine') },
    { key: 'municipio', label: t('leaderboard.tabMunicipio') },
    { key: 'local', label: t('leaderboard.tabLocal') },
  ];
  return (
    <View style={styles.tabsRow}>
      {tabs.map((tab) => {
        const selected = active === tab.key;
        return (
          <Pressable
            key={tab.key}
            onPress={() => onChange(tab.key)}
            accessibilityRole="button"
            accessibilityState={{ selected }}
            style={styles.tabItem}>
            <Text
              numberOfLines={1}
              style={[
                styles.tabLabel,
                { color: selected ? c.text : c.textSecondary },
                selected && { borderBottomColor: c.accent, borderBottomWidth: 2 },
              ]}>
              {tab.label}
            </Text>
          </Pressable>
        );
      })}
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
  title: {
    fontSize: 28,
    fontWeight: '700',
    paddingHorizontal: Spacing.three,
    paddingTop: Spacing.two,
  },
  tabsRow: {
    flexDirection: 'row',
    paddingHorizontal: Spacing.three,
    paddingTop: Spacing.two,
    gap: Spacing.four,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(128,128,128,0.25)',
  },
  tabItem: { paddingBottom: Spacing.two },
  tabLabel: { fontSize: 15, fontWeight: '700', paddingBottom: 2 },
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

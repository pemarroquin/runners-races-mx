// The Saved tab — two collections behind one segmented switch: the races
// you've bookmarked, and the territories (fences) you've captured in
// Territory Mode. Pedro's call (2026-08-27): past fences live HERE, not on
// the live Track map — a run-history surface, not run-time chrome.
import { useIsFocused, useRouter } from 'expo-router';
import { Image } from 'expo-image';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  ScrollView,
  SectionList,
  StyleSheet,
  Text,
  View,
  useColorScheme,
} from 'react-native';
import Animated, { FadeIn, FadeInDown } from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';

import { RaceCard } from '@/components/race-card';
import { Icon } from '@/components/ui/icon';
import { fenceColorForRun } from '@/constants/map';
import { BottomTabInset, Colors, Spacing } from '@/constants/theme';
import { useI18n } from '@/lib/i18n';
import { buildFenceMapUrl, FENCE_MAP_ASPECT } from '@/lib/mapbox';
import { daysUntil, type Race } from '@/lib/races';
import { useRaces } from '@/lib/races-provider';
import { useSaved } from '@/lib/saved';
import { fetchMyFences, type FencesOutcome, type MyFence } from '@/lib/territory-sync';
import { useToday } from '@/lib/today';
import { formatArea, formatDistance } from '@/lib/tracking';

interface RaceSection {
  key: 'upcoming' | 'past';
  title: string;
  data: Race[];
}

type SavedView = 'races' | 'fences';

export default function MyRacesScreen() {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const c = Colors[scheme];
  const router = useRouter();
  const { t, locale } = useI18n();
  const { savedIds, dropMissing, storageError } = useSaved();
  const allRaces = useRaces();
  const today = useToday();

  const [view, setView] = useState<SavedView>('races');
  const isFocused = useIsFocused();

  const races = useMemo(
    () => allRaces.filter((r) => savedIds.has(r.id)),
    [savedIds, allRaces],
  );

  // Saved ids the catalog no longer contains. Counted rather than inferred
  // from `races.length` alone so the message stays right if a race is ever
  // saved twice under different ids.
  const missingCount = useMemo(() => {
    const present = new Set(races.map((r) => r.id));
    return Array.from(savedIds).filter((id) => !present.has(id)).length;
  }, [savedIds, races]);

  const clearMissing = useCallback(
    () => dropMissing(new Set(allRaces.map((r) => r.id))),
    [dropMissing, allRaces],
  );

  // Undated races (daysUntil === null) are treated as upcoming — there's no
  // date to have passed. Only a strictly-past date moves a race to "Past".
  const sections = useMemo<RaceSection[]>(() => {
    const upcoming: Race[] = [];
    const past: Race[] = [];
    for (const r of races) {
      const days = daysUntil(r.date, today);
      if (days !== null && days < 0) past.push(r);
      else upcoming.push(r);
    }
    // Upcoming reads soonest-first (inherited from the source sort, which is
    // ascending by date). Past has to be reversed: the same ascending order
    // buries the race you just ran at the bottom under everything older.
    past.reverse();
    const result: RaceSection[] = [];
    if (upcoming.length > 0) {
      result.push({ key: 'upcoming', title: t('myraces.upcomingSection'), data: upcoming });
    }
    if (past.length > 0) {
      result.push({ key: 'past', title: t('myraces.pastSection'), data: past });
    }
    return result;
    // `today` — daysUntil() reads the current date, so without it a race that
    // finished overnight stays under "Próximas" until something else changes.
  }, [races, t, today]);

  // Fences load lazily — fetched (or refetched) each time the Territories
  // view is opened OR the tab regains focus, so a run saved on the Track
  // tab shows up without the runner having to toggle the segment (reported
  // bug: "I have to switch from Races to Territories to trigger the
  // update"). Kept as the raw outcome so the three non-data states
  // (loading / disabled / failed) each render as themselves, never as a
  // fake "no territory yet" — same `isFocused` gate index.tsx's queue-drain
  // effect uses, not a new abstraction.
  const [fences, setFences] = useState<FencesOutcome | null>(null);
  useEffect(() => {
    if (view !== 'fences' || !isFocused) return;
    let stale = false;
    // Deferred by a tick so no setState runs synchronously in the effect
    // body (React Compiler rule — same pattern as the run tracker's clock).
    const id = setTimeout(() => {
      setFences(null);
      fetchMyFences().then((outcome) => {
        if (!stale) setFences(outcome);
      });
    }, 0);
    return () => {
      stale = true;
      clearTimeout(id);
    };
  }, [view, isFocused]);

  // Pull-to-refresh — same refreshing-boolean pattern as leaderboard.tsx's
  // onRefresh, kept separate from the `fences === null` loading state above
  // so a manual pull shows the RefreshControl spinner rather than replacing
  // the whole list with the full-screen ActivityIndicator.
  const [fencesRefreshing, setFencesRefreshing] = useState(false);
  const onRefreshFences = useCallback(async () => {
    setFencesRefreshing(true);
    const outcome = await fetchMyFences();
    setFences(outcome);
    setFencesRefreshing(false);
  }, []);

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: c.background }]} edges={['top']}>
      <Text style={[styles.title, { color: c.text }]}>{t('myraces.title')}</Text>

      <View style={styles.segmentRow}>
        {(['races', 'fences'] as const).map((key) => {
          const selected = view === key;
          return (
            <Pressable
              key={key}
              onPress={() => setView(key)}
              accessibilityRole="button"
              accessibilityState={{ selected }}
              style={[
                styles.segment,
                { backgroundColor: selected ? c.accent : c.backgroundElement },
              ]}>
              <Text
                style={[styles.segmentLabel, { color: selected ? '#ffffff' : c.textSecondary }]}>
                {t(key === 'races' ? 'myraces.tabRaces' : 'myraces.tabFences')}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {view === 'races' ? (
        <SectionList
          sections={sections}
          keyExtractor={(r) => r.id}
          contentContainerStyle={styles.list}
          stickySectionHeadersEnabled={false}
          ListHeaderComponent={
            // Both of these were tracked in state and rendered nowhere: a
            // browser that blocks storage made every save silently fail, and a
            // race dropped from the catalog just disappeared from this list.
            storageError !== null || missingCount > 0 ? (
              <View style={styles.notices}>
                {storageError !== null && (
                  <View style={[styles.notice, { backgroundColor: c.backgroundElement }]}>
                    <Text style={[styles.noticeText, { color: c.textSecondary }]}>
                      {t('myraces.storageBlocked')}
                    </Text>
                  </View>
                )}
                {missingCount > 0 && (
                  <View style={[styles.notice, { backgroundColor: c.backgroundElement }]}>
                    <Text style={[styles.noticeText, { color: c.textSecondary }]}>
                      {t('myraces.missing', { count: missingCount })}
                    </Text>
                    <Pressable onPress={clearMissing} accessibilityRole="button" hitSlop={10}>
                      <Text style={[styles.noticeAction, { color: c.accent }]}>
                        {t('myraces.clearMissing')}
                      </Text>
                    </Pressable>
                  </View>
                )}
              </View>
            ) : null
          }
          renderSectionHeader={({ section }) => (
            <Text style={[styles.sectionTitle, { color: c.textSecondary }]}>{section.title}</Text>
          )}
          renderItem={({ item, index }) => (
            <Animated.View
              entering={FadeInDown.duration(320).delay(Math.min(index, 8) * 45)}>
              <RaceCard
                race={item}
                onPress={() => router.push({ pathname: '/race/[id]', params: { id: item.id } })}
              />
            </Animated.View>
          )}
          ListEmptyComponent={
            <Animated.View entering={FadeIn.duration(400)} style={styles.emptyWrap}>
              <Text style={[styles.empty, { color: c.textSecondary }]}>{t('myraces.empty')}</Text>
            </Animated.View>
          }
        />
      ) : (
        <FencesView
          fences={fences}
          locale={locale}
          scheme={scheme}
          refreshing={fencesRefreshing}
          onRefresh={onRefreshFences}
        />
      )}
    </SafeAreaView>
  );
}

function FencesView({
  fences,
  locale,
  scheme,
  refreshing,
  onRefresh,
}: {
  fences: FencesOutcome | null;
  locale: string;
  scheme: 'dark' | 'light';
  refreshing: boolean;
  onRefresh: () => void;
}) {
  const c = Colors[scheme];
  const { t } = useI18n();

  // Loading and disabled/failed stay their own distinct states — a failure
  // must never quietly render as the empty "no territory yet" copy below.
  // Neither one grows a RefreshControl of its own here, same as
  // leaderboard.tsx's Empty/loading states: pull-to-refresh lives on the
  // data list, matched to that existing pattern rather than inventing a
  // third one.
  if (fences === null) {
    return (
      <View style={styles.emptyWrap}>
        <ActivityIndicator color={c.textSecondary} />
      </View>
    );
  }

  if (!fences.ok) {
    // Pull-to-refresh here too — 'disabled' has nothing a refresh would
    // change, but a transient 'failed' (one dropped request) previously
    // left the runner stuck on this screen with no way back to the list
    // short of switching the segment away and back. A ScrollView (not
    // FlatList — there's no list, just this one message) gets the same
    // RefreshControl the data view uses below.
    return (
      <ScrollView
        contentContainerStyle={[styles.emptyWrap, styles.emptyWrapGrow]}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={c.textSecondary} />
        }>
        <Animated.View entering={FadeIn.duration(400)}>
          <Text style={[styles.empty, { color: c.textSecondary }]}>
            {fences.reason === 'disabled'
              ? t('myraces.fencesDisabled')
              : t('myraces.fencesError')}
          </Text>
        </Animated.View>
      </ScrollView>
    );
  }

  return (
    <FlatList
      data={fences.fences}
      keyExtractor={(f) => f.id}
      contentContainerStyle={styles.list}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={c.textSecondary} />
      }
      renderItem={({ item, index }) => (
        <Animated.View entering={FadeInDown.duration(320).delay(Math.min(index, 8) * 45)}>
          <FenceCard fence={item} locale={locale} scheme={scheme} />
        </Animated.View>
      )}
      ListEmptyComponent={
        <Animated.View entering={FadeIn.duration(400)} style={styles.emptyWrap}>
          <Text style={[styles.empty, { color: c.textSecondary }]}>
            {t('myraces.fencesEmpty')}
          </Text>
        </Animated.View>
      }
    />
  );
}

function FenceCard({
  fence,
  locale,
  scheme,
}: {
  fence: MyFence;
  locale: string;
  scheme: 'dark' | 'light';
}) {
  const c = Colors[scheme];
  const { t } = useI18n();
  const color = fenceColorForRun(fence.startedAtMs).color;
  // Null once the run has been fully taken — there is no shape left to draw,
  // but the card stays as history.
  const mapUrl = fence.geometry
    ? buildFenceMapUrl(fence.geometry, scheme === 'dark', color, fence.route ?? undefined)
    : null;
  const fullyTaken = fence.geometry === null;
  const date = new Date(fence.startedAtMs).toLocaleDateString(
    locale === 'es' ? 'es-MX' : 'en-US',
    { day: 'numeric', month: 'short', year: 'numeric' },
  );

  return (
    <View style={[styles.fenceCard, { backgroundColor: c.backgroundElement }]}>
      {mapUrl && (
        <View style={styles.fenceImgWrap}>
          <Image
            source={{ uri: mapUrl }}
            style={styles.fenceImg}
            contentFit="cover"
            accessibilityLabel={t('myraces.tabFences')}
          />
        </View>
      )}
      <View style={styles.fenceMeta}>
        <View style={[styles.fenceDot, { backgroundColor: color }]} />
        <Text style={[styles.fenceDate, { color: c.text }]}>{date}</Text>
        <Text style={[styles.fenceStats, { color: c.textSecondary }]}>
          {formatArea(fence.areaM2)}  ·  {formatDistance(fence.distanceM)}
        </Text>
      </View>

      {/* Speed-flagged by the server. Shown on the runner's own card too,
          not just to others — if a run looks implausible, the person who
          ran it should be the first to know. */}
      {fence.flagged && (
        <View style={[styles.fenceLost, { borderTopColor: c.backgroundSelected }]}>
          <Icon ios="exclamationmark.triangle.fill" android="warning" size={12} color={c.accent} />
          <Text style={[styles.fenceLostText, { color: c.accent }]}>
            {t('myraces.fenceFlagged')}
          </Text>
        </View>
      )}

      {/* Phase 3: this run lost ground to someone else. Shown on the card
          rather than only in a notification, so the history stays true even
          if the runner never saw the alert. */}
      {fence.lostM2 > 0 && (
        <View style={[styles.fenceLost, { borderTopColor: c.backgroundSelected }]}>
          <Icon ios="flag.slash" android="flag" size={12} color={c.accent} />
          <Text style={[styles.fenceLostText, { color: c.accent }]}>
            {fullyTaken
              ? t('myraces.fenceFullyTaken')
              : t('myraces.fenceLost', { area: formatArea(fence.lostM2) })}
          </Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  title: {
    fontSize: 28,
    fontWeight: '700',
    paddingHorizontal: Spacing.three,
    paddingTop: Spacing.two,
  },
  segmentRow: {
    flexDirection: 'row',
    gap: Spacing.one,
    paddingHorizontal: Spacing.three,
    paddingTop: Spacing.two,
  },
  segment: {
    paddingVertical: Spacing.one,
    paddingHorizontal: Spacing.three,
    borderRadius: 999,
  },
  segmentLabel: { fontSize: 14, fontWeight: '700' },
  list: { padding: Spacing.three, gap: Spacing.two, flexGrow: 1, paddingBottom: BottomTabInset },
  sectionTitle: {
    fontSize: 13,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: Spacing.two,
  },
  emptyWrap: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingTop: Spacing.six },
  // ScrollView's contentContainerStyle sizes to its content by default —
  // flexGrow (not flex) is what makes short content still fill the
  // viewport, so the pull-to-refresh gesture has room to work from
  // anywhere on screen rather than just the text's own bounds.
  emptyWrapGrow: { flexGrow: 1 },
  empty: { textAlign: 'center', fontSize: 15, lineHeight: 22 },
  notices: { gap: Spacing.two, marginBottom: Spacing.two },
  notice: { borderRadius: Spacing.two, padding: Spacing.three, gap: Spacing.one },
  noticeText: { fontSize: 13, lineHeight: 19 },
  noticeAction: { fontSize: 13, fontWeight: '700' },

  fenceCard: { borderRadius: Spacing.two, overflow: 'hidden' },
  fenceImgWrap: { aspectRatio: FENCE_MAP_ASPECT },
  fenceImg: { width: '100%', height: '100%' },
  fenceMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    padding: Spacing.three,
  },
  fenceDot: { width: 10, height: 10, borderRadius: 5 },
  fenceDate: { fontSize: 15, fontWeight: '700' },
  fenceStats: { fontSize: 13, fontWeight: '600', marginLeft: 'auto' },
  fenceLost: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one,
    paddingHorizontal: Spacing.three,
    paddingBottom: Spacing.three,
    paddingTop: Spacing.two,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  fenceLostText: { fontSize: 13, fontWeight: '600', flex: 1 },
});

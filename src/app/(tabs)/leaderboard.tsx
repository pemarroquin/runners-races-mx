// Phase 2 — the territory leaderboard. Ranks runners by area actually held
// (overlapping runs by one person counted once — see leaderboard.ts), with a
// per-metro board and a global one behind a segment.
//
// Regional is the DEFAULT because everything else in this app is
// region-scoped already (the Feed filters by metro, there's a city picker in
// the header): a national board would rank a Monterrey runner against a
// Tijuana one over ground neither can contest. Global is one tap away for
// when the question is "who's biggest anywhere".
import { useIsFocused } from 'expo-router';
import type { AndroidSymbol, SFSymbol } from 'expo-symbols';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
  useColorScheme,
} from 'react-native';
import Animated, { FadeIn, FadeInDown } from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Icon } from '@/components/ui/icon';
import { fenceColorForRun } from '@/constants/map';
import { BottomTabInset, Colors, Spacing } from '@/constants/theme';
import { useI18n } from '@/lib/i18n';
import { rankByArea, type LeaderboardEntry } from '@/lib/leaderboard';
import { useRegion } from '@/lib/region-context';
import { fetchLeaderboard, type LeaderboardOutcome } from '@/lib/territory-sync';
import { formatArea } from '@/lib/tracking';

type Scope = 'region' | 'global';

export default function LeaderboardScreen() {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const c = Colors[scheme];
  const { t } = useI18n();
  const { region } = useRegion();
  const isFocused = useIsFocused();

  const [scope, setScope] = useState<Scope>('region');
  const [data, setData] = useState<LeaderboardOutcome | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    const outcome = await fetchLeaderboard();
    setData(outcome);
  }, []);

  // Refetches on every focus, not just first mount. expo-router tab screens
  // stay mounted rather than remounting per visit, so the old `[]`-deps
  // effect fetched once, early in the session, and never again short of a
  // manual pull-to-refresh. Confirmed live: a user set a new leaderboard
  // display name and saved two real runs — Supabase already had the fresh
  // data server-side (right region, right profile join, right flagged
  // state) while this screen kept showing stale data from the old identity.
  // Deferred by a tick with a `stale` flag on cleanup — same pattern as
  // myraces.tsx's Territories fetch effect.
  useEffect(() => {
    if (!isFocused) return;
    let stale = false;
    const id = setTimeout(() => {
      fetchLeaderboard().then((outcome) => {
        if (!stale) setData(outcome);
      });
    }, 0);
    return () => {
      stale = true;
      clearTimeout(id);
    };
  }, [isFocused]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  // Ranking is recomputed rather than refetched when the scope changes: the
  // union runs over data already in memory, so the toggle is instant.
  const entries = useMemo<LeaderboardEntry[]>(() => {
    if (!data?.ok) return [];
    return rankByArea(data.runs, scope === 'region' ? region.id : null);
  }, [data, scope, region.id]);

  const meUserId = data?.ok ? data.meUserId : null;

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: c.background }]} edges={['top']}>
      <Text style={[styles.title, { color: c.text }]}>{t('leaderboard.title')}</Text>

      <View style={styles.segmentRow}>
        {(['region', 'global'] as const).map((key) => {
          const selected = scope === key;
          return (
            <Pressable
              key={key}
              onPress={() => setScope(key)}
              accessibilityRole="button"
              accessibilityState={{ selected }}
              aria-checked={selected}
              style={[
                styles.segment,
                { backgroundColor: selected ? c.accent : c.backgroundElement },
              ]}>
              <Text
                style={[styles.segmentLabel, { color: selected ? '#ffffff' : c.textSecondary }]}>
                {key === 'region' ? region.name : t('leaderboard.global')}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {data === null ? (
        <View style={styles.centre}>
          <ActivityIndicator color={c.textSecondary} />
        </View>
      ) : !data.ok ? (
        <Empty
          icon="exclamationmark.triangle"
          android="warning"
          text={
            data.reason === 'disabled'
              ? t('leaderboard.disabled')
              : t('leaderboard.error')
          }
          c={c}
        />
      ) : (
        <FlatList
          data={entries}
          keyExtractor={(e) => e.userId}
          contentContainerStyle={styles.list}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={c.textSecondary}
            />
          }
          renderItem={({ item, index }) => (
            <Animated.View entering={FadeInDown.duration(320).delay(Math.min(index, 8) * 45)}>
              <Row
                entry={item}
                rank={index + 1}
                isMe={item.userId === meUserId}
                c={c}
                anonymous={t('leaderboard.anonymous')}
                runsLabel={t('leaderboard.runs', { count: item.runCount })}
                flaggedLabel={t('leaderboard.flagged', { count: item.flaggedCount })}
              />
            </Animated.View>
          )}
          ListEmptyComponent={
            <Empty
              icon="trophy"
              android="trophy"
              text={
                scope === 'region'
                  ? t('leaderboard.emptyRegion', { city: region.name })
                  : t('leaderboard.empty')
              }
              c={c}
            />
          }
        />
      )}
    </SafeAreaView>
  );
}

function Row({
  entry,
  rank,
  isMe,
  c,
  anonymous,
  runsLabel,
  flaggedLabel,
}: {
  entry: LeaderboardEntry;
  rank: number;
  isMe: boolean;
  c: Record<string, string>;
  anonymous: string;
  runsLabel: string;
  flaggedLabel: string;
}) {
  // Colour-coded by the same palette the fences use, keyed on the user id so
  // a runner reads as one colour down the whole board. Not their fence
  // colour (that's per-run, by design) — a per-person accent.
  const tint = fenceColorForRun(hashToSeed(entry.userId)).color;

  return (
    <View
      style={[
        styles.row,
        { backgroundColor: isMe ? c.backgroundSelected : c.backgroundElement },
      ]}>
      <Text style={[styles.rank, { color: c.textSecondary }]}>{rank}</Text>
      <View style={[styles.dot, { backgroundColor: tint }]} />
      <View style={styles.nameWrap}>
        <Text style={[styles.name, { color: c.text }]} numberOfLines={1}>
          {entry.displayName ?? anonymous}
        </Text>
        <View style={styles.runsRow}>
          <Text style={[styles.runs, { color: c.textSecondary }]}>{runsLabel}</Text>
          {/* Flagged runs still count toward this score — the board says so
              rather than quietly excluding them. */}
          {entry.flaggedCount > 0 && (
            <>
              <Icon ios="exclamationmark.triangle.fill" android="warning" size={10} color={c.accent} />
              <Text style={[styles.runs, { color: c.accent }]}>{flaggedLabel}</Text>
            </>
          )}
        </View>
      </View>
      <Text style={[styles.area, { color: c.text }]}>{formatArea(entry.areaM2)}</Text>
    </View>
  );
}

function Empty({
  icon,
  android,
  text,
  c,
}: {
  icon: SFSymbol;
  android: AndroidSymbol;
  text: string;
  c: Record<string, string>;
}) {
  return (
    <Animated.View entering={FadeIn.duration(400)} style={styles.centre}>
      <View style={[styles.iconWrap, { backgroundColor: c.backgroundElement }]}>
        <Icon ios={icon} android={android} size={28} color={c.textSecondary} />
      </View>
      <Text style={[styles.emptyText, { color: c.textSecondary }]}>{text}</Text>
    </Animated.View>
  );
}

/** A stable number from a uuid, so a user's accent colour never changes. */
function hashToSeed(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  // fenceColorForRun divides by 1000 (it takes epoch ms), so scale up to
  // keep every bucket reachable.
  return Math.abs(h) * 1000;
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
  centre: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.three,
    paddingHorizontal: Spacing.five,
    paddingBottom: BottomTabInset,
  },
  iconWrap: {
    width: 64,
    height: 64,
    borderRadius: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyText: { fontSize: 15, lineHeight: 22, textAlign: 'center' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    padding: Spacing.three,
    borderRadius: Spacing.two,
  },
  rank: { fontSize: 15, fontWeight: '700', minWidth: 22, fontVariant: ['tabular-nums'] },
  dot: { width: 10, height: 10, borderRadius: 5 },
  nameWrap: { flex: 1, gap: 2 },
  name: { fontSize: 16, fontWeight: '700' },
  runs: { fontSize: 12, fontWeight: '600' },
  runsRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  area: { fontSize: 15, fontWeight: '700', fontVariant: ['tabular-nums'] },
});

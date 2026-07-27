import { useRouter } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import {
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  useColorScheme,
} from 'react-native';
import Animated, { FadeInDown } from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';

import { CityPicker } from '@/components/city-picker';
import { FilterSheet } from '@/components/filter-sheet';
import { RaceCard } from '@/components/race-card';
import { GlassSurface } from '@/components/ui/glass-surface';
import { Icon } from '@/components/ui/icon';
import { GlassRadii } from '@/constants/glass';
import { BottomTabInset, Colors, Spacing } from '@/constants/theme';
import { useI18n } from '@/lib/i18n';
import {
  daysUntil,
  distanceTagLabelKey,
  getAvailableMonths,
  getRaces,
  monthKey,
  type DistanceTag,
} from '@/lib/races';
import { useRacesVersion } from '@/lib/races-provider';
import { useRegion } from '@/lib/region-context';
import { raceInRegion } from '@/lib/regions';

function toggleInSet<T>(set: Set<T>, value: T): Set<T> {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

export default function FeedScreen() {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const c = Colors[scheme];
  const router = useRouter();
  const { t, locale, setLocale } = useI18n();

  const [query, setQuery] = useState('');
  const [distances, setDistances] = useState<Set<DistanceTag>>(new Set());
  const [months, setMonths] = useState<Set<string>>(new Set());
  const [pickerOpen, setPickerOpen] = useState(false);
  const [filterSheetOpen, setFilterSheetOpen] = useState(false);
  const racesVersion = useRacesVersion();
  const { region, method } = useRegion();
  const locationInUse = method === 'gps' || method === 'ip';

  const races = useMemo(() => {
    const q = query.trim().toLowerCase();
    return getRaces().filter((r) => {
      if (!raceInRegion(r, region)) return false;
      const days = daysUntil(r.date);
      if (!(r.date === null || (days !== null && days >= 0))) return false;
      const matchesQuery =
        !q || r.name.toLowerCase().includes(q) || r.city.toLowerCase().includes(q);
      const matchesDistance = distances.size === 0 || r.distanceTags.some((t) => distances.has(t));
      const matchesMonth = months.size === 0 || months.has(monthKey(r.date));
      return matchesQuery && matchesDistance && matchesMonth;
    });
  }, [query, distances, months, racesVersion, region]);

  // Distinguish "region has no data at all" from "filters matched nothing".
  const regionHasData = useMemo(
    () => getRaces().some((r) => raceInRegion(r, region)),
    [racesVersion, region],
  );

  const availableMonths = useMemo(
    () => getAvailableMonths(getRaces().filter((r) => raceInRegion(r, region)), locale),
    [racesVersion, region, locale],
  );

  const toggleDistance = useCallback(
    (tag: DistanceTag) => setDistances((prev) => toggleInSet(prev, tag)),
    [],
  );
  const toggleMonth = useCallback(
    (key: string) => setMonths((prev) => toggleInSet(prev, key)),
    [],
  );
  const clearFilters = useCallback(() => {
    setDistances(new Set());
    setMonths(new Set());
  }, []);
  const clearAll = useCallback(() => {
    setQuery('');
    clearFilters();
  }, [clearFilters]);

  const activeFilterCount = distances.size + months.size;
  const hasActiveFilters = Boolean(query) || activeFilterCount > 0;

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: c.background }]} edges={['top']}>
      <View
        style={[
          styles.header,
          { backgroundColor: c.background, borderBottomColor: c.backgroundSelected },
        ]}>
      <View style={styles.headerRow}>
        <View>
          <Text style={[styles.title, { color: c.text }]}>{t('feed.title')}</Text>
          <Pressable
            onPress={() => setPickerOpen(true)}
            hitSlop={6}
            style={styles.subtitleRow}
            accessibilityLabel={
              locationInUse ? `${region.name} — ${t('city.locationOn')}` : region.name
            }>
            {locationInUse && <Icon ios="location.fill" android="my_location" size={12} color={c.accent} />}
            <Text style={[styles.subtitle, { color: c.textSecondary }]}>{region.name}</Text>
            <Icon ios="chevron.down" android="expand_more" size={12} weight="bold" color={c.textSecondary} />
          </Pressable>
        </View>
        {/* Real segmented control (iOS 27 "Tabs Mode Compact" language): one
            glass track, active segment gets a solid filled pill inside it. */}
        <GlassSurface scheme={scheme} radius={GlassRadii.pill} contentStyle={styles.segmentTrack}>
          {(['es', 'en'] as const).map((l) => (
            <Pressable
              key={l}
              onPress={() => setLocale(l)}
              style={[styles.segment, locale === l && { backgroundColor: c.text }]}>
              <Text
                style={[styles.langText, { color: locale === l ? c.background : c.textSecondary }]}>
                {l.toUpperCase()}
              </Text>
            </Pressable>
          ))}
        </GlassSurface>
      </View>

      <View style={styles.searchRow}>
        <GlassSurface scheme={scheme} radius={GlassRadii.pill} style={styles.searchGlass} contentStyle={styles.searchContent}>
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder={t('feed.search')}
            placeholderTextColor={c.textSecondary}
            style={[styles.search, { color: c.text }]}
          />
        </GlassSurface>
        <Pressable onPress={() => setFilterSheetOpen(true)}>
          {({ pressed }) => (
            <GlassSurface
              scheme={scheme}
              radius={GlassRadii.pill}
              style={pressed && styles.pressed}
              contentStyle={styles.filterContent}>
              <Text style={[styles.filterBtnText, { color: c.text }]}>{t('filters.title')}</Text>
              {activeFilterCount > 0 && (
                <View style={[styles.badge, { backgroundColor: c.accent }]}>
                  <Text style={styles.badgeText}>{activeFilterCount}</Text>
                </View>
              )}
            </GlassSurface>
          )}
        </Pressable>
      </View>

      {hasActiveFilters && (
        <View style={styles.filterRow}>
          {query.length > 0 && (
            <Pressable onPress={() => setQuery('')}>
              <GlassSurface scheme={scheme} radius={GlassRadii.chip} noShadow contentStyle={styles.chipContent}>
                <Text style={[styles.chipText, { color: c.text }]}>{query}</Text>
                <Icon ios="xmark" android="close" size={11} weight="bold" color={c.text} />
              </GlassSurface>
            </Pressable>
          )}
          {Array.from(distances).map((tag) => (
            <Pressable key={tag} onPress={() => toggleDistance(tag)}>
              <GlassSurface scheme={scheme} radius={GlassRadii.chip} noShadow contentStyle={styles.chipContent}>
                <Text style={[styles.chipText, { color: c.text }]}>
                  {t(distanceTagLabelKey(tag))}
                </Text>
                <Icon ios="xmark" android="close" size={11} weight="bold" color={c.text} />
              </GlassSurface>
            </Pressable>
          ))}
          {Array.from(months).map((key) => {
            const m = availableMonths.find((am) => am.key === key);
            const label = key === 'tbd' ? t('common.tbd') : (m?.label ?? key);
            return (
              <Pressable key={key} onPress={() => toggleMonth(key)}>
                <GlassSurface scheme={scheme} radius={GlassRadii.chip} noShadow contentStyle={styles.chipContent}>
                  <Text style={[styles.chipText, { color: c.text }]}>{label}</Text>
                  <Icon ios="xmark" android="close" size={11} weight="bold" color={c.text} />
                </GlassSurface>
              </Pressable>
            );
          })}
          <Pressable onPress={clearAll} hitSlop={6}>
            <Text style={[styles.clearAllText, { color: c.accent }]}>{t('filters.clearAll')}</Text>
          </Pressable>
        </View>
      )}
      </View>

      <FlatList
        data={races}
        keyExtractor={(r) => r.id}
        contentContainerStyle={styles.list}
        keyboardShouldPersistTaps="handled"
        renderItem={({ item, index }) => (
          // Staggered reveal, capped at the first 8 rows so rows mounted while
          // scrolling (or while typing in search) get a quick plain fade
          // instead of an ever-growing delay queue.
          <Animated.View
            entering={FadeInDown.duration(320).delay(Math.min(index, 8) * 45)}>
            <RaceCard
              race={item}
              onPress={() => router.push({ pathname: '/race/[id]', params: { id: item.id } })}
            />
          </Animated.View>
        )}
        ListEmptyComponent={
          <Text style={[styles.empty, { color: c.textSecondary }]}>
            {regionHasData ? t('feed.empty') : t('city.emptyRegion', { city: region.name })}
          </Text>
        }
      />

      <CityPicker visible={pickerOpen} onClose={() => setPickerOpen(false)} />
      <FilterSheet
        visible={filterSheetOpen}
        onClose={() => setFilterSheetOpen(false)}
        distances={distances}
        onToggleDistance={toggleDistance}
        months={months}
        onToggleMonth={toggleMonth}
        availableMonths={availableMonths}
        onClear={clearFilters}
        resultCount={races.length}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  // Solid, elevated header so list content never bleeds through while scrolling.
  header: {
    zIndex: 1,
    paddingBottom: Spacing.two,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    paddingHorizontal: Spacing.three,
    paddingTop: Spacing.two,
  },
  title: { fontSize: 28, fontWeight: '700' },
  subtitleRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 },
  subtitle: { fontSize: 14 },
  segmentTrack: { flexDirection: 'row', padding: 3, gap: 2 },
  segment: {
    borderRadius: GlassRadii.pill,
    paddingHorizontal: Spacing.two,
    paddingVertical: 5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  langText: { fontSize: 12, fontWeight: '700' },
  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    marginHorizontal: Spacing.three,
    marginTop: Spacing.three,
  },
  searchGlass: { flex: 1 },
  searchContent: { paddingHorizontal: Spacing.three },
  search: {
    paddingVertical: Spacing.two,
    fontSize: 15,
  },
  filterContent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
  },
  filterBtnText: { fontSize: 14, fontWeight: '600' },
  badge: {
    minWidth: 18,
    height: 18,
    borderRadius: 9,
    paddingHorizontal: 4,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: { color: '#ffffff', fontSize: 11, fontWeight: '700' },
  filterRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: Spacing.one,
    paddingHorizontal: Spacing.three,
    paddingTop: Spacing.two,
  },
  chipContent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.one,
  },
  chipText: { fontSize: 13, fontWeight: '600' },
  pressed: { opacity: 0.7, transform: [{ scale: 0.97 }] },
  clearAllText: { fontSize: 13, fontWeight: '600' },
  list: { padding: Spacing.three, gap: Spacing.two, paddingBottom: BottomTabInset },
  empty: { textAlign: 'center', marginTop: Spacing.six, fontSize: 15 },
});

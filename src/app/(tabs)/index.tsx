import { useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  FlatList,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  useColorScheme,
} from 'react-native';
import Animated, { FadeInDown } from 'react-native-reanimated';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { CityPicker } from '@/components/city-picker';
import { FilterPopover, type FilterFacet } from '@/components/filter-popover';
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
  monthKey,
  type DistanceTag,
  type Race,
} from '@/lib/races';
import { useRaces, useRacesStatus } from '@/lib/races-provider';
import { pickRegionArt } from '@/lib/region-art';
import { useRegion } from '@/lib/region-context';
import { raceInRegion } from '@/lib/regions';

// Feed layout row: a periodic full-width "hero" card with a larger image,
// or a 2-up "grid" row of compact cards — instead of every race rendering
// as an identical text-only row. Cadence: the first race is a hero, then
// races chunk into grid pairs, and every 5th grid-pair row promotes the
// next race back to hero (roughly one hero per 10 items) so a long scroll
// doesn't read as "one special card forever." Sort order is untouched —
// this only decides which *position* in the existing order gets the hero
// treatment.
type LayoutRow = { type: 'hero'; race: Race } | { type: 'grid'; races: Race[] };
const GRID_ROWS_PER_HERO = 5;

function buildLayoutRows(races: Race[]): LayoutRow[] {
  const rows: LayoutRow[] = [];
  let i = 0;
  let expectHero = true;
  let gridRowsSinceHero = 0;
  while (i < races.length) {
    if (expectHero) {
      rows.push({ type: 'hero', race: races[i] });
      i += 1;
      expectHero = false;
      gridRowsSinceHero = 0;
      continue;
    }
    // Trailing odd race gets its own one-item grid row rather than crashing
    // or borrowing a race from nowhere.
    const pair = races.slice(i, i + 2);
    rows.push({ type: 'grid', races: pair });
    i += pair.length;
    gridRowsSinceHero += 1;
    if (gridRowsSinceHero >= GRID_ROWS_PER_HERO) expectHero = true;
  }
  return rows;
}

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
  const insets = useSafeAreaInsets();

  const [query, setQuery] = useState('');
  const [distances, setDistances] = useState<Set<DistanceTag>>(new Set());
  const [months, setMonths] = useState<Set<string>>(new Set());
  const [showPast, setShowPast] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [activeFacet, setActiveFacet] = useState<FilterFacet>(null);
  // Bottom edge of the facet chip row, relative to the header (its direct
  // parent) — measured via onLayout rather than measureInWindow, since the
  // header sits flush under the safe-area inset and this is the only offset
  // the popover needs to land just below the row. A reasonable default
  // covers the first paint, before layout has run once.
  const [chipsRowBottom, setChipsRowBottom] = useState(132);
  const [pulling, setPulling] = useState(false);
  const allRaces = useRaces();
  const { status, refresh } = useRacesStatus();
  const { region, method } = useRegion();
  const locationInUse = method === 'gps' || method === 'ip';

  // A month picked in one region rarely exists in another — drop the
  // selection on region change so a stray key can never survive into a
  // filter that silently prunes results with no visible way to clear it.
  useEffect(() => {
    setMonths(new Set());
  }, [region.id]);

  const races = useMemo(() => {
    const q = query.trim().toLowerCase();
    return allRaces.filter((r) => {
      if (!raceInRegion(r, region)) return false;
      if (!showPast) {
        const days = daysUntil(r.date);
        if (!(r.date === null || (days !== null && days >= 0))) return false;
      }
      const matchesQuery =
        !q || r.name.toLowerCase().includes(q) || r.city.toLowerCase().includes(q);
      const matchesDistance = distances.size === 0 || r.distanceTags.some((t) => distances.has(t));
      const matchesMonth = months.size === 0 || months.has(monthKey(r.date));
      return matchesQuery && matchesDistance && matchesMonth;
    });
  }, [query, distances, months, allRaces, region, showPast]);

  // Distinguish "region has no data at all" from "filters matched nothing".
  const regionHasData = useMemo(
    () => allRaces.some((r) => raceInRegion(r, region)),
    [allRaces, region],
  );

  // Search is otherwise silently region-scoped: a real race in another city
  // reads as "not found". When the current region+filters produced nothing
  // and the user actually typed a query, count matches outside the region so
  // the empty state can point them at the city picker instead of a dead end.
  const otherRegionsCount = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (races.length !== 0 || !q) return 0;
    return allRaces.filter((r) => {
      if (raceInRegion(r, region)) return false;
      if (!showPast) {
        const days = daysUntil(r.date);
        if (!(r.date === null || (days !== null && days >= 0))) return false;
      }
      const matchesQuery = r.name.toLowerCase().includes(q) || r.city.toLowerCase().includes(q);
      const matchesDistance = distances.size === 0 || r.distanceTags.some((t) => distances.has(t));
      const matchesMonth = months.size === 0 || months.has(monthKey(r.date));
      return matchesQuery && matchesDistance && matchesMonth;
    }).length;
  }, [races.length, query, distances, months, allRaces, region, showPast]);

  const layoutRows = useMemo(() => buildLayoutRows(races), [races]);

  const availableMonths = useMemo(
    () => getAvailableMonths(allRaces.filter((r) => raceInRegion(r, region)), locale),
    [allRaces, region, locale],
  );

  const toggleDistance = useCallback(
    (tag: DistanceTag) => setDistances((prev) => toggleInSet(prev, tag)),
    [],
  );
  const toggleMonth = useCallback(
    (key: string) => setMonths((prev) => toggleInSet(prev, key)),
    [],
  );
  // Fast-path for the month popover's preset row — replaces the whole
  // selection rather than toggling into it, so picking a preset after some
  // manual chips were already active gives a predictable result.
  const setMonthsExact = useCallback((keys: Set<string>) => setMonths(keys), []);
  const resetDistances = useCallback(() => setDistances(new Set()), []);
  const resetMonths = useCallback(() => setMonths(new Set()), []);
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

  // The provider auto-refreshes on mount, so `status` alone would flash the
  // pull-to-refresh spinner on every cold start. Only reflect it once the
  // user has actually pulled.
  const onRefresh = useCallback(() => {
    setPulling(true);
    refresh();
  }, [refresh]);
  useEffect(() => {
    if (status !== 'loading') setPulling(false);
  }, [status]);

  const facetChips: { key: NonNullable<FilterFacet>; label: string; count: number }[] = [
    { key: 'distance', label: t('filters.distance'), count: distances.size },
    { key: 'month', label: t('filters.date'), count: months.size },
  ];

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
              accessibilityRole="radio"
              accessibilityState={{ selected: locale === l }}
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
        <Pressable
          onPress={() => setShowPast((v) => !v)}
          accessibilityRole="button">
          {({ pressed }) => (
            <GlassSurface
              scheme={scheme}
              radius={GlassRadii.pill}
              style={pressed && styles.pressed}
              contentStyle={styles.filterContent}>
              <Text style={[styles.filterBtnText, { color: c.text }]}>
                {showPast ? t('feed.hidePast') : t('feed.showPast')}
              </Text>
            </GlassSurface>
          )}
        </Pressable>
      </View>

      {/* One small chip per filter facet (Strava reference: Sport · Dates ·
          Distance · … as separate pills in a scrolling row). Tapping a chip
          opens a compact popover for that facet only, instead of one sheet
          holding every facet at once — cheaper to change a single filter. */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.facetRow}
        contentContainerStyle={styles.facetRowContent}
        onLayout={(e) =>
          setChipsRowBottom(e.nativeEvent.layout.y + e.nativeEvent.layout.height)
        }>
        {facetChips.map((f) => {
          const open = activeFacet === f.key;
          const label =
            f.count > 0 ? `${f.label} (${f.count})` : f.label;
          return (
            <Pressable
              key={f.key}
              onPress={() => setActiveFacet(open ? null : f.key)}
              accessibilityRole="button"
              accessibilityState={{ expanded: open }}
              accessibilityLabel={label}>
              {({ pressed }) => (
                <GlassSurface
                  scheme={scheme}
                  radius={GlassRadii.pill}
                  style={[
                    pressed && styles.pressed,
                    open && { borderWidth: 1.5, borderColor: c.accent },
                  ]}
                  contentStyle={styles.filterContent}>
                  <Text style={[styles.filterBtnText, { color: c.text }]}>{f.label}</Text>
                  {f.count > 0 && (
                    <View style={[styles.badge, { backgroundColor: c.accent }]}>
                      <Text style={styles.badgeText}>{f.count}</Text>
                    </View>
                  )}
                  <Icon
                    ios="chevron.down"
                    android="expand_more"
                    size={10}
                    weight="bold"
                    color={c.textSecondary}
                  />
                </GlassSurface>
              )}
            </Pressable>
          );
        })}
      </ScrollView>

      {hasActiveFilters && (
        <View style={styles.filterRow}>
          {query.length > 0 && (
            <Pressable onPress={() => setQuery('')} accessibilityRole="button">
              <GlassSurface scheme={scheme} radius={GlassRadii.chip} noShadow contentStyle={styles.chipContent}>
                <Text style={[styles.chipText, { color: c.text }]}>{query}</Text>
                <Icon ios="xmark" android="close" size={11} weight="bold" color={c.text} />
              </GlassSurface>
            </Pressable>
          )}
          {Array.from(distances).map((tag) => (
            <Pressable key={tag} onPress={() => toggleDistance(tag)} accessibilityRole="button">
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
            const label = key === 'tbd' ? t('common.tbd') : m?.label;
            if (!label) return null;
            return (
              <Pressable key={key} onPress={() => toggleMonth(key)} accessibilityRole="button">
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
        data={layoutRows}
        keyExtractor={(row) => (row.type === 'hero' ? `hero-${row.race.id}` : `grid-${row.races[0].id}`)}
        contentContainerStyle={styles.list}
        keyboardShouldPersistTaps="handled"
        refreshControl={
          <RefreshControl refreshing={pulling && status === 'loading'} onRefresh={onRefresh} />
        }
        // Perf tuning (image-perf pass) — rows now carry a decoded bitmap
        // each, where before this was plain text, so the defaults (tuned for
        // cheap text rows) render/keep more than the screen ever needs.
        //
        // initialNumToRender: default is 10 rows. A hero row (image at 4:3
        // + ~100pt of text/tags) runs ~380-420pt tall; a grid row (image at
        // 3:2 + ~90pt of text) runs ~200-220pt. Even a large-viewport phone
        // rarely shows more than "1 hero + 2-3 grid rows" before the fold,
        // so 6 comfortably covers the visible viewport across device sizes
        // with a little scroll-ahead buffer, instead of decoding ~10 rows
        // (up to ~19 images) before first paint.
        initialNumToRender={6}
        // maxToRenderPerBatch: default is 10 rows added per batch during
        // scroll. Each row can now include up to 2 image decodes (a grid
        // row), so a smaller batch keeps each JS-thread render commit
        // shorter and more interruptible while scrolling fast.
        maxToRenderPerBatch={5}
        // windowSize: default is 21 "screens" (10 above + current + 10
        // below) of rows kept mounted outside the viewport. That's sized for
        // cheap rows; here every mounted-but-offscreen row is still holding
        // a decoded bitmap or two in memory. 7 (3 screens each direction)
        // keeps a reasonable fling buffer without holding dozens of
        // off-screen images resident.
        windowSize={7}
        // removeClippedSubviews: detaches offscreen rows from the native
        // view hierarchy (their JS state is preserved, so this is safe for
        // FlatList's own re-render/measurement bookkeeping) — meaningful
        // memory savings for a long, image-heavy list. Long-standing RN
        // guidance to pair this with heavier list rows.
        removeClippedSubviews
        // updateCellsBatchingPeriod: default 50ms between render batches.
        // Nudged up slightly so the JS thread gets a bit more breathing
        // room between batches now that each batch's rows include image
        // decodes, trading a marginally longer worst-case "blank cell" edge
        // during a fast fling for less thread contention overall.
        updateCellsBatchingPeriod={75}
        // getItemLayout intentionally omitted: rows alternate between two
        // different fixed aspect-ratio images (hero 4:3 vs grid 3:2), AND
        // the text content within a row varies in height — race name is
        // `numberOfLines={2}` (1 or 2 lines depending on how long the name
        // is) and the distance-tag row wraps (`flexWrap: 'wrap'`) to a
        // second line for races with 3+ tags. A static per-row height
        // formula can't account for that variance, and a wrong
        // getItemLayout is worse than none — it misreports scroll offsets
        // (visible on jumpy scrollbar drag / scrollToIndex) rather than
        // just losing the layout-skip optimization.
        renderItem={({ item, index }) => {
          const goToRace = (id: string) =>
            router.push({ pathname: '/race/[id]', params: { id } });
          return (
            // Staggered reveal, capped at the first 8 rows so rows mounted
            // while scrolling (or while typing in search) get a quick plain
            // fade instead of an ever-growing delay queue.
            <Animated.View entering={FadeInDown.duration(320).delay(Math.min(index, 8) * 45)}>
              {item.type === 'hero' ? (
                <RaceCard
                  race={item.race}
                  variant="hero"
                  imageSource={pickRegionArt(region.id, item.race.id, 'hero')}
                  onPress={() => goToRace(item.race.id)}
                />
              ) : (
                <View style={styles.gridRow}>
                  {item.races.map((race) => (
                    <View key={race.id} style={styles.gridItem}>
                      <RaceCard
                        race={race}
                        variant="compact"
                        imageSource={pickRegionArt(region.id, race.id, 'compact')}
                        onPress={() => goToRace(race.id)}
                      />
                    </View>
                  ))}
                  {/* Trailing odd race: keep the single card at half width
                      rather than stretching it full-bleed, so the grid's
                      left-column alignment stays consistent to the last row. */}
                  {item.races.length === 1 && <View style={styles.gridItem} />}
                </View>
              )}
            </Animated.View>
          );
        }}
        ListEmptyComponent={
          <View>
            <Text style={[styles.empty, { color: c.textSecondary }]}>
              {regionHasData ? t('feed.empty') : t('city.emptyRegion', { city: region.name })}
            </Text>
            {otherRegionsCount > 0 && (
              <Pressable
                onPress={() => setPickerOpen(true)}
                accessibilityRole="button"
                hitSlop={6}>
                <Text style={[styles.otherCitiesText, { color: c.accent }]}>
                  {t('feed.otherCities', { count: otherRegionsCount })}
                </Text>
              </Pressable>
            )}
          </View>
        }
      />

      <CityPicker visible={pickerOpen} onClose={() => setPickerOpen(false)} />
      <FilterPopover
        facet={activeFacet}
        onClose={() => setActiveFacet(null)}
        top={insets.top + chipsRowBottom + Spacing.one}
        distances={distances}
        onToggleDistance={toggleDistance}
        onResetDistances={resetDistances}
        months={months}
        onToggleMonth={toggleMonth}
        onSetMonths={setMonthsExact}
        onResetMonths={resetMonths}
        availableMonths={availableMonths}
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
    // 16px is the iOS Safari threshold — anything smaller triggers an
    // auto-zoom on focus that leaves the whole page zoomed in until the
    // user manually pinches back out.
    fontSize: 16,
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
  facetRow: { marginTop: Spacing.two },
  facetRowContent: {
    flexDirection: 'row',
    gap: Spacing.two,
    paddingHorizontal: Spacing.three,
  },
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
  gridRow: { flexDirection: 'row', gap: Spacing.two },
  gridItem: { flex: 1 },
  empty: { textAlign: 'center', marginTop: Spacing.six, fontSize: 15 },
  otherCitiesText: {
    textAlign: 'center',
    marginTop: Spacing.two,
    fontSize: 13,
    fontWeight: '600',
  },
});

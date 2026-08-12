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
  useWindowDimensions,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
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
  DISTANCE_TAGS,
  daysUntil,
  distanceTagIcon,
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

// The facet/filter chips render well under Apple HIG's 44x44pt default
// control size (~24-33pt tall) — hitSlop brings the tappable area close to
// 44pt without inflating the compact visual chrome (same idiom used in
// glass-button.tsx).
const CHIP_HIT_SLOP = { top: 8, bottom: 8, left: 4, right: 4 };

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

// Idle-state (no search/filter) body: a "this week" hero carousel followed by
// horizontal shelves grouped by distance — the shape a Strava-style races
// directory uses, so browsing without a specific ask in mind reads as
// "explore what's around" instead of one long undifferentiated list. Any
// active search query or distance/month filter means the user already told
// us what they want, so that case keeps the existing hero/grid FlatList
// (`buildLayoutRows` above) as the "filtered results" view instead — a shelf
// UI would fight, not serve, an explicit filter.
const THIS_WEEK_MAX_DAYS = 6; // today (0) through 6 days out, not calendar-week-aligned
// Carousel card width as a fraction of the content width (screen width minus
// the shared horizontal padding — see `contentWidth` below), shared by every
// horizontal-scroll section on this screen: the "this week" hero carousel
// and each distance shelf. Sized so one card fills nearly the whole
// scroller and the next card peeks in at the trailing edge as a scroll
// affordance — a full-width card would leave zero peek and read as a static
// page rather than a scrollable carousel; a half-width card (the old 2-up
// shelf) undersells each card and buries the peek's purpose.
const CAROUSEL_CARD_WIDTH_RATIO = 0.84;
const CAROUSEL_GAP = Spacing.two;
// Every horizontal carousel steps one card at a time on release, rather than
// free-scrolling to wherever momentum happens to land — snapToInterval
// aligned to a full card-width-plus-gap, with disableIntervalMomentum so a
// fast flick can't skip past several cards in one gesture.
const CAROUSEL_SNAP_PROPS = {
  decelerationRate: 'fast' as const,
  disableIntervalMomentum: true,
};
// Section-title icon size, derived from the shelf header's own text size
// (`styles.shelfHeaderText.fontSize`) rather than a disconnected literal —
// keeps the glyph visually tied to the title it sits next to instead of
// looking like an arbitrary fixed size.
const SHELF_HEADER_FONT_SIZE = 18; // keep in sync with styles.shelfHeaderText
const SHELF_ICON_SIZE = Math.round(SHELF_HEADER_FONT_SIZE * 0.85);

export default function FeedScreen() {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const c = Colors[scheme];
  const router = useRouter();
  const { t, locale } = useI18n();
  const insets = useSafeAreaInsets();

  const [query, setQuery] = useState('');
  const [distances, setDistances] = useState<Set<DistanceTag>>(new Set());
  const [months, setMonths] = useState<Set<string>>(new Set());
  const [pickerOpen, setPickerOpen] = useState(false);
  const [activeFacet, setActiveFacet] = useState<FilterFacet>(null);
  // Bottom edge of the facet chip row, relative to the header (its direct
  // parent) — measured via onLayout rather than measureInWindow, since the
  // header sits flush under the safe-area inset and this is the only offset
  // the popover needs to land just below the row. A reasonable default
  // covers the first paint, before layout has run once.
  const [chipsRowBottom, setChipsRowBottom] = useState(132);
  const [pulling, setPulling] = useState(false);
  const [heroIndex, setHeroIndex] = useState(0);
  const allRaces = useRaces();
  const { status, refresh } = useRacesStatus();
  const { region, method } = useRegion();
  const locationInUse = method === 'gps' || method === 'ip';
  const { width } = useWindowDimensions();

  // A month picked in one region rarely exists in another — drop the
  // selection on region change so a stray key can never survive into a
  // filter that silently prunes results with no visible way to clear it.
  // Also reset the hero carousel back to its first page — a stale page index
  // from the previous region's race count otherwise leaves the dots looking
  // wrong (or renders a page past the end of the new, shorter array).
  useEffect(() => {
    setMonths(new Set());
    setHeroIndex(0);
  }, [region.id]);

  // Home is for discovering what's coming up — past races only matter once
  // you've saved one, which is what My Races' own "Anteriores" section is
  // for. No toggle here, and no way to see a past race from this screen.
  const races = useMemo(() => {
    const q = query.trim().toLowerCase();
    return allRaces.filter((r) => {
      if (!raceInRegion(r, region)) return false;
      const days = daysUntil(r.date);
      if (!(r.date === null || (days !== null && days >= 0))) return false;
      const matchesQuery =
        !q || r.name.toLowerCase().includes(q) || r.city.toLowerCase().includes(q);
      const matchesDistance = distances.size === 0 || r.distanceTags.some((t) => distances.has(t));
      const matchesMonth = months.size === 0 || months.has(monthKey(r.date));
      return matchesQuery && matchesDistance && matchesMonth;
    });
  }, [query, distances, months, allRaces, region]);

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
      const days = daysUntil(r.date);
      if (!(r.date === null || (days !== null && days >= 0))) return false;
      const matchesQuery = r.name.toLowerCase().includes(q) || r.city.toLowerCase().includes(q);
      const matchesDistance = distances.size === 0 || r.distanceTags.some((t) => distances.has(t));
      const matchesMonth = months.size === 0 || months.has(monthKey(r.date));
      return matchesQuery && matchesDistance && matchesMonth;
    }).length;
  }, [races.length, query, distances, months, allRaces, region]);

  const layoutRows = useMemo(() => buildLayoutRows(races), [races]);

  // Idle-state (no active filters) data. `races` above is already: region-
  // scoped, upcoming-only (past races excluded by the same rule as the
  // filtered view, reused rather than reimplemented), AND already sorted
  // ascending by date — `allRaces` (useRaces()) is sorted at the source and
  // `.filter()` preserves relative order, so no re-sort is needed here.
  const thisWeekRaces = useMemo(
    () =>
      races.filter((r) => {
        const days = daysUntil(r.date);
        return days !== null && days >= 0 && days <= THIS_WEEK_MAX_DAYS;
      }),
    [races],
  );
  // Carousel when 2+ races fall in the next 7 days; a single upcoming race
  // (this week or not) renders alone with no carousel chrome; zero races in
  // the region is handled by the shared empty state below, never reached here.
  const heroIsThisWeek = thisWeekRaces.length > 0;
  const heroRaces = heroIsThisWeek ? thisWeekRaces : races.slice(0, 1);

  // One shelf per distance tag that has a match in-region — a race tagged
  // both 3K and 5K intentionally appears in both shelves (no dedup: each
  // shelf is "what qualifies", not a partition of the race list). Empty
  // shelves are dropped by the `.filter` below. TBD is included like every
  // other tag when it has matches, for the same reason 3K gets its own
  // "Caminatas" framing below — consistency between a shelf and its chip,
  // not a special case.
  const shelves = useMemo(
    () =>
      DISTANCE_TAGS.map((tag) => ({
        tag,
        races: races.filter((r) => r.distanceTags.includes(tag)),
      })).filter((shelf) => shelf.races.length > 0),
    [races],
  );

  // contentWidth matches the body's own horizontal padding (see
  // `styles.list`) — every horizontal carousel's card width is a fraction of
  // this, not of the raw screen width, so the peek lines up with that same
  // padding. See `CAROUSEL_CARD_WIDTH_RATIO` above for why.
  const contentWidth = width - Spacing.three * 2;
  const carouselCardWidth = Math.round(contentWidth * CAROUSEL_CARD_WIDTH_RATIO);
  const carouselStep = carouselCardWidth + CAROUSEL_GAP;

  const availableMonths = useMemo(
    () => getAvailableMonths(allRaces.filter((r) => raceInRegion(r, region)), locale),
    [allRaces, region, locale],
  );

  // Shared by the filtered hero/grid FlatList and the idle-state hero
  // carousel + shelves — both navigate to the same detail route.
  const goToRace = useCallback(
    (id: string) => router.push({ pathname: '/race/[id]', params: { id } }),
    [router],
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

  // Shared between the filtered FlatList's ListEmptyComponent and the
  // "region has zero races at all" case of the idle shelf-browsing view —
  // one empty-state implementation, not two.
  const emptyStateContent = (
    <View>
      <Text style={[styles.empty, { color: c.textSecondary }]}>
        {regionHasData ? t('feed.empty') : t('city.emptyRegion', { city: region.name })}
      </Text>
      {otherRegionsCount > 0 && (
        <Pressable onPress={() => setPickerOpen(true)} accessibilityRole="button" hitSlop={14}>
          <Text style={[styles.otherCitiesText, { color: c.accent }]}>
            {t('feed.otherCities', { count: otherRegionsCount })}
          </Text>
        </Pressable>
      )}
    </View>
  );

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
            accessibilityRole="button"
            hitSlop={12}
            style={styles.subtitleRow}
            accessibilityLabel={
              locationInUse ? `${region.name} — ${t('city.locationOn')}` : region.name
            }>
            {locationInUse && <Icon ios="location.fill" android="my_location" size={12} color={c.accent} />}
            <Text style={[styles.subtitle, { color: c.textSecondary }]}>{region.name}</Text>
            <Icon ios="chevron.down" android="expand_more" size={12} weight="bold" color={c.textSecondary} />
          </Pressable>
        </View>
      </View>

      <View style={styles.searchRow}>
        <GlassSurface scheme={scheme} radius={GlassRadii.pill} style={styles.searchGlass} contentStyle={styles.searchContent}>
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder={t('feed.search')}
            placeholderTextColor={c.textSecondary}
            // Placeholder alone disappears once text is entered — an
            // explicit label keeps VoiceOver's description of the field's
            // purpose stable regardless of its current value.
            accessibilityLabel={t('feed.search')}
            style={[styles.search, { color: c.text }]}
          />
        </GlassSurface>
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
              accessibilityLabel={label}
              hitSlop={CHIP_HIT_SLOP}>
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
                      {/* Capped: fixed circular badge (minWidth 18) — an
                          uncapped count at max Dynamic Type would blow past
                          the circle rather than reflow. */}
                      <Text style={styles.badgeText} maxFontSizeMultiplier={1.3}>
                        {f.count}
                      </Text>
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
            <Pressable onPress={() => setQuery('')} accessibilityRole="button" hitSlop={CHIP_HIT_SLOP}>
              <GlassSurface scheme={scheme} radius={GlassRadii.chip} noShadow contentStyle={styles.chipContent}>
                <Text style={[styles.chipText, { color: c.text }]}>{query}</Text>
                <Icon ios="xmark" android="close" size={11} weight="bold" color={c.text} />
              </GlassSurface>
            </Pressable>
          )}
          {Array.from(distances).map((tag) => (
            <Pressable key={tag} onPress={() => toggleDistance(tag)} accessibilityRole="button" hitSlop={CHIP_HIT_SLOP}>
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
              <Pressable key={key} onPress={() => toggleMonth(key)} accessibilityRole="button" hitSlop={CHIP_HIT_SLOP}>
                <GlassSurface scheme={scheme} radius={GlassRadii.chip} noShadow contentStyle={styles.chipContent}>
                  <Text style={[styles.chipText, { color: c.text }]}>{label}</Text>
                  <Icon ios="xmark" android="close" size={11} weight="bold" color={c.text} />
                </GlassSurface>
              </Pressable>
            );
          })}
          <Pressable onPress={clearAll} accessibilityRole="button" hitSlop={14}>
            <Text style={[styles.clearAllText, { color: c.accent }]}>{t('filters.clearAll')}</Text>
          </Pressable>
        </View>
      )}
      </View>

      {races.length === 0 ? (
        // Total emptiness (no races at all in the region, or filters pruned
        // everything) — same content either way `regionHasData` decides the
        // message, `otherRegionsCount` decides whether the city-picker link
        // shows. Still scrollable/pullable so refresh works from an empty
        // screen.
        <ScrollView
          contentContainerStyle={styles.list}
          keyboardShouldPersistTaps="handled"
          refreshControl={
            <RefreshControl refreshing={pulling && status === 'loading'} onRefresh={onRefresh} />
          }>
          {emptyStateContent}
        </ScrollView>
      ) : hasActiveFilters ? (
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
        ListEmptyComponent={emptyStateContent}
      />
      ) : (
        // Idle state (no search/filter active): "this week"/"next race" hero
        // + one horizontal shelf per distance tag with a match, instead of
        // the flat hero/grid list above — see the module comment near
        // `THIS_WEEK_MAX_DAYS` for the reasoning.
        <ScrollView
          contentContainerStyle={styles.list}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          refreshControl={
            <RefreshControl refreshing={pulling && status === 'loading'} onRefresh={onRefresh} />
          }>
          <Animated.View entering={FadeInDown.duration(320)}>
            <Text style={[styles.sectionTitle, { color: c.text }]}>
              {heroIsThisWeek ? t('feed.thisWeek') : t('feed.nextRace')}
            </Text>
            {heroRaces.length > 1 ? (
              <>
                <FlatList
                  data={heroRaces}
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  snapToInterval={carouselStep}
                  {...CAROUSEL_SNAP_PROPS}
                  keyExtractor={(r) => r.id}
                  contentContainerStyle={styles.shelfContent}
                  onMomentumScrollEnd={(e: NativeSyntheticEvent<NativeScrollEvent>) => {
                    const idx = Math.round(e.nativeEvent.contentOffset.x / carouselStep);
                    setHeroIndex(Math.max(0, Math.min(idx, heroRaces.length - 1)));
                  }}
                  renderItem={({ item }) => (
                    <View style={{ width: carouselCardWidth }}>
                      <RaceCard
                        race={item}
                        variant="hero"
                        imageSource={pickRegionArt(region.id, item.id, 'hero')}
                        onPress={() => goToRace(item.id)}
                      />
                    </View>
                  )}
                />
                <View style={styles.dotsRow}>
                  {heroRaces.map((r, i) => (
                    <View
                      key={r.id}
                      style={[
                        styles.dot,
                        { backgroundColor: i === heroIndex ? c.accent : c.backgroundSelected },
                      ]}
                    />
                  ))}
                </View>
              </>
            ) : (
              <RaceCard
                race={heroRaces[0]}
                variant="hero"
                imageSource={pickRegionArt(region.id, heroRaces[0].id, 'hero')}
                onPress={() => goToRace(heroRaces[0].id)}
              />
            )}
          </Animated.View>

          {shelves.map((shelf, index) => {
            const icon = distanceTagIcon(shelf.tag);
            // 3K is explicitly framed as the walk category, not just "3K" —
            // every other shelf reuses the tag's own chip label so a shelf
            // and its cards' chips always agree.
            const label =
              shelf.tag === '3K' ? t('feed.walksShelf') : t(distanceTagLabelKey(shelf.tag));
            return (
              <Animated.View
                key={shelf.tag}
                entering={FadeInDown.duration(320).delay(Math.min(index + 1, 8) * 45)}>
                <View style={styles.shelfHeaderRow}>
                  {icon && (
                    <Icon ios={icon.ios} android={icon.android} size={SHELF_ICON_SIZE} color={c.text} />
                  )}
                  <Text style={[styles.shelfHeaderText, { color: c.text }]}>{label}</Text>
                </View>
                <FlatList
                  data={shelf.races}
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  snapToInterval={carouselStep}
                  {...CAROUSEL_SNAP_PROPS}
                  keyExtractor={(r) => r.id}
                  contentContainerStyle={styles.shelfContent}
                  renderItem={({ item }) => (
                    <View style={{ width: carouselCardWidth }}>
                      <RaceCard
                        race={item}
                        variant="compact"
                        imageSource={pickRegionArt(region.id, item.id, 'compact')}
                        onPress={() => goToRace(item.id)}
                      />
                    </View>
                  )}
                />
              </Animated.View>
            );
          })}
        </ScrollView>
      )}

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
  // Idle-state (shelf-browsing) body.
  sectionTitle: { fontSize: 20, fontWeight: '700', marginBottom: Spacing.two },
  shelfHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one,
    marginBottom: Spacing.two,
  },
  shelfHeaderText: { fontSize: 18, fontWeight: '700' },
  // paddingRight gives the last (partially cut-off) card some breathing room
  // past the screen edge instead of ending flush against it.
  shelfContent: { gap: Spacing.two, paddingRight: Spacing.three },
  dotsRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: Spacing.one,
    marginTop: Spacing.two,
  },
  dot: { width: 6, height: 6, borderRadius: 3 },
});
